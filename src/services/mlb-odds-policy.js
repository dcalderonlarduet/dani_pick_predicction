import { detectLineMovement } from "./line-movement-engine.js";
import { openingLineForMarket, lineMovementSideForPick } from "./pro-market-quotes.js";
import {
  calcularScore,
  computeDataQuality,
  evFromProbability,
  evaluateValueGates,
  impliedProbabilityFromDecimal,
  marketAnchorBlend,
  resolvePickColor,
} from "./pro-odds-scoring.js";
import { round } from "../utils/math.js";
import { normalizeExpectedValueMlb } from "./mlb-model-enhancements.js";
import { calibrateForDisplay, getMinRecommendationConfidence, passesRecommendationConfidence } from "./pick-calibration.js";
import {
  MLB_THRESHOLDS,
  applyDataQualityPenalties,
  resolveColorWithSportThresholds,
} from "./sport-bettable-thresholds.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";

const ODDS_RANGE = MLB_THRESHOLDS.oddsRange;

const MLB_GATE_LOG = process.env.DEBUG_GATES === "true";
const MLB_PICK_MODE = String(process.env.MLB_PICK_MODE || process.env.PICK_MODE || "value").toLowerCase();
const MLB_VALUE_EV_MIN = Number.parseFloat(process.env.MLB_VALUE_EV_MIN || "0.03");
const MLB_VALUE_EDGE_MIN = Number.parseFloat(process.env.MLB_VALUE_EDGE_MIN || "0.025");
const MLB_CONF_EDGE_CONFLICT_CONFIDENCE = 85;
const MLB_CONF_EDGE_CONFLICT_EDGE = 0.08;

function isMlbValueMode() {
  return MLB_PICK_MODE !== "pro" && MLB_PICK_MODE !== "strict";
}

function hasMlbConfEdgeConflict(confidence, edge) {
  return (
    Number.isFinite(confidence) &&
    Number.isFinite(edge) &&
    confidence >= MLB_CONF_EDGE_CONFLICT_CONFIDENCE &&
    Math.abs(edge) < MLB_CONF_EDGE_CONFLICT_EDGE
  );
}

function passesMlbValueMode({ color, valueGates, evModel, edge, score, confidence, cuota_en_rango, lineTrapActive }) {
  if (!isMlbValueMode()) return false;
  if (lineTrapActive) return false;
  if (color !== "verde" && color !== "amarillo") return false;
  if (!cuota_en_rango) return false;
  if (!Number.isFinite(evModel) || evModel < MLB_VALUE_EV_MIN) return false;
  if (!Number.isFinite(edge) || Math.abs(edge) < MLB_VALUE_EDGE_MIN) return false;
  if (!Number.isFinite(score) || score < MLB_THRESHOLDS.color.amarillo.score) return false;
  if (!passesRecommendationConfidence(confidence, getMinRecommendationConfidence("mlb"))) return false;

  const failures = Array.isArray(valueGates?.failures) ? valueGates.failures : [];
  return !failures.some((failure) =>
    ["cuota_fuera_rango", "ev_bajo", "edge_bajo", "rlm_contra", "modelo_vs_mercado", "confianza_alta_edge_bajo"].includes(failure)
  );
}

function computeMlbDataQuality(flags, meta) {
  let dq = applyDataQualityPenalties(
    computeDataQuality(flags, meta),
    MLB_THRESHOLDS.dataQualityPenalties,
    flags,
    "mlb"
  );
  // Penalizar fuertemente si pitcher desconocido: el modelo usó prior genérico
  if (meta?.hasPendingPitcher) {
    dq = Math.max(0, dq - 0.25);
  } else if (meta?.pitcherDataQuality === "partial") {
    dq = Math.max(0, dq - 0.10);
  }
  return dq;
}

