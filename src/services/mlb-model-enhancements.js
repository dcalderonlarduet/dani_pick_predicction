import { clamp, round } from "../utils/math.js";
import { calibrateForScoring } from "./pick-calibration.js";

export const MLB_EV_ABS_CAP = 0.08;
export const MLB_MARKET_DISAGREE_PP = 0.15;
export const LEAGUE_AVG_BULLPEN_ERA = 4.1;
const LEAGUE_RUN_METRIC = 4.1;
const HISTORY_VS_OPPONENT_MIN_GAMES = 3;
const HISTORY_VS_OPPONENT_WEIGHT = 0.6;
const REGRESSED_RUN_METRIC_WEIGHT = 0.4;
const HISTORY_VS_OPPONENT_MIN_GAP = 1.5;

function asNumber(value, fallback = NaN) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inningsToDecimal(value) {
  const raw = String(value ?? "0");
  const [wholePart, fractionPart = "0"] = raw.split(".");
  const whole = Number.parseInt(wholePart, 10) || 0;
  const fraction = Number.parseInt(fractionPart, 10) || 0;
  return whole + fraction / 3;
}

/** % de bateadores zurdo/switch en alineación confirmada (0–1). */
export function lineupLeftHandPct(feed, side) {
  const team = feed?.liveData?.boxscore?.teams?.[side];
  const order = team?.battingOrder || [];
  if (order.length < 5) return null;

  let leftWeight = 0;
  let total = 0;
  for (const playerId of order) {
    const player = team.players?.[`ID${playerId}`];
    const hand = player?.person?.batSide?.code || player?.stats?.batting?.batSide?.code;
    if (!hand) continue;
    total += 1;
    if (hand === "L") leftWeight += 1;
    else if (hand === "S") leftWeight += 0.55;
  }
  if (total < 5) return null;
  return clamp(leftWeight / total, 0.15, 0.65);
}

/**
 * Métrica de carreras permitidas con regresión simétrica:
 * - ERA muy buena vs xFIP → regresa hacia xFIP (suerte)
 * - ERA muy mala vs xFIP → regresa hacia xFIP (outlier / muestra pequeña)
 */
function baseRegressedPitcherRunMetric(pitcher = {}) {
  const era = asNumber(pitcher.era30);
  const xFip = asNumber(pitcher.xFip30);
  const fip = asNumber(pitcher.fip30);

  if (Number.isFinite(xFip)) {
    if (Number.isFinite(era)) {
      if (era + 0.75 < xFip) {
        return round(era * 0.35 + xFip * 0.65, 2);
      }
      if (era > xFip + 1.25 || era > 8) {
        let blended;
        if (era > 12) {
          blended = xFip * 0.82 + Math.min(era, xFip + 2.8) * 0.18;
        } else if (era > 8) {
          blended = era * 0.32 + xFip * 0.68;
        } else {
          blended = era * 0.42 + xFip * 0.58;
        }
        return round(Math.min(blended, xFip + 1.4), 2);
      }
    }
    return xFip;
  }

  if (Number.isFinite(fip)) {
    if (Number.isFinite(era) && era > 8) {
      return round(era * 0.35 + fip * 0.65, 2);
    }
    return fip;
  }

  if (Number.isFinite(era)) {
    if (era > 8) return round(era * 0.38 + LEAGUE_RUN_METRIC * 0.62, 2);
    return era;
  }

  return LEAGUE_RUN_METRIC;
}

