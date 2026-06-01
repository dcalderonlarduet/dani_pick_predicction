import { applyLineMovementToScore } from "./line-movement-engine.js";
import {
  MIN_RECOMMENDATION_CONFIDENCE,
  passesRecommendationConfidence,
  spreadScorePro,
} from "./pick-calibration.js";

export function impliedProbabilityFromDecimal(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1) return null;
  return 1 / o;
}

export function evFromProbability(prob, odds) {
  const p = Number(prob);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 1) return null;
  return p * o - 1;
}

function normalizeSideToken(value) {
  const side = String(value || "").trim().toLowerCase();
  if (["home", "local", "1"].includes(side)) return "home";
  if (["away", "visitante", "2"].includes(side)) return "away";
  if (["over", "mas", "más", "+", "o"].includes(side)) return "over";
  if (["under", "menos", "-", "u"].includes(side)) return "under";
  return side;
}

export function isDropAlignedWithPick(signals = {}, pickSide = null) {
  if (!signals?.dropping) return false;
  const dropSide = normalizeSideToken(signals.dropBetSide ?? signals.betSide ?? signals.side);
  const targetSide = normalizeSideToken(pickSide);
  if (!dropSide || !targetSide) return false;
  return dropSide === targetSide;
}

export function marketAnchorBlend(probModel, probMarket) {
  const pm = Number(probModel);
  const mk = Number(probMarket);
  if (!Number.isFinite(pm) || !Number.isFinite(mk)) {
    return { prob: pm, applied: false, confianzaDelta: 0 };
  }
  const gap = Math.abs(pm - mk);
  if (gap > 0.12) {
    return { prob: pm * 0.65 + mk * 0.35, applied: true, confianzaDelta: -10 };
  }
  if (gap <= 0.05) {
    return { prob: pm, applied: false, confianzaDelta: 5 };
  }
  return { prob: pm, applied: false, confianzaDelta: 0 };
}

export function computeDataQuality(flags = {}, meta = {}) {
  let q = 0;
  const hasMarket = Boolean(flags.mercado_actualizado || meta.oddsAvailable);
  if (flags.stats_espn_disponibles) q += 0.3;
  if (hasMarket) q += 0.12;
  else if (flags.stats_espn_disponibles) q += 0.08;
  if (flags.alineacion_confirmada || flags.lineup_confirmado) q += 0.12;
  if (flags.lesiones_confirmadas) q += 0.08;
  if (flags.h2h_relevante) q += 0.08;
  if (flags.clima_disponible) q += 0.06;
  if (flags.muestra_suficiente || (Number(meta.sampleGames) || 0) >= 5) q += 0.12;
  if (flags.freshness_ok || meta.freshnessOk) q += 0.07;
  if (flags.noticia_explica_movimiento) q += 0.03;
  if (flags.pitcher_confirmado === true) q += 0.05;
  if (flags.espn_win_prob_disponible) q += 0.03;
  return Math.min(1, q);
}

/** Cuenta grupos de señales independientes (no correlacionadas). */
export function countIndependentSignalGroups({ valueBet = false, dropping = false, gapBooks = 0, lmTipo = "NEUTRO" } = {}) {
  let groups = 0;
  const marketConsensus = Boolean(valueBet) || Boolean(dropping) || Number(gapBooks) > 0.08;
  if (marketConsensus) groups += 1;
  if (lmTipo && lmTipo !== "NEUTRO" && lmTipo !== "NOTICIA") groups += 1;
  return groups;
}

export function consistenciaPointsDeduped({ valueBet = false, dropping = false, gapBooks = 0, lmTipo = "NEUTRO" } = {}) {
  const groups = countIndependentSignalGroups({ valueBet, dropping, gapBooks, lmTipo });
  if (groups >= 2) return 12;
  if (groups === 1) return 6;
  return 0;
}