function logMlbGateFailures({ recommendation, game, color, valueGates, score, evModel, evRaw, dataQuality, edge }) {
  if (!MLB_GATE_LOG) return;
  if (valueGates.passed) return;

  console.info("[MLB-GATE-FAIL]", {
    gameId: game?.id || game?.gamePk,
    matchup: `${game?.awayTeam?.abbrev || game?.away} @ ${game?.homeTeam?.abbrev || game?.home}`,
    type: recommendation?.type,
    selection: recommendation?.selection,
    color,
    failures: valueGates.failures,
    score: Math.round(score),
    ev: round(evModel, 4),
    evRaw,
    dataQuality: round(dataQuality, 3),
    edge: round(edge, 3),
    odds: recommendation?.odds,
    confidence: recommendation?.confidence,
  });
}

function gapBooks(a, b) {
  const left = impliedProbabilityFromDecimal(a);
  const right = impliedProbabilityFromDecimal(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return Math.abs(left - right);
}

function readBook(bookmakers, name) {
  if (!bookmakers || typeof bookmakers !== "object") return null;
  const candidates = [name, String(name), String(name).toLowerCase(), canonicalName(name)].filter(Boolean);
  for (const key of candidates) {
    if (bookmakers[key]) return bookmakers[key];
  }

  const desired = canonicalName(name);
  for (const [key, book] of Object.entries(bookmakers)) {
    if (canonicalName(key) === desired) return book;
  }
  return null;
}

export function pickMlbMarketQuote(bookmakers = {}, marketKey) {
  const b365 = readBook(bookmakers, "Bet365");
  const winamax = readBook(bookmakers, "Winamax FR") || readBook(bookmakers, "Winamax");

  if (marketKey === "moneyline" || marketKey === "runline") {
    return {
      home: b365?.winner?.[0],
      away: b365?.winner?.[1],
      line: null,
      over: b365?.winner?.[0],
      under: b365?.winner?.[1],
      gap: gapBooks(b365?.winner?.[0], winamax?.winner?.[0]),
    };
  }

  if (marketKey === "team_total_home") {
    const row = b365?.teamTotalHome || {};
    const alt = winamax?.teamTotalHome || {};
    return {
      line: row?.line,
      over: row?.over,
      under: row?.under,
      gap: gapBooks(row?.over, alt?.over),
    };
  }

  if (marketKey === "team_total_away") {
    const row = b365?.teamTotalAway || {};
    const alt = winamax?.teamTotalAway || {};
    return {
      line: row?.line,
      over: row?.over,
      under: row?.under,
      gap: gapBooks(row?.over, alt?.over),
    };
  }

  const row = b365?.totals || {};
  const alt = winamax?.totals || {};
  return {
    line: row?.line,
    over: row?.over,
    under: row?.under,
    gap: gapBooks(row?.over, alt?.over),
  };
}

export function mlbRecommendationMarketMeta(recommendation) {
  if (!recommendation) return null;

  if (recommendation.type === "moneyline") {
    return {
      marketKey: "moneyline",
      pickSideLm: recommendation.teamSide || "home",
      oddsRangeKey: "moneyline",
      requireEdge: true,
      lmMarketKey: "moneyline",
    };
  }

  if (recommendation.type === "runline") {
    return {
      marketKey: "runline",
      pickSideLm: recommendation.teamSide || "home",
      oddsRangeKey: "runline",
      requireEdge: false,
      lmMarketKey: "moneyline",
    };
  }

  if (recommendation.type === "totals") {
    const sel = String(recommendation.selection || "").toLowerCase();
    const side = sel.includes("más de") || sel.includes("(+)") || sel.includes("over") ? "over" : "under";
    return {
      marketKey: "game_total",
      pickSideLm: lineMovementSideForPick("game_total", side),
      oddsRangeKey: "game_total",
      requireEdge: true,
      lmMarketKey: "game_total",
    };
  }

  if (recommendation.type === "team-total") {
    const sideKey = recommendation.marketKey === "teamTotalAway" ? "team_total_away" : "team_total_home";
    const sel = String(recommendation.selection || "").toLowerCase();
    const side = sel.includes("más de") || sel.includes("(+)") || sel.includes("over") ? "over" : "under";
    return {
      marketKey: sideKey,
      pickSideLm: lineMovementSideForPick(sideKey, side),
      oddsRangeKey: sideKey,
      requireEdge: true,
      lmMarketKey: sideKey,
    };
  }

  return null;
}

function mlbDataQualityMeta(game) {
  const ctx = game?.mlbContext || {};
  const flags = ctx.flags || {};
  return {
    oddsAvailable: Boolean(game?.oddsAvailable),
    sampleGames: ctx.sampleGames ?? null,
    freshnessOk: Boolean(flags.freshness_ok),
    // Penalizar cuando algún pitcher no está confirmado.
    // Un pitcher "Pendiente" significa que el modelo usó regressedRunMetric=4.1
    // (prior genérico) en vez de datos reales — el EV calculado es poco fiable.
    hasPendingPitcher: Boolean(game?.hasPendingPitcher),
    pitcherDataQuality: game?.pitcherDataQuality || "full",
  };
}

/**
 * Penaliza la confianza del pick cuando hay pitcher desconocido.
 * Se llama desde computeMlbPickConfidencePenalty.
 */
function mlbPitcherPendingPenalty(game) {
  if (!game?.hasPendingPitcher) return 0;
  // Penalización fuerte: sin pitcher conocido el EV puede ser ficticio
  return 18; // resta 18 puntos de confianza
}

function detectMlbMarketLineMovement(game, lmMarketKey, quote) {
  const lmInput = game?.lineMovementInput || {};
  const oddsPayload = {
    totalsLine: game?.totalsLine,
    bookmakers: game?.bookmakers,
  };
  const lines = openingLineForMarket(lmInput, lmMarketKey, quote, oddsPayload);
  return detectLineMovement({
    pct_tickets_home: lmInput.pct_tickets_home ?? 50,
    pct_money_home: lmInput.pct_money_home ?? 50,
    hay_noticia_lesion: Boolean(game?.mlbContext?.hay_noticia_lesion),
    sport: "mlb",
    marketKey: lmMarketKey,
    ...lines,
  });
}

function lineMovementRationale(lm, pickSideLm) {
  if (!lm || lm.tipo === "NEUTRO" || lm.tipo === "NOTICIA") return null;

  if (lm.tipo === "LINEA_TRAMPA") {
    if (pickSideLm === lm.lado_publico) {
      return "Trampa detectada: mucha gente apuesta por este lado y la cuota empeoró; el modelo desaconseja esta apuesta.";
    }
    return "Trampa detectada: la multitud va al otro lado; puede haber mejor opción en el lado contrario.";
  }

  if (lm.tipo === "RLM") {
    if (pickSideLm === lm.lado_sharp) {
      return "Reverse line movement: el dinero inteligente apoya este lado.";
    }
    return "RLM en contra del pick: el mercado se mueve contra esta selección.";
  }

  if (lm.tipo === "STEAM_MOVE") {
    return pickSideLm === lm.lado_sharp
      ? "Steam move alineado con el pick."
      : "Steam move en dirección contraria al pick.";
  }

  return null;
}

function verdictFromColor(color, proBettable) {
  if (color === "verde" && proBettable) return "valid";
  if (color === "amarillo" && proBettable) return "lean";
  return "avoid";
}

function verdictLabelFromColor(color, proBettable) {
  if (color === "verde" && proBettable) return "Sí: buena opción para apostar";
  if (color === "amarillo" && proBettable) return "Pick con valor moderado (amarillo)";
  if (color === "amarillo") return "Idea interesante, pero sin valor claro en cuota";
  if (color === "gris" && proBettable === false) return "Mejor no apostar";
  return "Mejor no apostar";
}

function finiteBookOdd(value) {
  const odd = Number(value);
  return Number.isFinite(odd) && odd > 1 ? odd : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseLineFromSelection(value) {
  const match = String(value || "").match(/([+-]?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function lineMatches(bookLine, targetLine) {
  if (!Number.isFinite(targetLine)) return true;
  if (!Number.isFinite(bookLine)) return false;
  return Math.abs(bookLine - targetLine) <= 0.01;
}

function mlbRecommendationSelectionSide(recommendation, meta) {
  if (recommendation?.type === "moneyline" || recommendation?.type === "runline") {
    return recommendation.teamSide || meta?.pickSideLm || null;
  }

  if (recommendation?.wantsOver === true) return "over";
  if (recommendation?.wantsOver === false) return "under";

  const raw = String(`${recommendation?.selection || ""} ${recommendation?.id || ""}`).toLowerCase();
  const normalized = canonicalName(raw);
  if (raw.includes("(+)") || normalized.includes("over") || normalized.includes("mas de")) return "over";
  if (raw.includes("(-)") || normalized.includes("under") || normalized.includes("menos de")) return "under";
  return null;
}

function addRealQuoteCandidate(candidates, bookmaker, odd, line = null, point = null) {
  const parsedOdd = finiteBookOdd(odd);
  if (!parsedOdd) return;
  candidates.push({
    bookmaker,
    odd: parsedOdd,
    line: Number.isFinite(Number(line)) ? Number(line) : null,
    point: Number.isFinite(Number(point)) ? Number(point) : null,
  });
}

function pickRealMlbRecommendationQuote(bookmakers = {}, recommendation, meta) {
  if (!bookmakers || typeof bookmakers !== "object" || !recommendation || !meta) return null;

  const side = mlbRecommendationSelectionSide(recommendation, meta);
  const targetLine = firstFiniteNumber(recommendation.line, recommendation.totalsLine);
  const targetRunLine = firstFiniteNumber(recommendation.line, parseLineFromSelection(recommendation.selection));
  const candidates = [];

  for (const [bookmaker, market] of Object.entries(bookmakers)) {
    if (!market) continue;

    if (meta.marketKey === "moneyline" && (side === "home" || side === "away")) {
      addRealQuoteCandidate(candidates, bookmaker, market.winner?.[side === "home" ? 0 : 1]);
      continue;
    }

    if (meta.marketKey === "runline" && (side === "home" || side === "away")) {
      const point = side === "home" ? market.spreads?.pointHome : market.spreads?.pointAway;
      if (!lineMatches(Number(point), targetRunLine)) continue;
      addRealQuoteCandidate(candidates, bookmaker, side === "home" ? market.spreads?.home : market.spreads?.away, null, point);
      continue;
    }

    if (meta.marketKey === "game_total" && (side === "over" || side === "under")) {
      const line = Number(market.totals?.line);
      if (!lineMatches(line, targetLine)) continue;
      addRealQuoteCandidate(candidates, bookmaker, side === "over" ? market.totals?.over : market.totals?.under, line);
      continue;
    }

    if ((meta.marketKey === "team_total_home" || meta.marketKey === "team_total_away") && (side === "over" || side === "under")) {
      const teamMarket = meta.marketKey === "team_total_home" ? market.teamTotalHome : market.teamTotalAway;
      const line = Number(teamMarket?.line);
      if (!lineMatches(line, targetLine)) continue;
      addRealQuoteCandidate(candidates, bookmaker, side === "over" ? teamMarket?.over : teamMarket?.under, line);
    }
  }

  return candidates.reduce((best, candidate) => {
    if (!best || candidate.odd > best.odd) return candidate;
    return best;
  }, null);
}

function buildMlbNoRealOddsScoring(recommendation, game, meta, quote) {
  const lm = meta?.lmMarketKey ? detectMlbMarketLineMovement(game, meta.lmMarketKey, quote) : null;
  const probModel = Number(recommendation?.modelProbability);
  const flags = game?.mlbContext?.flags || {};
  return {
    noRealOdds: true,
    color: "gris",
    score: 0,
    score_final: 0,
    confidence: recommendation?.confidence ?? null,
    edge: null,
    edgePercent: null,
    ev_model: null,
    prob_model: Number.isFinite(probModel) ? probModel : null,
    prob_market: null,
    data_quality: computeMlbDataQuality(flags, mlbDataQualityMeta(game)),
    pitcher_pending: game?.hasPendingPitcher || false,
    pitcher_data_quality: game?.pitcherDataQuality || "full",
    line_movement: lm,
    value_gates: { passed: false, failures: ["sin_cuota_real"] },
    proBettable: false,
    valueBettable: false,
    valueModeApplied: false,
    lineMovementNote: "Sin cuota real del book: EV no calculable.",
    pct_public_home: game?.lineMovementInput?.pct_tickets_home ?? null,
    pct_public_away:
      game?.lineMovementInput?.pct_tickets_away ??
      (game?.lineMovementInput?.pct_tickets_home != null
        ? round(100 - Number(game.lineMovementInput.pct_tickets_home), 1)
        : null),
    lineTrapActive: false,
    lineTrapDetected: lm?.tipo === "LINEA_TRAMPA",
  };
}

export function buildMlbProScoring(recommendation, game) {
  const meta = mlbRecommendationMarketMeta(recommendation);
  if (!meta) return null;

  const quote = pickMlbMarketQuote(game?.bookmakers || {}, meta.marketKey);
  const realQuote = pickRealMlbRecommendationQuote(game?.bookmakers || {}, recommendation, meta);
  if (!realQuote?.odd) return buildMlbNoRealOddsScoring(recommendation, game, meta, quote);

  const odds = realQuote.odd;
  const probModel = Number(recommendation.modelProbability);
  if (!Number.isFinite(probModel)) return null;

  const lm = detectMlbMarketLineMovement(game, meta.lmMarketKey, quote);
  const probMarket = impliedProbabilityFromDecimal(odds);
  const edge = probModel - probMarket;
  const evRaw = evFromProbability(probModel, odds);
  const evModel = normalizeExpectedValueMlb(evRaw);
  const evDisplay = calibrateForDisplay(evRaw);
  if (evModel == null) return null;

  const flags = game?.mlbContext?.flags || {};
  const dataQuality = computeMlbDataQuality(flags, mlbDataQualityMeta(game));
  const range = ODDS_RANGE[meta.oddsRangeKey] || ODDS_RANGE.game_total;
  const cuota_en_rango = odds >= range.min && odds <= range.max;

  const signals = {
    valueBet: Boolean(recommendation.valueBetApplied),
    dropping: recommendation.droppingOddsSignal === "confirmed",
    gapBooks: recommendation.oddsGap || quote?.gap || 0,
    n_senales: (recommendation.valueBetApplied ? 1 : 0) + (recommendation.droppingOddsSignal === "confirmed" ? 1 : 0),
  };

  const scoreResult = calcularScore({
    ev_modelo: evModel,
    ev_externo_coincide: signals.valueBet,
    dropping_alineado: signals.dropping,
    gap_books: signals.gapBooks,
    cuota_en_rango,
    dataQuality,
    n_senales: signals.n_senales,
    lm,
    pick_side: meta.pickSideLm,
    confianza: recommendation.confidence ?? 55,
  });

  if (scoreResult.discarded) {
    return {
      color: "gris",
      score: 0,
      score_final: 0,
      edge: round(edge, 3),
      edgePercent: round(edge * 100, 1),
      ev_model: evModel,
      prob_model: probModel,
      prob_market: probMarket,
      data_quality: dataQuality,
      pitcher_pending: game?.hasPendingPitcher || false,
      pitcher_data_quality: game?.pitcherDataQuality || "full",
      line_movement: lm,
      value_gates: { passed: false, failures: ["rlm_contra"] },
      proBettable: false,
      discarded: scoreResult.discarded,
      lineMovementNote: scoreResult.discarded?.razon || lineMovementRationale(lm, meta.pickSideLm),
    };
  }

  let confianza = scoreResult.confianza;
  const anchor = marketAnchorBlend(probModel, probMarket);
  confianza += anchor.confianzaDelta;
  const finalConfidence = Math.max(0, Math.min(100, confianza));

  const sportColor = resolveColorWithSportThresholds(MLB_THRESHOLDS, {
    ev: evModel,
    signals,
    lm,
    pickSideLm: meta.pickSideLm,
    game,
  });

  const color = resolvePickColor({
    score: scoreResult.score,
    ev: evModel,
    edge,
    cuota_en_rango,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
    evVerde: sportColor.evVerde,
    evAmarillo: sportColor.evAmarillo,
    edgeVerde: sportColor.edgeVerde,
    edgeAmarillo: sportColor.edgeAmarillo,
    requireEdge: meta.requireEdge,
  });

  const valueGates = evaluateValueGates({
    ev: evModel,
    edge,
    dataQuality,
    cuota_en_rango,
    lm,
    pickSide: meta.pickSideLm,
    probModel: anchor.prob,
    probMarket,
    requireEdge: meta.requireEdge,
    flags,
    confidence: finalConfidence,
    ...sportColor.gateParams,
  });

  const confEdgeConflict = hasMlbConfEdgeConflict(finalConfidence, edge);
  const finalValueGates = confEdgeConflict
    ? {
        ...valueGates,
        passed: false,
        failures: [...new Set([...(valueGates.failures || []), "confianza_alta_edge_bajo"])],
      }
    : valueGates;

  logMlbGateFailures({
    recommendation: { ...recommendation, odds },
    game,
    color,
    valueGates: finalValueGates,
    score: scoreResult.score,
    evModel,
    evRaw,
    dataQuality,
    edge,
  });

  const proBettable = (color === "verde" || color === "amarillo") && finalValueGates.passed;
  const lineTrapActive =
    lm?.tipo === "LINEA_TRAMPA" && meta.pickSideLm != null && lm.lado_publico === meta.pickSideLm;
  const lineTrapDetected = lm?.tipo === "LINEA_TRAMPA";

  let finalColor = confEdgeConflict ? "gris" : color;
  let finalProBettable = proBettable;
  if (!confEdgeConflict && lineTrapActive && (color === "verde" || color === "amarillo")) {
    finalColor = "amarillo";
    if (color === "verde") finalProBettable = false;
  }
  const valueBettable =
    finalProBettable ||
    passesMlbValueMode({
      color: finalColor,
      valueGates: finalValueGates,
      evModel,
      edge,
      score: scoreResult.score,
      confidence: finalConfidence,
      cuota_en_rango,
      lineTrapActive,
    });

  return {
    color: finalColor,
    score: scoreResult.score,
    score_final: scoreResult.score,
    odds,
    bookmaker: realQuote.bookmaker,
    line: realQuote.line ?? recommendation.line ?? null,
    confidence: finalConfidence,
    edge: round(edge, 3),
    edgePercent: round(edge * 100, 1),
    ev_model: evModel,
    ev_display: evDisplay,
    ev_raw: evRaw,
    prob_model: anchor.prob,
    prob_market: probMarket,
    data_quality: dataQuality,
    pitcher_pending: game?.hasPendingPitcher || false,
    pitcher_data_quality: game?.pitcherDataQuality || "full",
    line_movement: lm,
    value_gates: finalValueGates,
    proBettable: finalProBettable,
    valueBettable,
    valueModeApplied: valueBettable && !finalProBettable,
    market_anchor_applied: anchor.applied,
    confianza_final: confianza,
    lineMovementNote: lineMovementRationale(lm, meta.pickSideLm),
    pct_public_home: game?.lineMovementInput?.pct_tickets_home ?? null,
    pct_public_away:
      game?.lineMovementInput?.pct_tickets_away ??
      (game?.lineMovementInput?.pct_tickets_home != null
        ? round(100 - Number(game.lineMovementInput.pct_tickets_home), 1)
        : null),
    lineTrapActive,
    lineTrapDetected,
  };
}

export function applyMlbProScoringToRecommendation(recommendation, game) {
  const pro = buildMlbProScoring(recommendation, game);
  if (!pro) return recommendation;

  if (pro.noRealOdds) {
    const rationale = [recommendation.rationale, pro.lineMovementNote].filter(Boolean).join(" ");
    return {
      ...recommendation,
      bookmaker: null,
      odds: null,
      impliedProbability: null,
      color: "gris",
      score: 0,
      score_final: 0,
      edge: null,
      edgePercent: null,
      ev: null,
      evPercent: null,
      evRaw: null,
      evCapped: false,
      bettable: false,
      proBettable: false,
      valueBettable: false,
      valueModeApplied: false,
      verdict: "avoid",
      verdictLabel: "Sin cuota real: EV no calculable",
      line_movement: pro.line_movement,
      value_gates: pro.value_gates,
      data_quality: pro.data_quality,
      pitcher_pending: pro.pitcher_pending,
      pitcher_data_quality: pro.pitcher_data_quality,
      prob_model: pro.prob_model,
      prob_market: null,
      lineMovementNote: pro.lineMovementNote,
      pct_public_home: pro.pct_public_home,
      pct_public_away: pro.pct_public_away,
      lineTrapActive: false,
      lineTrapDetected: Boolean(pro.lineTrapDetected),
      rationale,
      noRealOdds: true,
    };
  }

  const bettable = Boolean(pro.valueBettable ?? pro.proBettable);
  const verdict = verdictFromColor(pro.color, bettable);
  const verdictLabel =
    pro.lineTrapActive && (pro.color === "amarillo" || pro.color === "verde")
      ? "Trampa de línea: el público va al lado caro"
      : pro.valueModeApplied
        ? "Pick value por EV positivo"
        : verdictLabelFromColor(pro.color, bettable);
  const rationaleParts = [recommendation.rationale, pro.lineMovementNote].filter(Boolean);
  if (pro.edgePercent != null && Number.isFinite(pro.edgePercent)) {
    rationaleParts.push(`Edge modelo vs mercado: ${pro.edgePercent >= 0 ? "+" : ""}${pro.edgePercent} pp.`);
  }
  if (pro.score_final != null) {
    rationaleParts.push(`Score pro: ${Math.round(pro.score_final)}/100 (${pro.color}).`);
  }

  return {
    ...recommendation,
    color: pro.color,
    score: pro.score_final,
    score_final: pro.score_final,
    bookmaker: pro.bookmaker || recommendation.bookmaker || null,
    odds: pro.odds ?? recommendation.odds,
    impliedProbability: Number.isFinite(pro.prob_market) ? round(pro.prob_market, 3) : recommendation.impliedProbability,
    line: pro.line ?? recommendation.line,
    edge: pro.edge,
    edgePercent: pro.edgePercent,
    ev: pro.ev_model,
    evPercent: round(pro.ev_model * 100, 1),
    evDisplay: pro.ev_display ?? null,
    evRaw: pro.ev_raw ?? recommendation.evRaw ?? null,
    evCapped: Number.isFinite(pro.ev_raw) && Math.abs(pro.ev_raw - pro.ev_model) > 0.005,
    confidence: pro.confidence ?? recommendation.confidence,
    bettable,
    proBettable: pro.proBettable,
    valueBettable: Boolean(pro.valueBettable),
    valueModeApplied: Boolean(pro.valueModeApplied),
    verdict,
    verdictLabel,
    line_movement: pro.line_movement,
    value_gates: pro.value_gates,
    data_quality: pro.data_quality,
    pitcher_pending: pro.pitcher_pending,
    pitcher_data_quality: pro.pitcher_data_quality,
    prob_model: pro.prob_model,
    prob_market: pro.prob_market,
    lineMovementNote: pro.lineMovementNote,
    pct_public_home: pro.pct_public_home,
    pct_public_away: pro.pct_public_away,
    lineTrapActive: Boolean(pro.lineTrapActive),
    lineTrapDetected: Boolean(pro.lineTrapDetected),
    rationale: rationaleParts.join(" "),
    discarded: pro.discarded || null,
  };
}

export function applyMlbProScoringToGame(game) {
  if (!Array.isArray(game?.recommendations)) return game;
  game.recommendations = game.recommendations.map((rec) => applyMlbProScoringToRecommendation(rec, game));
  if (game.modelLean) {
    game.modelLean = applyMlbProScoringToRecommendation(game.modelLean, game);
  }
  return game;
}
