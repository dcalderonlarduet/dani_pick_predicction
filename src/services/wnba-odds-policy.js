import { attachLineTrapFlags } from "./line-trap-flags.js";
import { calibrateForDisplay, calibrateForScoring } from "./pick-calibration.js";
import { buildCoherenceCtx, resolvePickCoherence } from "./pick-coherence.js";
import { lineMovementSideForPick, pickProMarketQuote } from "./pro-market-quotes.js";
import {
  calcularScore,
  computeDataQuality,
  evFromProbability,
  evaluateValueGates,
  impliedProbabilityFromDecimal,
  isDropAlignedWithPick,
  logValueGateFailure,
  marketAnchorBlend,
  resolvePickColor,
} from "./pro-odds-scoring.js";
import {
  projectWnbaGameTotal,
  projectWnbaMoneyline,
  projectWnbaTeamTotal,
  simulateWnbaTeamOver,
  simulateWnbaTotalOver,
  SPORT,
} from "./wnba-projection.js";
import { persistPolicyPicks } from "./backtesting.js";
import {
  WNBA_THRESHOLDS,
  applyDataQualityPenalties,
  resolveColorWithSportThresholds,
} from "./sport-bettable-thresholds.js";

const MARKET_ORDER = ["game_total", "moneyline", "team_total_home", "team_total_away"];

const ODDS_RANGE = WNBA_THRESHOLDS.oddsRange;

// [WNBA-OVERRIDE] Line movement desactivado â€” mercado demasiado pequeÃ±o
function neutralLineMovement() {
  return {
    tipo: "NEUTRO",
    score_bonus: 0,
    score_penalizacion_si_vas_publico: 0,
    lado_sharp: null,
    confianza: 0,
    delta_linea: 0,
    gap_tickets_handle: 0,
  };
}

// [WNBA-OVERRIDE] dataQuality unificada con pro-odds-scoring; techo 0.85
function computeWnbaDataQuality(flags = {}, meta = {}) {
  return Math.min(0.85, computeDataQuality(flags, meta));
}

function wnbaDataQualityMeta(ctx = {}) {
  return {
    oddsAvailable: Boolean(ctx.oddsAvailable),
    sampleGames: Math.min(ctx.home?.form?.sample ?? 0, ctx.away?.form?.sample ?? 0) || null,
    freshnessOk: Boolean(ctx.flags?.freshness_ok),
  };
}

function mergeOverrides(ctx, projection, pickOverrides = []) {
  const base = ctx?.wnba_overrides_applied || [];
  const fromProjection = projection?.wnba_overrides_applied || [];
  return [...new Set([...base, ...fromProjection, ...pickOverrides])];
}

function normalizeWinProb(value) {
  const prob = Number(value);
  if (!Number.isFinite(prob)) return null;
  if (prob > 1) return prob / 100;
  return prob >= 0 && prob <= 1 ? prob : null;
}

function espnWinProbForSide(ctx, side) {
  if (side === "home") return normalizeWinProb(ctx?.espnWinProb?.home ?? ctx?.espnWinProbHome);
  if (side === "away") return normalizeWinProb(ctx?.espnWinProb?.away ?? ctx?.espnWinProbAway);
  return null;
}

function applyEspnMoneylineAnchor(ml, ctx) {
  let probHome = Number(ml?.probHome);
  let probAway = Number(ml?.probAway);
  if (!Number.isFinite(probHome) || !Number.isFinite(probAway)) return { ...ml, espnWinProbAnchorApplied: false };

  const espnHome = espnWinProbForSide(ctx, "home");
  const espnAway = espnWinProbForSide(ctx, "away");
  let applied = false;

  if (espnHome != null && Math.abs(probHome - espnHome) > 0.12) {
    probHome = probHome * 0.55 + espnHome * 0.45;
    applied = true;
  }
  if (espnAway != null && Math.abs(probAway - espnAway) > 0.12) {
    probAway = probAway * 0.55 + espnAway * 0.45;
    applied = true;
  } else if (applied && espnAway == null) {
    probAway = 1 - probHome;
  }

  const total = probHome + probAway;
  if (total > 0) {
    probHome /= total;
    probAway /= total;
  }
  if (applied && ctx && typeof ctx === "object") {
    ctx.flags = { ...(ctx.flags || {}), espn_win_prob_anchor_applied: true };
  }

  return {
    ...ml,
    probHome,
    probAway,
    espnWinProbAnchorApplied: applied,
  };
}