export function historyVsOpponentRunMetricMeta(pitcher = {}, baseMetric = null) {
  const base = Number.isFinite(baseMetric) ? baseMetric : baseRegressedPitcherRunMetric(pitcher);
  const historyGames = asInteger(pitcher?.historyVsOpponent?.games, 0);
  const historyEra = asNumber(pitcher?.historyVsOpponent?.era);

  if (
    !Number.isFinite(base) ||
    historyGames < HISTORY_VS_OPPONENT_MIN_GAMES ||
    !Number.isFinite(historyEra)
  ) {
    return {
      metric: round(base, 2),
      applied: false,
      games: historyGames,
      era: Number.isFinite(historyEra) ? round(historyEra, 2) : null,
      gap: null,
    };
  }

  const gap = Math.abs(historyEra - base);
  if (gap <= HISTORY_VS_OPPONENT_MIN_GAP) {
    return {
      metric: round(base, 2),
      applied: false,
      games: historyGames,
      era: round(historyEra, 2),
      gap: round(gap, 2),
    };
  }

  return {
    metric: round(base * REGRESSED_RUN_METRIC_WEIGHT + historyEra * HISTORY_VS_OPPONENT_WEIGHT, 2),
    applied: true,
    games: historyGames,
    era: round(historyEra, 2),
    gap: round(gap, 2),
  };
}

export function regressedPitcherRunMetric(pitcher = {}) {
  return historyVsOpponentRunMetricMeta(pitcher).metric;
}

/**
 * Ajuste por forma reciente (últimas 2 salidas), bidireccional y con escepticismo
 * en muestras mínimas (ERA 0.0 o salida catastrófica aislada).
 */
export function recentPitcherFormRunDelta(pitcher = {}, baselineOverride = null) {
  let recentEra = asNumber(pitcher.recentStartsEra);
  const baseline = Number.isFinite(baselineOverride)
    ? baselineOverride
    : regressedPitcherRunMetric(pitcher);
  const starts30 = asInteger(pitcher.starts30, 0);

  if (!Number.isFinite(recentEra) || !Number.isFinite(baseline)) return 0;

  if (recentEra <= 1.0 && starts30 < 8) {
    recentEra = round(baseline * 0.6 + recentEra * 0.4, 2);
  }
  if (recentEra >= 10 && starts30 < 10) {
    recentEra = round(baseline * 0.78 + Math.min(recentEra, baseline + 3.5) * 0.22, 2);
  }

  const gap = recentEra - baseline;
  if (Math.abs(gap) <= 0.35) return 0;

  if (gap > 0.35) {
    return round(Math.min((gap - 0.35) * 0.2, 0.48), 3);
  }

  return round(Math.max((gap + 0.35) * 0.16, -0.38), 3);
}

/** Métrica final del abridor: regresión + forma reciente. */
export function effectivePitcherRunMetric(pitcher = {}) {
  const cachedBase = asNumber(pitcher?.regressedRunMetric);
  const base = Number.isFinite(cachedBase) ? cachedBase : regressedPitcherRunMetric(pitcher);
  const formDelta = recentPitcherFormRunDelta(pitcher, base);
  return round(clamp(base + formDelta, 2.0, 7.2), 2);
}

/** ERA de las dos últimas salidas desde game log. */
export function computeRecentStartsEra(gameLogSplits = []) {
  const starts = gameLogSplits
    .slice()
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .filter((entry) => asNumber(entry?.stat?.inningsPitched) > 0)
    .slice(0, 2);

  if (!starts.length) return null;

  let innings = 0;
  let earnedRuns = 0;
  for (const entry of starts) {
    innings += inningsToDecimal(entry?.stat?.inningsPitched);
    earnedRuns += asNumber(entry?.stat?.earnedRuns);
  }
  if (!innings) return null;
  return round((earnedRuns * 9) / innings, 2);
}