export function calcularScore({
  ev_modelo = 0,
  ev_externo_coincide = false,
  dropping_alineado = false,
  gap_books = 0,
  cuota_en_rango = false,
  dataQuality = 0,
  n_senales = 0,
  lm = null,
  pick_side = null,
  confianza = 50,
}) {
  let score = 0;
  const ev = Number(ev_modelo) || 0;

  if (ev >= 0.1) score += 35;
  else if (ev >= 0.07) score += 28;
  else if (ev >= 0.05) score += 22;
  else if (ev >= 0.03) score += 15;

  // Consenso de mercado: una sola bonificación (ev_externo > dropping > gap)
  const marketConsensus =
    Boolean(ev_externo_coincide) || Boolean(dropping_alineado) || Number(gap_books) > 0.1;
  if (marketConsensus) {
    if (ev_externo_coincide) score += 10;
    else if (dropping_alineado) score += 8;
    else score += 7;
  }

  if (cuota_en_rango) score += 10;
  score += Number(dataQuality) * 15;
  score += consistenciaPointsDeduped({
    valueBet: ev_externo_coincide,
    dropping: dropping_alineado,
    gapBooks: gap_books,
    lmTipo: lm?.tipo,
  });

  // Puntos base por calidad del modelo deportivo.
  // Permite que picks con buen modelo pero sin señales externas
  // puedan alcanzar umbrales calibrados. Cap 12 pts.
  const modelBasePoints = Math.min(12, Math.round(Number(dataQuality) * 14));
  score += modelBasePoints;

  const lmResult = applyLineMovementToScore({
    score,
    confianza,
    lm,
    pickSide: pick_side,
    dropping_alineado,
    valueBet_aligned: ev_externo_coincide,
  });

  if (lmResult.discarded) {
    return { score: 0, confianza: lmResult.confianza, discarded: lmResult.discarded };
  }

  const marketSignals =
    (ev_externo_coincide ? 1 : 0) + (dropping_alineado ? 1 : 0) + (Number(gap_books) > 0.08 ? 1 : 0);
  const displayScore = spreadScorePro(lmResult.score, {
    ev,
    confidence: lmResult.confianza,
    dataQuality,
    marketSignals,
  });

  return { score: displayScore, confianza: lmResult.confianza, discarded: null };
}

/** Gates explícitos de filtro de valor (recomendación profesional). */
export function evaluateValueGates({
  ev,
  edge = null,
  dataQuality = 0,
  cuota_en_rango = false,
  lm = null,
  pickSide = null,
  probModel = null,
  probMarket = null,
  requireEdge = false,
  minDataQuality = 0.65,
  minEv = 0.03,
  maxModelMarketGap = 0.18,
  minEdge = 0.04,
  confidence = null,
  minConfidence = MIN_RECOMMENDATION_CONFIDENCE,
  flags = null,
}) {
  const failures = [];
  if (!cuota_en_rango) failures.push("cuota_fuera_rango");
  if (ev == null || ev < minEv) failures.push("ev_bajo");
  if (confidence != null && !passesRecommendationConfidence(confidence, minConfidence)) {
    failures.push("confianza_baja");
  }

  let effectiveMinDataQuality = minDataQuality;
  if (flags?.datos_parciales && ev != null && ev >= 0.06) {
    effectiveMinDataQuality = Math.max(minDataQuality - 0.15, 0.35);
  }
  if (Number(dataQuality) < effectiveMinDataQuality) failures.push("data_quality_baja");
  if (
    lm?.tipo === "RLM" &&
    lm.confianza === "MUY_ALTA" &&
    lm.lado_sharp &&
    pickSide &&
    lm.lado_sharp !== pickSide
  ) {
    failures.push("rlm_contra");
  }
  if (
    probModel != null &&
    probMarket != null &&
    Math.abs(Number(probModel) - Number(probMarket)) > maxModelMarketGap
  ) {
    failures.push("modelo_vs_mercado");
  }
  if (requireEdge && (edge == null || Math.abs(Number(edge)) < minEdge)) {
    failures.push("edge_bajo");
  }
  return {
    passed: failures.length === 0,
    failures,
    gates: {
      minDataQuality: effectiveMinDataQuality,
      minEv,
      maxModelMarketGap,
      minEdge,
      minConfidence,
    },
  };
}