function deduplicateTeamTotalPicks(picks) {
  const seenTeamTotals = new Set();
  const sorted = [...picks].sort(
    (a, b) => (b.score_final || b.score || 0) - (a.score_final || a.score || 0)
  );
  const result = [];

  for (const pick of sorted) {
    if (pick?.market === "team_total_home" || pick?.market === "team_total_away") {
      if (seenTeamTotals.has(pick.market)) continue;
      seenTeamTotals.add(pick.market);
    }
    result.push(pick);
  }

  return result;
}

/** WNBA: no penalizar confianza por anchor modelo-mercado (stats ESPN incompletas). */
function finalizeWnbaConfidence(baseConf, { colorScore = 0, ev = 0 } = {}) {
  let conf = Number(baseConf) || 0;
  if (colorScore >= WNBA_THRESHOLDS.color.verde.score && ev >= WNBA_THRESHOLDS.color.verde.ev) {
    conf = Math.max(conf, WNBA_THRESHOLDS.gates.minRecommendationConfidence + 3);
  }
  return Math.max(0, Math.min(100, Math.round(conf)));
}

function resolveWnbaBookmaker(odds, bookmaker = null) {
  const explicit = String(bookmaker || "").trim();
  if (explicit) return explicit;
  return Number(odds) > 1 ? "mercado" : null;
}

function resolveWnbaSelection({ marketKey, side, line, ctx }) {
  if (marketKey === "moneyline") {
    const team = side === "home" ? ctx?.homeName : ctx?.awayName;
    return `(ML) ${team || (side === "home" ? "Local" : "Visitante")} a ganar`;
  }
  const sideLabel = side === "over" ? "Mas de" : "Menos de";
  return `${side === "over" ? "(+)" : "(-)"} ${sideLabel} ${line} puntos`;
}

function resolveWnbaColorAndGates({
  scoreResult,
  ev_model,
  edge,
  cuota_en_rango,
  dataQuality,
  lm,
  pickSideLm,
  signals,
  requireEdge,
  probModel = null,
  probMarket = null,
  flags = null,
  confidence = null,
}) {
  const sportColor = resolveColorWithSportThresholds(WNBA_THRESHOLDS, {
    ev: ev_model,
    score: scoreResult.score,
    signals,
    lm,
    pickSideLm,
    flags,
  });

  const color = resolvePickColor({
    score: scoreResult.score,
    ev: ev_model,
    edge,
    cuota_en_rango,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
    evVerde: sportColor.evVerde,
    evAmarillo: sportColor.evAmarillo,
    edgeVerde: sportColor.edgeVerde,
    edgeAmarillo: sportColor.edgeAmarillo,
    requireEdge,
  });

  const valueGates = evaluateValueGates({
    ev: ev_model,
    edge,
    dataQuality,
    cuota_en_rango,
    lm,
    pickSide: pickSideLm,
    probModel,
    probMarket,
    requireEdge,
    flags,
    confidence,
    ...sportColor.gateParams,
  });

  return { color, valueGates };
}

