import { attachLineTrapFlags } from "./line-trap-flags.js";
import { calibrateForDisplay, calibrateForScoring } from "./pick-calibration.js";
import { detectLineMovement } from "./line-movement-engine.js";
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
  projectNflFirstHalfTotal,
  projectNflGameTotal,
  projectNflMoneyline,
  projectNflTeamTotal,
  simulateNflFirstHalfOver,
  simulateNflTeamOver,
  simulateNflTotalOver,
} from "./nfl-projection.js";
import { persistPolicyPicks } from "./backtesting.js";
import { NFL_THRESHOLDS, applyDataQualityPenalties, resolveColorWithSportThresholds } from "./sport-bettable-thresholds.js";

const MARKET_ORDER = [
  "first_half_total",
  "team_total_home",
  "team_total_away",
  "game_total",
  "moneyline",
];

const ODDS_RANGE = NFL_THRESHOLDS.oddsRange;

function dataQualityMeta(ctx, game) {
  return {
    oddsAvailable: Boolean(game?.odds?.bookmakers),
    sampleGames: Math.min(ctx?.home?.form?.gamesPlayed || 0, ctx?.away?.form?.gamesPlayed || 0) || null,
    freshnessOk: Boolean(ctx?.flags?.stats_espn_disponibles),
  };
}

function buildTotalsPick({ marketKey, side, line, odds, prob, ctx, signals, lm, pickSideLm, game }) {
  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  if (ev_model == null) return null;
  const dqMeta = dataQualityMeta(ctx, game);
  const dataQuality = applyDataQualityPenalties(
    computeDataQuality(ctx.flags || {}, dqMeta),
    {},
    ctx.flags || {},
    "nfl"
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

  const requireEdge = true;
  const sportColor = resolveColorWithSportThresholds(NFL_THRESHOLDS, {
    ev: ev_model,
    signals: scoringSignals,
    lm,
    pickSideLm,
    game,
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
    probModel: anchor.prob,
    probMarket,
    requireEdge,
    flags: ctx.flags || {},
    confidence: finalConfidence,
    ...sportColor.gateParams,
  });

  logValueGateFailure("NFL", {
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
  if (Math.abs(edge) < NFL_THRESHOLDS.color.amarillo.edge) return null;
  const ev_raw = evFromProbability(prob, odds);
  const ev_model = calibrateForScoring(ev_raw);
  const ev_display = calibrateForDisplay(ev_raw);
  const dqMeta = dataQualityMeta(ctx, game);
  const dataQuality = applyDataQualityPenalties(
    computeDataQuality(ctx.flags || {}, dqMeta),
    {},
    ctx.flags || {},
    "nfl"
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

  const requireEdge = true;
  const sportColor = resolveColorWithSportThresholds(NFL_THRESHOLDS, {
    ev: ev_model,
    signals: scoringSignals,
    lm,
    pickSideLm: side,
    game,
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
    pickSide: side,
    probModel: prob,
    probMarket: impliedProb,
    requireEdge,
    flags: ctx.flags || {},
    confidence: finalConfidence,
    ...sportColor.gateParams,
  });

  logValueGateFailure("NFL", {
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

export async function evaluateNflGamePicks(game) {
  const ctx = game.context;
  const bookmakers = game.odds?.bookmakers || {};
  const picks = [];
  const signals = game.marketSignals || {};
  const lmBase = {
    pct_tickets_home: game.lineMovementInput?.pct_tickets_home ?? 50,
    pct_money_home: game.lineMovementInput?.pct_money_home ?? 50,
    hay_noticia_lesion: Boolean(ctx?.hay_noticia_lesion),
    sport: "nfl",
  };

  for (const marketKey of MARKET_ORDER) {
    const quote = pickProMarketQuote(bookmakers, marketKey);
    const lm = detectMarketLineMovement(lmBase, marketKey, quote, game);

    if (marketKey === "first_half_total") {
      const projection = projectNflFirstHalfTotal(ctx);
      const line =
        Number(quote.line) ||
        Number(game.odds?.firstHalfLine) ||
        estimateFirstHalfLineFromGame(game.odds?.totalsLine, "nfl") ||
        Math.round(projection.total * 2) / 2;
      const sim = simulateNflFirstHalfOver(ctx, line);
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
        signals: { ...signals, factors_used: projection.factors_used, n_senales: 2 },
        lm,
        pickSideLm: lineMovementSideForPick(marketKey, side),
        game,
      });
      if (pick?.pick !== null && pick) picks.push(pick);
      continue;
    }

    if (marketKey === "team_total_home" || marketKey === "team_total_away") {
      const sideKey = marketKey === "team_total_home" ? "home" : "away";
      const projection = projectNflTeamTotal(ctx, sideKey);
      const line = Number(quote.line) || Math.round(projection.pts * 2) / 2;
      const sim = simulateNflTeamOver(ctx, sideKey, line);
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
      const base = projectNflGameTotal(ctx);
      const line = Number(quote.line) || Math.round(base.meanTotal * 2) / 2;
      const sim = simulateNflTotalOver(ctx, line);
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
      const ml = projectNflMoneyline(ctx);
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
        signals: { ...signals, factors_used: ml.factors_used },
        lm,
        marketProb: side === "home" ? marketProbHome : marketProbAway,
        game,
      });
      if (pick) picks.push(pick);
    }
  }

  const sorted = picks.sort((a, b) => (b.score || 0) - (a.score || 0));
  persistPolicyPicks(game, sorted, "nfl", "NFL").catch((err) => {
    console.warn("[backtesting] NFL persist:", err.message);
  });
  return sorted;
}