/** ERA ponderada de las últimas 4 salidas (pesos 0.40/0.30/0.20/0.10). */
export function computeWeightedRecentStartsEra(gameLogSplits = []) {
  const WEIGHTS = [0.40, 0.30, 0.20, 0.10];
  const starts = gameLogSplits
    .slice()
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .filter((entry) => inningsToDecimal(entry?.stat?.inningsPitched) > 0)
    .slice(0, 4);

  if (!starts.length) return null;

  const usedWeights = WEIGHTS.slice(0, starts.length);
  const totalWeight = usedWeights.reduce((sum, w) => sum + w, 0);
  let weightedEraSum = 0;
  for (let i = 0; i < starts.length; i++) {
    const ip = inningsToDecimal(starts[i]?.stat?.inningsPitched);
    const er = asNumber(starts[i]?.stat?.earnedRuns, 0);
    if (!ip) continue;
    weightedEraSum += (er * 9 / ip) * (usedWeights[i] / totalWeight);
  }
  return round(weightedEraSum, 2);
}

/**
 * Bateo vs abridor: split por mano, racha ofensiva, contacto/K suave.
 * Devuelve delta de carreras proyectadas y puntos para scoring.
 */
export function computeOffenseVsPitcherMatchup(offense = {}, pitcher = {}) {
  const seasonOps = asNumber(offense.seasonOps, 0.71);
  const splitOps = asNumber(offense.splitVsHandOps, seasonOps);
  const seasonRpg = asNumber(offense.seasonRunsPerGame, 4.2);
  const recentRpg = asNumber(offense.runsLast10, seasonRpg);

  const handOpsDelta = splitOps - seasonOps;
  const handRunBoost = handOpsDelta * 3.0;
  const trendBoost = clamp((recentRpg - seasonRpg) * 0.13, -0.32, 0.38);

  const kRate = asNumber(offense.kRate);
  const k9 = asNumber(pitcher.k9);
  const obp = asNumber(offense.seasonObp);
  const whip = asNumber(pitcher.whip30);
  let contactBoost = 0;

  if (Number.isFinite(kRate) && Number.isFinite(k9)) {
    contactBoost += clamp((0.21 - kRate) * 0.45 + (7.8 - k9) * 0.014, -0.09, 0.09);
  }
  if (Number.isFinite(obp) && Number.isFinite(whip)) {
    contactBoost += clamp((obp - 0.315) * 0.35 + (whip - 1.28) * 0.1, -0.07, 0.07);
  }

  const runDelta = round(clamp(handRunBoost + trendBoost + contactBoost, -0.48, 0.52), 3);
  const scorePoints = round(
    clamp(handOpsDelta * 36 + (recentRpg - seasonRpg) * 2.2 + contactBoost * 18, 0, 9),
    1
  );

  return {
    runDelta,
    scorePoints,
    handOpsDelta: round(handOpsDelta, 3),
    trendBoost: round(trendBoost, 3),
    contactBoost: round(contactBoost, 3),
  };
}

/** @deprecated Usar computeOffenseVsPitcherMatchup */
export function offensePitcherMatchupDelta(offense = {}, pitcher = {}) {
  return computeOffenseVsPitcherMatchup(offense, pitcher).runDelta;
}

export function pitcherEraContradictory(pitcher = {}) {
  const era = asNumber(pitcher.era30);
  const xFip = asNumber(pitcher.xFip30);
  if (!Number.isFinite(era) || !Number.isFinite(xFip)) return false;
  return Math.abs(era - xFip) > 3;
}

export function pitcherInsufficientSample(pitcher = {}) {
  const starts = asInteger(pitcher.starts30, 0);
  return starts > 0 && starts < 3;
}

/** Calibra probabilidades de runline (Poisson suele sobreestimar margen). */
export function calibrateRunLineProbability(probability) {
  const prob = Number(probability);
  if (!Number.isFinite(prob)) return prob;
  if (prob <= 0.52) return prob;
  return round(Math.min(0.58, 0.52 + (prob - 0.52) * 0.28), 4);
}