function buildTotalsPick({
  marketKey,
  side,
  line,
  odds,
  prob,
  ctx,
  signals,
  lm,
  pickSideLm,
  wnba_overrides_applied = [],
  umbralVerde = WNBA_THRESHOLDS.color.verde.score,
  umbralAmarillo = WNBA_THRESHOLDS.color.amarillo.score,
}) {
  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  if (ev_model == null) return null;

  const dataQuality = applyDataQualityPenalties(
    computeWnbaDataQuality(ctx.flags || {}, wnbaDataQualityMeta(ctx)),
    WNBA_THRESHOLDS.dataQualityPenalties || {},
    ctx.flags || {},
    "wnba"
  );
  const cuota_en_rango = odds >= ODDS_RANGE[marketKey].min && odds <= ODDS_RANGE[marketKey].max;
  const probMarket = impliedProbabilityFromDecimal(odds);
  const edge = prob - probMarket;
  const droppingAligned = isDropAlignedWithPick(signals, pickSideLm);
  const scoringSignals = { ...signals, dropping: droppingAligned };
  const scoreResult = calcularScore({
    ev_modelo: ev_model,
    ev_externo_coincide: Boolean(signals?.valueBet),
    dropping_alineado: droppingAligned,
    gap_books: signals?.gapBooks || 0,
    cuota_en_rango,
    dataQuality,
    n_senales: signals?.n_senales || 0,
    lm,
    pick_side: pickSideLm,
    confianza: 55,
  });

  if (scoreResult.discarded) return scoreResult.discarded;

  const anchor = marketAnchorBlend(prob, probMarket ?? signals?.probMarket);
  const finalConfidence = finalizeWnbaConfidence(scoreResult.confianza, {
    colorScore: scoreResult.score,
    ev: ev_model,
  });

  const { color, valueGates } = resolveWnbaColorAndGates({
    scoreResult,
    ev_model,
    edge,
    cuota_en_rango,
    dataQuality,
    lm,
    pickSideLm,
    signals: scoringSignals,
    requireEdge: true,
    probModel: anchor.prob,
    probMarket: probMarket ?? signals?.probMarket,
    flags: ctx.flags || {},
    confidence: finalConfidence,
  });

  logValueGateFailure("WNBA", {
    game: ctx,
    marketKey,
    scoreResult,
    ev: ev_model,
    evRaw: ev_raw,
    dataQuality,
    cuota_en_rango,
    edge,
    valueGates,
  });

  return attachLineTrapFlags(
    {
      market: marketKey,
      side,
      selection: resolveWnbaSelection({ marketKey, side, line, ctx }),
      line,
      odds,
      bookmaker: resolveWnbaBookmaker(odds),
      color,
      bettable: (color === "verde" || color === "amarillo") && valueGates.passed,
      value_gates: valueGates,
      data_quality: dataQuality,
      confidence: finalConfidence,
      score: scoreResult.score,
      ev: ev_display ?? ev_model,
      ev_model,
      ev_display,
      ev_raw,
      edge,
      ev_external: signals?.evExternal ?? null,
      drop12h: signals?.drop12h ?? null,
      droppingOddsSignal: droppingAligned ? "confirmed" : signals?.dropping ? "faded" : null,
      prob_model: anchor.prob,
      prob_market: probMarket,
      source_log: ctx.source_log,
      factors_used: signals?.factors_used || [],
      market_anchor_applied: anchor.applied,
      confianza_final: finalConfidence,
      score_final: scoreResult.score,
      wnba_overrides_applied,
    },
    lm,
    pickSideLm
  );
}

