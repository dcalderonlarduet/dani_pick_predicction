import { calibrateForDisplay, calibrateForScoring } from "./pick-calibration.js";
import { attachLineTrapFlags } from "./line-trap-flags.js";
import { detectLineMovement } from "./line-movement-engine.js";
import { buildCoherenceCtx, resolvePickCoherence } from "./pick-coherence.js";
import {
  estimateFirstHalfLineFromGame,
  lineMovementSideForPick,
  openingLineForMarket,
  pickProMarketQuote,
} from "./pro-market-quotes.js";
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
  projectNbaFirstHalfTotal,
  projectNbaGameTotal,
  projectNbaMoneyline,
  projectNbaTeamTotal,
  simulateNbaFirstHalfOver,
  simulateNbaTeamOver,
  simulateNbaTotalOver,
} from "./nba-projection.js";
import { persistPolicyPicks } from "./backtesting.js";
import { NBA_THRESHOLDS, applyDataQualityPenalties, resolveColorWithSportThresholds } from "./sport-bettable-thresholds.js";

const MARKET_ORDER = [
  "first_half_total",
  "team_total_home",
  "team_total_away",
  "game_total",
  "moneyline",
];

const ODDS_RANGE = NBA_THRESHOLDS.oddsRange;

function dataQualityMeta(ctx, game) {
  return {
    oddsAvailable: Boolean(game?.odds?.bookmakers && Object.keys(game.odds.bookmakers).length > 0),
    sampleGames: Math.min(ctx?.home?.form?.gamesPlayed || 0, ctx?.away?.form?.gamesPlayed || 0) || null,
    freshnessOk: Boolean(ctx?.flags?.freshness_ok),
  };
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
  if (!Number.isFinite(probHome) || !Number.isFinite(probAway)) {
    return { ...ml, espnWinProbAnchorApplied: false };
  }

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

function resolveProColorAndGates({
  scoreResult,
  ev_model,
  edge,
  cuota_en_rango,
  dataQuality,
  lm,
  pickSideLm,
  signals,
  requireEdge,
  game,
  probModel = null,
  probMarket = null,
  flags = null,
  confidence = null,
}) {
  const sportColor = resolveColorWithSportThresholds(NBA_THRESHOLDS, {
    ev: ev_model,
    score: scoreResult.score,
    signals,
    lm,
    pickSideLm,
    game,
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
  umbralVerde = NBA_THRESHOLDS.color.verde.score,
  umbralAmarillo = NBA_THRESHOLDS.color.amarillo.score,
  game,
}) {
  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  if (ev_model == null) return null;

  const dqMeta = dataQualityMeta(ctx, game);
  const dataQuality = applyDataQualityPenalties(
    computeDataQuality(ctx.flags || {}, dqMeta),
    {},
    ctx.flags || {},
    "nba"
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

  let confianza = scoreResult.confianza;
  const anchor = marketAnchorBlend(prob, probMarket);
  confianza += anchor.confianzaDelta;
  const finalConfidence = Math.max(0, Math.min(100, confianza));

  const { color, valueGates } = resolveProColorAndGates({
    scoreResult,
    ev_model,
    edge,
    cuota_en_rango,
    dataQuality,
    lm,
    pickSideLm,
    signals: scoringSignals,
    requireEdge: true,
    game,
    probModel: anchor.prob,
    probMarket,
    flags: ctx.flags || {},
    confidence: finalConfidence,
  });

  logValueGateFailure("NBA", {
    game,
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
      line,
      odds,
      color,
      bettable: (color === "verde" || color === "amarillo") && valueGates.passed,
      value_gates: valueGates,
      data_quality: dataQuality,
      confidence: finalConfidence,
      score: scoreResult.score,
      ev_model,
      ev_display,
      ev_raw,
      ev_external: signals?.evExternal ?? null,
      drop12h: signals?.drop12h ?? null,
      droppingOddsSignal: droppingAligned ? "confirmed" : signals?.dropping ? "faded" : null,
      prob_model: anchor.prob,
      prob_market: probMarket,
      source_log: ctx.source_log,
      factors_used: signals?.factors_used || [],
      market_anchor_applied: anchor.applied,
      confianza_final: confianza,
      score_final: scoreResult.score,
    },
    lm,
    pickSideLm
  );
}

function buildMoneylinePick({ side, odds, prob, ctx, signals, lm, marketProb, game }) {
  const parsedOdds = Number(odds);
  const impliedProb = Number(marketProb);
  if (!Number.isFinite(parsedOdds) || parsedOdds <= 1 || !Number.isFinite(impliedProb)) {
    return null;
  }
  const edge = prob - impliedProb;

  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  const dqMeta = dataQualityMeta(ctx, game);
  const dataQuality = applyDataQualityPenalties(
    computeDataQuality(ctx.flags || {}, dqMeta),
    {},
    ctx.flags || {},
    "nba"
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
  const finalConfidence = Math.max(0, Math.min(100, scoreResult.confianza));

  const { color, valueGates } = resolveProColorAndGates({
    scoreResult,
    ev_model,
    edge,
    cuota_en_rango,
    dataQuality,
    lm,
    pickSideLm: side,
    signals: scoringSignals,
    requireEdge: true,
    game,
    probModel: prob,
    probMarket: impliedProb,
    flags: ctx.flags || {},
    confidence: finalConfidence,
  });

  logValueGateFailure("NBA", {
    game,
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
      odds,
      color,
      bettable: (color === "verde" || color === "amarillo") && valueGates.passed,
      value_gates: valueGates,
      data_quality: dataQuality,
      confidence: finalConfidence,
      score: scoreResult.score,
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
      confianza_final: scoreResult.confianza,
      score_final: scoreResult.score,
    },
    lm,
    side
  );
}

function detectMarketLineMovement(lmBase, marketKey, quote, game) {
  const lines = openingLineForMarket(game.lineMovementInput, marketKey, quote, game.odds);
  return detectLineMovement({
    ...lmBase,
    marketKey,
    ...lines,
  });
}

export async function evaluateNbaGamePicks(game) {
  const ctx = game.context;
  const bookmakers = game.odds?.bookmakers || {};
  const picks = [];
  const signals = game.marketSignals || {};
  const lmBase = {
    pct_tickets_home: game.lineMovementInput?.pct_tickets_home ?? 50,
    pct_money_home: game.lineMovementInput?.pct_money_home ?? 50,
    hay_noticia_lesion: Boolean(ctx?.hay_noticia_lesion),
    sport: "nba",
  };

  for (const marketKey of MARKET_ORDER) {
    const quote = pickProMarketQuote(bookmakers, marketKey);
    const lm = detectMarketLineMovement(lmBase, marketKey, quote, game);

    if (marketKey === "first_half_total") {
      const projection = projectNbaFirstHalfTotal(ctx);
      const line =
        Number(quote.line) ||
        Number(game.odds?.firstHalfLine) ||
        estimateFirstHalfLineFromGame(quote.line ?? game.odds?.totalsLine, "nba") ||
        Math.round(projection.total * 2) / 2;
      const sim = simulateNbaFirstHalfOver(ctx, line);
      const probOver = sim.probOver ?? (projection.total > line ? 0.52 : 0.48);
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
        game,
      });
      if (pick?.pick !== null && pick) picks.push(pick);
      continue;
    }

    if (marketKey === "team_total_home" || marketKey === "team_total_away") {
      const sideKey = marketKey === "team_total_home" ? "home" : "away";
      const projection = projectNbaTeamTotal(ctx, sideKey);
      const line = Number(quote.line) || Math.round(projection.pts * 2) / 2;
      const sim = simulateNbaTeamOver(ctx, sideKey, line);
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
        game,
      });
      if (pick?.pick !== null && pick) picks.push(pick);
      continue;
    }

    if (marketKey === "game_total") {
      const base = projectNbaGameTotal(ctx);
      const line = Number(quote.line) || Math.round(base.meanTotal * 2) / 2;
      const sim = simulateNbaTotalOver(ctx, line);
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
        signals: { ...signals, factors_used: base.factors_used, gapBooks: quote.gap, n_senales: 3 },
        lm,
        pickSideLm: lineMovementSideForPick(marketKey, side),
        game,
      });
      if (pick?.pick !== null && pick) picks.push(pick);
      continue;
    }

    if (marketKey === "moneyline") {
      const ml = applyEspnMoneylineAnchor(projectNbaMoneyline(ctx), ctx);
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
        game,
      });
      if (pick) picks.push(pick);
    }
  }

  const homeProj = projectNbaTeamTotal(ctx, "home");
  const awayProj = projectNbaTeamTotal(ctx, "away");
  const coherenceCtx = buildCoherenceCtx(ctx, homeProj?.pts, awayProj?.pts);

  const { coherent, removed } = resolvePickCoherence(picks, coherenceCtx);
  if (removed.length > 0) {
    console.info(
      `[NBA-coherence] ${removed.length} pick(s) descartado(s) por contradicciÇün en partido ${ctx?.homeName ?? "?"} vs ${ctx?.awayName ?? "?"}: ` +
      removed.map((p) => `${p.market}(${p.side})`).join(", ")
    );
  }

  const sorted = coherent.sort((a, b) => (b.score || 0) - (a.score || 0));
  persistPolicyPicks(game, sorted, "nba", "NBA").catch((err) => {
    console.warn("[backtesting] NBA persist:", err.message);
  });
  return sorted;
}