export function logValueGateFailure(prefix, {
  game = null,
  gameId = null,
  marketKey = null,
  score = null,
  scoreResult = null,
  ev = null,
  evRaw = null,
  dataQuality = null,
  cuota_en_rango = null,
  edge = null,
  valueGates = null,
} = {}) {
  if (process.env.DEBUG_GATES !== "true") return;
  if (!valueGates || valueGates.passed) return;

  const id = gameId ?? game?.eventId ?? game?.id ?? game?.gamePk ?? "";
  const market = marketKey ?? "";
  console.log(`[${prefix}-GATE-FAIL] ${id} ${market}`.trim(), {
    score: score ?? scoreResult?.score ?? null,
    ev,
    evRaw,
    dataQuality,
    cuotaEnRango: cuota_en_rango,
    edge,
    failures: valueGates.failures,
    gates: valueGates.gates,
  });
}

export function resolvePickColor({
  score,
  ev,
  edge = null,
  cuota_en_rango,
  umbralVerde = 72,
  umbralAmarillo = 58,
  evVerde = 0.05,
  evAmarillo = 0.03,
  edgeVerde = 0.05,
  edgeAmarillo = 0.03,
  requireEdge = false,
}) {
  if (!cuota_en_rango) return "gris";
  const edgeOkVerde = !requireEdge || (edge != null && Math.abs(Number(edge)) >= edgeVerde);
  const edgeOkAmarillo = !requireEdge || (edge != null && Math.abs(Number(edge)) >= edgeAmarillo);
  if (score >= umbralVerde && ev >= evVerde && edgeOkVerde) return "verde";
  if (score >= umbralAmarillo && ev >= evAmarillo && edgeOkAmarillo) return "amarillo";
  return "gris";
}

/** Sigma dinámico desde últimos totales/puntos del equipo (mín. 5 partidos). */
export function computeDynamicSigma(teamSide, fallbackSigma, { minSample = 5, minSigma = 3 } = {}) {
  const scores =
    teamSide?.form?.recentTotals ||
    teamSide?.form?.recentScores ||
    teamSide?.form?.lastGames?.map((game) => Number(game?.points ?? game?.total)).filter(Number.isFinite) ||
    [];
  if (!Array.isArray(scores) || scores.length < minSample) return fallbackSigma;

  const mean = scores.reduce((acc, value) => acc + value, 0) / scores.length;
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  return Math.max(minSigma, Math.sqrt(variance));
}

export function monteCarloTotal({ muHome, muAway, sigmaHome, sigmaAway, line, iterations = 5000 }) {
  const muH = Number(muHome);
  const muA = Number(muAway);
  const sH = Math.max(3, Number(sigmaHome) || 12);
  const sA = Math.max(3, Number(sigmaAway) || 12);
  const target = Number(line);
  if (!Number.isFinite(muH) || !Number.isFinite(muA) || !Number.isFinite(target)) {
    return { probOver: null, mean: null };
  }

  let overs = 0;
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    const h = normalSample(muH, sH);
    const a = normalSample(muA, sA);
    const total = h + a;
    sum += total;
    if (total > target) overs += 1;
  }
  return { probOver: overs / iterations, mean: sum / iterations };
}

export function monteCarloSingleOver({ mu, sigma, line, iterations = 5000 }) {
  const m = Number(mu);
  const s = Math.max(2, Number(sigma) || 4);
  const target = Number(line);
  if (!Number.isFinite(m) || !Number.isFinite(target)) {
    return { probOver: null, mean: null };
  }

  let overs = 0;
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    const value = normalSample(m, s);
    sum += value;
    if (value > target) overs += 1;
  }
  return { probOver: overs / iterations, mean: sum / iterations };
}

/** CLV para totals: línea de cierre vs línea tomada (positivo = beat the close). */
export function computeClvTotal({ side, lineTaken, lineClose }) {
  const taken = Number(lineTaken);
  const close = Number(lineClose);
  if (!Number.isFinite(taken) || !Number.isFinite(close)) return null;
  if (side === "over") return close - taken;
  if (side === "under") return taken - close;
  return null;
}

/** CLV para moneyline vía cuota de cierre. */
export function computeClvMoneyline({ oddsTaken, oddsClose }) {
  const taken = Number(oddsTaken);
  const close = Number(oddsClose);
  if (!Number.isFinite(taken) || taken <= 1 || !Number.isFinite(close) || close <= 1) return null;
  return close - taken;
}

function normalSample(mu, sigma) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mu + z * sigma;
}