function buildMoneylinePick({ side, odds, prob, ctx, signals, lm, marketProb, wnba_overrides_applied }) {
  const parsedOdds = Number(odds);
  const impliedProb = Number(marketProb);
  if (!Number.isFinite(parsedOdds) || parsedOdds <= 1 || !Number.isFinite(impliedProb)) {
    return null;
  }
  const edge = prob - impliedProb;
  if (Math.abs(edge) < WNBA_THRESHOLDS.color.amarillo.edge) return null;

  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  const dataQuality = applyDataQualityPenalties(
    computeWnbaDataQuality(ctx.flags || {}, wnbaDataQualityMeta(ctx)),
    WNBA_THRESHOLDS.dataQualityPenalties || {},
    ctx.flags || {},
    "wnba"
  );
  const cuota_en_rango = odds >= ODDS_RANGE.moneyline.min && odds <= ODDS_RANGE.moneyline.max;
  const droppingAligned = isDropAlignedWithPick(signals, side);
  const scoringSignals = { ...signals, dropping: droppingAligned };
  const scoreResult = calcularScore({
    ev_modelo: ev_model,
    ev_externo_coincide: Boolean(signals?.valueBet),
    dropping_alineado: droppingAligned,
    gap_books: signals?.gapBooks || 0,
    cuota_en_rango,
    dataQuality,
    n_senales: signals?.n_senales || 0,
    lm,
    pick_side: side,
    confianza: 55,
  });
  if (scoreResult.discarded) return scoreResult.discarded;
  const finalConfidence = finalizeWnbaConfidence(scoreResult.confianza, {
    colorScore: scoreResult.score,
    ev: ev_model,
  });

  const { color, valueGates } = resolveWnbaColorAndGates({
    scoreResult,
    ev_model,
    edge,
    cuota_en_rango,
    dataQuality,
    lm,
    pickSideLm: side,
    signals: scoringSignals,
    requireEdge: true,
    probModel: prob,
    probMarket: impliedProb,
    flags: ctx.flags || {},
    confidence: finalConfidence,
  });

  logValueGateFailure("WNBA", {
    game: ctx,
    marketKey: "moneyline",
    scoreResult,
    ev: ev_model,
    evRaw: ev_raw,
    dataQuality,
    cuota_en_rango,
    edge,
    valueGates,
  });

  return attachLineTrapFlags(
    {
      market: "moneyline",
      side,
      selection: resolveWnbaSelection({ marketKey: "moneyline", side, ctx }),
      odds,
      bookmaker: resolveWnbaBookmaker(odds),
      color,
      bettable: (color === "verde" || color === "amarillo") && valueGates.passed,
      value_gates: valueGates,
      data_quality: dataQuality,
      confidence: finalConfidence,
      score: scoreResult.score,
      ev: ev_display ?? ev_model,
      ev_model,
      ev_display,
      ev_raw,
      edge,
      drop12h: signals?.drop12h ?? null,
      droppingOddsSignal: droppingAligned ? "confirmed" : signals?.dropping ? "faded" : null,
      prob_model: prob,
      prob_market: impliedProb,
      source_log: ctx.source_log,
      factors_used: signals?.factors_used || [],
      espn_win_prob_anchor_applied: Boolean(signals?.espnWinProbAnchorApplied),
      confianza_final: finalConfidence,
      score_final: scoreResult.score,
      wnba_overrides_applied,
    },
    lm,
    side
  );
}