/** Ajuste de confianza cuando el modelo discrepa mucho del mercado. */
export function applyMarketAnchor(confidence, modelProbability, impliedProbability, threshold = MLB_MARKET_DISAGREE_PP) {
  if (!Number.isFinite(confidence) || !Number.isFinite(modelProbability) || !Number.isFinite(impliedProbability)) {
    return { confidence, marketDisagreement: false, marketGapPp: null };
  }
  const gap = Math.abs(modelProbability - impliedProbability);
  if (gap <= threshold) {
    return { confidence, marketDisagreement: false, marketGapPp: round(gap * 100, 1) };
  }
  const excessPp = gap - threshold;
  const penalty = Math.min(Math.round(excessPp * 120), 18);
  return {
    confidence: clamp(round(confidence - penalty, 1), 38, confidence),
    marketDisagreement: true,
    marketGapPp: round(gap * 100, 1),
  };
}

export function normalizeExpectedValueMlb(ev, cap = MLB_EV_ABS_CAP) {
  if (!Number.isFinite(ev)) return null;
  return calibrateForScoring(ev, { cap });
}

function recTotalsLine(rec) {
  const fromSelection = String(rec?.selection || "").match(/(\d+(?:\.\d+)?)/);
  if (fromSelection) return asNumber(fromSelection[1]);
  return asNumber(rec?.line ?? rec?.totalsLine);
}

/** Valida que un value-bet externo corresponda al mismo mercado/línea/lado. */
export function valueBetMatchesRecommendation(rec, vb) {
  if (!rec || !vb?.expectedValue) return false;

  const marketName = String(vb.market?.name || "").toLowerCase();
  const vbSide = String(vb.betSide || "").toLowerCase();
  const targetBetSide = String(
    rec.type === "moneyline" || rec.type === "runline"
      ? rec.teamSide || ""
      : String(rec.selection || "").toLowerCase().includes("más") || String(rec.selection || "").includes("(+)")
        ? "over"
        : "under"
  ).toLowerCase();

  const vbLine = asNumber(vb.market?.hdp ?? vb.market?.line ?? vb.line, NaN);
  const recLine = recTotalsLine(rec);

  if (rec.type === "moneyline") {
    return vbSide === targetBetSide && (marketName === "ml" || marketName.includes("moneyline") || marketName.includes("1x2"));
  }
  if (rec.type === "totals") {
    if (!(marketName.includes("total") || marketName.includes("over/under") || marketName === "over")) return false;
    if (vbSide && targetBetSide && vbSide !== targetBetSide) return false;
    if (Number.isFinite(recLine) && Number.isFinite(vbLine) && Math.abs(recLine - vbLine) > 0.01) return false;
    return true;
  }
  if (rec.type === "runline") {
    return marketName.includes("runline") && vbSide === targetBetSide;
  }
  if (rec.type === "team-total") {
    const sideToken = rec.teamSide === "home" ? "home" : "away";
    if (!marketName.includes("team total")) return false;
    if (!marketName.includes(sideToken)) return false;
    if (vbSide && targetBetSide && vbSide !== targetBetSide) return false;
    if (Number.isFinite(recLine) && Number.isFinite(vbLine) && Math.abs(recLine - vbLine) > 0.01) return false;
    return true;
  }
  return false;
}

/** Mejor cuota de totales alineada con la línea del mismo bookmaker. */
export function bestMlbTotalsQuote(bookmakers = {}, wantsOver, preferredLine = null) {
  let best = null;

  for (const [bookmaker, market] of Object.entries(bookmakers)) {
    const line = asNumber(market?.totals?.line, NaN);
    const odd = wantsOver ? asNumber(market?.totals?.over, NaN) : asNumber(market?.totals?.under, NaN);
    if (!Number.isFinite(odd) || !Number.isFinite(line)) continue;

    const lineMismatch =
      Number.isFinite(preferredLine) && Math.abs(line - preferredLine) > 0.01 ? 1 : 0;
    const score = odd - lineMismatch * 0.05;

    if (!best || score > best.score) {
      best = { bookmaker, odd, line, score };
    }
  }

  return best ? { bookmaker: best.bookmaker, odd: best.odd, line: best.line } : null;
}