export async function evaluateWnbaGamePicks(game) {
  const ctx = game.context;
  const bookmakers = game.odds?.bookmakers || {};
  const picks = [];
  const signals = game.marketSignals || {};
  const lm = neutralLineMovement();

  const fhQuote = pickProMarketQuote(bookmakers, "first_half_total");
  if (Number(fhQuote.line) || Number(game.odds?.firstHalfLine)) {
    console.warn("[WNBA] first_half_total no soportado, omitiendo");
  }

  for (const marketKey of MARKET_ORDER) {
    const quote = pickProMarketQuote(bookmakers, marketKey);

    if (marketKey === "game_total") {
      const base = projectWnbaGameTotal(ctx);
      const line = Number(quote.line) || Math.round(base.meanTotal * 2) / 2;
      const sim = simulateWnbaTotalOver(ctx, line);
      const probOver = sim.probOver ?? (base.meanTotal > line ? 0.52 : 0.48);
      const side = probOver >= 0.5 ? "over" : "under";
      const odds = side === "over" ? quote.over : quote.under;
      if (!odds) continue;
      const pick = buildTotalsPick({
        marketKey,
        side,
        line,
        odds,
        prob: side === "over" ? probOver : 1 - probOver,
        ctx,
        signals: { ...signals, factors_used: base.factors_used, gapBooks: quote.gap, n_senales: 2 },
        lm,
        pickSideLm: lineMovementSideForPick(marketKey, side),
        wnba_overrides_applied: mergeOverrides(ctx, base, ["line_movement_disabled", "game_total_priority"]),
      });
      if (pick?.pick !== null && pick) picks.push(pick);
      continue;
    }

    if (marketKey === "moneyline") {
      const ml = applyEspnMoneylineAnchor(projectWnbaMoneyline(ctx), ctx);
      const homeOdds = Number(quote.home);
      const awayOdds = Number(quote.away);
      if (!Number.isFinite(homeOdds) || homeOdds <= 1 || !Number.isFinite(awayOdds) || awayOdds <= 1) {
        continue;
      }
      const marketProbHome = impliedProbabilityFromDecimal(homeOdds);
      if (marketProbHome == null) continue;
      const side = ml.probHome >= 0.5 ? "home" : "away";
      const prob = side === "home" ? ml.probHome : ml.probAway;
      const odds = side === "home" ? homeOdds : awayOdds;
      const marketProbAway = impliedProbabilityFromDecimal(awayOdds);
      const pick = buildMoneylinePick({
        side,
        odds,
        prob,
        ctx,
        signals: {
          ...signals,
          factors_used: ml.factors_used,
          espnWinProbAnchorApplied: ml.espnWinProbAnchorApplied,
        },
        lm,
        marketProb: side === "home" ? marketProbHome : marketProbAway,
        wnba_overrides_applied: mergeOverrides(ctx, ml, [
          "line_movement_disabled",
          "ml_edge_guard",
          ...(ml.espnWinProbAnchorApplied ? ["espn_win_prob_anchor"] : []),
        ]),
      });
      if (pick) picks.push(pick);
      continue;
    }

    if (marketKey === "team_total_home" || marketKey === "team_total_away") {
      const sideKey = marketKey === "team_total_home" ? "home" : "away";
      const line = Number(quote.line);
      const hasOver = Number(quote.over) > 1;
      const hasUnder = Number(quote.under) > 1;
      if (!line || (!hasOver && !hasUnder)) {
        continue;
      }

      const projection = projectWnbaTeamTotal(ctx, sideKey);
      const sim = simulateWnbaTeamOver(ctx, sideKey, line);
      const probOver = sim.probOver ?? (projection.pts > line ? 0.52 : 0.48);
      const side = probOver >= 0.5 ? "over" : "under";
      const odds = side === "over" ? quote.over : quote.under;
      if (!odds) continue;

      const pick = buildTotalsPick({
        marketKey,
        side,
        line,
        odds,
        prob: side === "over" ? probOver : 1 - probOver,
        ctx,
        signals: { ...signals, factors_used: projection.factors_used, gapBooks: quote.gap, n_senales: 2 },
        lm,
        pickSideLm: lineMovementSideForPick(marketKey, side),
        wnba_overrides_applied: mergeOverrides(ctx, projection, [
          "line_movement_disabled",
          "team_total_requires_odds_line",
        ]),
      });
      if (pick?.pick !== null && pick) picks.push(pick);
    }
  }

  const homeProj = projectWnbaTeamTotal(ctx, "home");
  const awayProj = projectWnbaTeamTotal(ctx, "away");
  const coherenceCtx = buildCoherenceCtx(ctx, homeProj.pts, awayProj.pts);

  const deduped = deduplicateTeamTotalPicks(picks);
  const { coherent, removed } = resolvePickCoherence(deduped, coherenceCtx);
  if (removed.length > 0) {
    console.info(
      `[WNBA-coherence] ${removed.length} pick(s) descartado(s) por contradicción en partido ${ctx?.homeName ?? "?"} vs ${ctx?.awayName ?? "?"}: ` +
      removed.map((p) => `${p.market}(${p.side})`).join(", ")
    );
  }

  const sorted = coherent.sort((a, b) => (b.score || 0) - (a.score || 0));
  persistPolicyPicks(game, sorted, "wnba", "WNBA").catch((err) => {
    console.warn("[backtesting] WNBA persist:", err.message);
  });
  return sorted;
}

export { SPORT };

