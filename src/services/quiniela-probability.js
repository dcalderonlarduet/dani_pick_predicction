import { clamp, round } from "../utils/math.js";

export const MAX_QUINIELA_DOUBLES = 4;
export const FIJO_MIN_TOP_PROB = 0.50;
export const FIJO_MIN_EDGE = 0.12;
export const FIJO_MIN_CONFIDENCE = 0.70;
export const LOW_DATA_QUALITY = 0.45;
export const MODEL_MARKET_DISAGREE_THRESHOLD = 0.12;

export function normalizeProbs(p1, px, p2) {
  const a = Number(p1);
  const b = Number(px);
  const c = Number(p2);
  if (![a, b, c].every((v) => Number.isFinite(v) && v >= 0)) return null;
  const sum = a + b + c;
  if (sum < 0.5) return null;
  return {
    p1: round(a / sum, 3),
    px: round(b / sum, 3),
    p2: round(c / sum, 3),
  };
}

export function impliedProbsFromMlOdds(mlOdds) {
  if (!mlOdds) return null;
  const home = Number(mlOdds.home);
  const draw = Number(mlOdds.draw);
  const away = Number(mlOdds.away);
  if (![home, draw, away].some((v) => Number.isFinite(v) && v > 1)) return null;
  const raw = {
    p1: home > 1 ? 1 / home : 0,
    px: draw > 1 ? 1 / draw : 0,
    p2: away > 1 ? 1 / away : 0,
  };
  return normalizeProbs(raw.p1, raw.px, raw.p2);
}

function readNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace("%", "").replace(",", ".").trim());
      if (Number.isFinite(parsed)) return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
    }
  }
  return null;
}

function poissonPmf(k, lambda) {
  if (k < 0 || !Number.isFinite(lambda) || lambda <= 0) return 0;
  let probability = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) {
    probability *= lambda / i;
  }
  return probability;
}

function readGoalValue(...values) {
  const value = readNumber(...values);
  return Number.isFinite(value) && value >= 0 && value <= 8 ? value : null;
}

function fallbackPoissonProbsFromGoals(ctx = {}) {
  const homeLambda = readGoalValue(ctx.lambda_home) ?? (
    readGoalValue(ctx.home_goals_for, ctx.goles_favor_local) != null || readGoalValue(ctx.away_goals_against) != null
      ? ((readGoalValue(ctx.home_goals_for, ctx.goles_favor_local) ?? 1.25) + (readGoalValue(ctx.away_goals_against) ?? 1.25)) / 2
      : null
  );
  const awayLambda = readGoalValue(ctx.lambda_away) ?? (
    readGoalValue(ctx.away_goals_for, ctx.goles_favor_away) != null || readGoalValue(ctx.home_goals_against) != null
      ? ((readGoalValue(ctx.away_goals_for, ctx.goles_favor_away) ?? 1.05) + (readGoalValue(ctx.home_goals_against) ?? 1.05)) / 2
      : null
  );
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;

  let p1 = 0;
  let px = 0;
  let p2 = 0;
  for (let h = 0; h <= 7; h += 1) {
    for (let a = 0; a <= 7; a += 1) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (h > a) p1 += p;
      else if (h === a) px += p;
      else p2 += p;
    }
  }
  return normalizeProbs(p1, px, p2);
}

function applyAttackStrengthAdjust(probs, ctx = {}) {
  const homeAttack = readNumber(ctx.home_attack_strength, ctx.model_home_attack_strength);
  const awayAttack = readNumber(ctx.away_attack_strength, ctx.model_away_attack_strength);
  if (!probs || !Number.isFinite(homeAttack) || !Number.isFinite(awayAttack)) return probs;
  const delta = clamp((homeAttack - awayAttack) * 0.08, -0.04, 0.04);
  return normalizeProbs(
    clamp(probs.p1 + delta, 0.05, 0.92),
    probs.px,
    clamp(probs.p2 - delta, 0.05, 0.92)
  ) || probs;
}

export function getModelProbsFromBundle(bundle = {}) {
  const ctx = bundle.footballCtx || {};
  const mm = bundle.matchModel || {};

  const fromCtx = normalizeProbs(ctx.model_home_prob, ctx.model_draw_prob, ctx.model_away_prob);
  if (fromCtx) {
    return { ...applyAttackStrengthAdjust(fromCtx, ctx), source: ctx.source || bundle.dataSource || "football-ctx" };
  }

  const p1 = mm.model_home_prob;
  const p2 = mm.model_away_prob;
  const px = mm.model_draw_prob;
  if (p1 != null && p2 != null) {
    const pxEff = px != null ? px : clamp(1 - p1 - p2, 0.10, 0.35);
    const normalized = normalizeProbs(p1, pxEff, p2);
    if (normalized) return { ...applyAttackStrengthAdjust(normalized, ctx), source: bundle.dataSource || "match-model" };
  }

  const fallback = fallbackPoissonProbsFromGoals(ctx);
  if (fallback) return { ...applyAttackStrengthAdjust(fallback, ctx), source: `${ctx.source || bundle.dataSource || "football-ctx"}:poisson-fallback` };
  return null;
}

export function computeDataQuality(bundle = {}) {
  const hasModel = Boolean(getModelProbsFromBundle(bundle));
  const hasMarket = Boolean(impliedProbsFromMlOdds(bundle.mlOdds));
  const ctx = bundle.footballCtx || {};
  const src = String(ctx.source || bundle.dataSource || "").toLowerCase();
  const isPriors = bundle.isPlaceholder || src.includes("priors") || src === "no-data";
  const hasGoalData = Number.isFinite(readGoalValue(ctx.home_goals_for, ctx.goles_favor_local)) && Number.isFinite(readGoalValue(ctx.away_goals_for, ctx.goles_favor_away));
  const hasDefData = Number.isFinite(readGoalValue(ctx.home_goals_against)) && Number.isFinite(readGoalValue(ctx.away_goals_against));
  const hasFormData =
    (Array.isArray(ctx.forma) && ctx.forma.length > 0) ||
    (Array.isArray(ctx.home_recent_matches) && ctx.home_recent_matches.length > 0) ||
    (Array.isArray(ctx.away_recent_matches) && ctx.away_recent_matches.length > 0);
  const hasAtkStr = Number.isFinite(readNumber(ctx.home_attack_strength, ctx.model_home_attack_strength)) && Number.isFinite(readNumber(ctx.away_attack_strength, ctx.model_away_attack_strength));
  const hasH2h = [ctx.h2h_home_win_rate, ctx.h2h_draw_rate, ctx.h2h_away_win_rate, ctx.h2h_over25_rate, ctx.h2h_btts_rate].some((value) => Number.isFinite(readNumber(value)));
  const lineupsOk = Boolean(
    ctx.lineup_confirmed ||
    bundle.lineups?.bothConfirmed ||
    (ctx.home_lineup_confirmed && ctx.away_lineup_confirmed)
  );
  const injuries = Number(ctx.injuries ?? bundle.injuries ?? 0);

  let score = 0;
  if (hasModel) score += 0.35;
  if (hasMarket) score += 0.25;
  if (/espn|api-sports/.test(src)) score += 0.15;
  if (hasGoalData) score += 0.08;
  if (hasDefData) score += 0.06;
  if (hasFormData) score += 0.07;
  if (hasAtkStr) score += 0.06;
  if (hasH2h) score += 0.05;
  if (lineupsOk) score += 0.10;
  if (!bundle.isPlaceholder) score += 0.10;
  if (injuries <= 2) score += 0.05;
  if (isPriors) score *= 0.45;
  return round(clamp(score, 0, 1), 2);
}

function maxSignDisagreement(model, market) {
  if (!model || !market) return 0;
  return Math.max(
    Math.abs(model.p1 - market.p1),
    Math.abs(model.px - market.px),
    Math.abs(model.p2 - market.p2)
  );
}

function recentFormRatio(entries = []) {
  const usable = entries.slice(0, 6)
    .map((entry) => String(typeof entry === "string" ? entry : entry?.result || "").toUpperCase())
    .filter((value) => value === "W" || value === "D" || value === "L");
  if (!usable.length) return null;
  let points = 0;
  let max = 0;
  usable.forEach((result, index) => {
    const weight = 0.8 ** index;
    points += weight * (result === "W" ? 3 : result === "D" ? 1 : 0);
    max += weight * 3;
  });
  return max > 0 ? points / max : null;
}

function applyRecentFormAdjust(probs, bundle = {}) {
  const ctx = bundle.footballCtx || {};
  const homeForm = recentFormRatio(ctx.home_recent_matches || ctx.home_forma || ctx.forma || []);
  const awayForm = recentFormRatio(ctx.away_recent_matches || ctx.away_forma || []);
  if (!Number.isFinite(homeForm) || !Number.isFinite(awayForm)) return probs;
  const delta = clamp((homeForm - awayForm) * 0.08, -0.04, 0.04);
  return normalizeProbs(
    clamp(probs.p1 + delta, 0.05, 0.92),
    probs.px,
    clamp(probs.p2 - delta, 0.05, 0.92)
  ) || probs;
}

function applyOddsMoveAdjust(probs, oddsDrop, bundle = {}) {
  if (!probs) return probs;
  let adjusted = applyRecentFormAdjust(probs, bundle);
  if (!oddsDrop?.betSide || Number(oddsDrop.drop12h || 0) < 8) return adjusted;
  const side = String(oddsDrop.betSide).toLowerCase();
  const boost = 0.015;
  adjusted = { ...adjusted };
  if (side === "home") adjusted.p1 = clamp(adjusted.p1 + boost, 0.05, 0.92);
  else if (side === "draw") adjusted.px = clamp(adjusted.px + boost, 0.05, 0.92);
  else if (side === "away") adjusted.p2 = clamp(adjusted.p2 + boost, 0.05, 0.92);
  return normalizeProbs(adjusted.p1, adjusted.px, adjusted.p2) || probs;
}

function quinielaSignToLmSide(sign) {
  if (sign === "1") return "home";
  if (sign === "2") return "away";
  return null;
}

export function applyLineMovementToQuiniela(probs, bundle = {}) {
  const lm = bundle.lineMovementMl || bundle.lineMovement;
  if (!probs || !lm || lm.tipo === "NEUTRO" || lm.tipo === "NOTICIA") {
    return {
      probs,
      confidenceDelta: 0,
      lineTrapOnFavorite: false,
      forceDouble: false,
      lineMovement: lm || null,
      lineMovementNote: null,
    };
  }

  const signs = [
    { sign: "1", p: probs.p1 },
    { sign: "X", p: probs.px },
    { sign: "2", p: probs.p2 },
  ].sort((a, b) => b.p - a.p);
  const topSign = signs[0]?.sign;
  const topLmSide = quinielaSignToLmSide(topSign);

  let adjusted = { ...probs };
  let confidenceDelta = 0;
  let forceDouble = false;
  let lineTrapOnFavorite = false;
  let lineMovementNote = null;

  if (lm.tipo === "LINEA_TRAMPA" && topLmSide && lm.lado_publico === topLmSide) {
    if (topSign === "1") adjusted.p1 = clamp(adjusted.p1 - 0.08, 0.05, 0.92);
    else if (topSign === "2") adjusted.p2 = clamp(adjusted.p2 - 0.08, 0.05, 0.92);
    adjusted.px = clamp(adjusted.px + 0.04, 0.05, 0.92);
    adjusted = normalizeProbs(adjusted.p1, adjusted.px, adjusted.p2) || probs;
    confidenceDelta -= 0.08;
    forceDouble = true;
    lineTrapOnFavorite = true;
    lineMovementNote =
      "Trampa detectada: mucha gente va al favorito y la cuota empeoró; el modelo prefiere doble en quiniela.";
  } else if (lm.tipo === "RLM" && topLmSide && lm.lado_sharp === topLmSide) {
    if (topSign === "1") adjusted.p1 = clamp(adjusted.p1 + 0.03, 0.05, 0.92);
    else if (topSign === "2") adjusted.p2 = clamp(adjusted.p2 + 0.03, 0.05, 0.92);
    adjusted = normalizeProbs(adjusted.p1, adjusted.px, adjusted.p2) || probs;
    confidenceDelta += 0.05;
    lineMovementNote = "Reverse line movement: el dinero inteligente apoya al favorito del modelo.";
  } else if (lm.tipo === "RLM" && topLmSide && lm.lado_sharp && lm.lado_sharp !== topLmSide) {
    confidenceDelta -= 0.04;
    forceDouble = true;
    lineMovementNote = "RLM en contra del favorito: el mercado se mueve hacia el otro bando.";
  }

  return {
    probs: adjusted,
    confidenceDelta,
    lineTrapOnFavorite,
    forceDouble,
    lineMovement: lm,
    lineMovementNote,
  };
}

export function buildQuinielaFinalProbs(bundle = {}) {
  const modelEntry = getModelProbsFromBundle(bundle);
  const model = modelEntry ? { p1: modelEntry.p1, px: modelEntry.px, p2: modelEntry.p2 } : null;
  const market = impliedProbsFromMlOdds(bundle.mlOdds);
  const dataQuality = computeDataQuality(bundle);

  if (dataQuality < LOW_DATA_QUALITY && !model && !market) {
    return {
      probs: null,
      uncertain: true,
      dataQuality,
      confidence: 0,
      method: "no-data",
      model,
      market,
      disagreement: 0,
      modelSource: modelEntry?.source || null,
    };
  }

  if (!model && market) {
    let probs = applyOddsMoveAdjust(market, bundle.oddsDrop, bundle);
    const lmAdjust = applyLineMovementToQuiniela(probs, bundle);
    probs = lmAdjust.probs;
    return {
      probs,
      uncertain: dataQuality < LOW_DATA_QUALITY,
      dataQuality,
      confidence: round(clamp(dataQuality * 0.82 + lmAdjust.confidenceDelta, 0, 0.9), 2),
      method: "market-only",
      model: null,
      market,
      disagreement: 0,
      modelSource: null,
      lineMovement: lmAdjust.lineMovement,
      lineTrapOnFavorite: lmAdjust.lineTrapOnFavorite,
      forceDouble: lmAdjust.forceDouble,
      lineMovementNote: lmAdjust.lineMovementNote,
    };
  }

  if (model && !market) {
    let probs = applyOddsMoveAdjust(model, bundle.oddsDrop, bundle);
    const lmAdjust = applyLineMovementToQuiniela(probs, bundle);
    probs = lmAdjust.probs;
    return {
      probs,
      uncertain: dataQuality < LOW_DATA_QUALITY,
      dataQuality,
      confidence: round(clamp(dataQuality * 0.78 + lmAdjust.confidenceDelta, 0, 0.88), 2),
      method: "model-only",
      model,
      market: null,
      disagreement: 0,
      modelSource: modelEntry?.source || null,
      lineMovement: lmAdjust.lineMovement,
      lineTrapOnFavorite: lmAdjust.lineTrapOnFavorite,
      forceDouble: lmAdjust.forceDouble,
      lineMovementNote: lmAdjust.lineMovementNote,
    };
  }

  const disagreement = maxSignDisagreement(model, market);
  let wModel = 0.65;
  let wMarket = 0.35;
  if (disagreement > MODEL_MARKET_DISAGREE_THRESHOLD) {
    wModel = 0.40;
    wMarket = 0.60;
  }
  if (dataQuality < LOW_DATA_QUALITY) {
    wModel = 0.30;
    wMarket = 0.70;
  }

  let probs = normalizeProbs(
    wModel * model.p1 + wMarket * market.p1,
    wModel * model.px + wMarket * market.px,
    wModel * model.p2 + wMarket * market.p2
  );
  probs = applyOddsMoveAdjust(probs, bundle.oddsDrop, bundle);
  const lmAdjust = applyLineMovementToQuiniela(probs, bundle);
  probs = lmAdjust.probs;

  const confidence = round(
    clamp(dataQuality * (1 - disagreement * 0.85) + lmAdjust.confidenceDelta, 0, 0.95),
    2
  );

  return {
    probs,
    uncertain:
      dataQuality < LOW_DATA_QUALITY ||
      disagreement > MODEL_MARKET_DISAGREE_THRESHOLD ||
      lmAdjust.forceDouble,
    dataQuality,
    confidence,
    method: "blend",
    model,
    market,
    disagreement: round(disagreement, 3),
    weights: { wModel, wMarket },
    modelSource: modelEntry?.source || null,
    lineMovement: lmAdjust.lineMovement,
    lineTrapOnFavorite: lmAdjust.lineTrapOnFavorite,
    forceDouble: lmAdjust.forceDouble,
    lineMovementNote: lmAdjust.lineMovementNote,
  };
}

export function signsFromProbabilities(probs) {
  if (!probs) return [];
  return [
    { sign: "1", p: probs.p1 },
    { sign: "X", p: probs.px },
    { sign: "2", p: probs.p2 },
  ].sort((a, b) => b.p - a.p);
}

export function computeRiskScore(finalResult, signs) {
  const top = signs[0];
  if (!top) return 1;
  const disagreement = Number(finalResult?.disagreement || 0);
  const px = signs.find((s) => s.sign === "X")?.p || 0;
  const drawRisk = px >= 0.30 ? 0.15 : px >= 0.26 ? 0.08 : 0;
  const dataUncertainty = 1 - Number(finalResult?.dataQuality || 0);
  const upsetProb = 1 - top.p;
  const uncertainBoost = finalResult?.uncertain ? 0.08 : 0;
  const raw =
    upsetProb * 0.45 +
    disagreement * 0.25 +
    drawRisk +
    dataUncertainty * 0.15 +
    uncertainBoost;
  // Normalizar a [0, 1]: los componentes pueden sumar hasta ~1.08
  return round(Math.min(1, Math.max(0, raw)), 3);
}

export function evaluateFijoDobleOptions(signs, finalResult) {
  const top = signs[0];
  const second = signs[1];
  const third = signs[2];
  const confidence = Number(finalResult?.confidence || 0);
  const disagreement = Number(finalResult?.disagreement || 0);
  const dataQuality = Number(finalResult?.dataQuality || 0);

  const fijoVentajaPp = round((top.p - second.p) * 100, 1);
  const dobleVentajaPp = round((top.p + second.p - third.p) * 100, 1);
  const ventajaMayor = fijoVentajaPp >= dobleVentajaPp ? "fijo" : "doble";

  const ganadorClaro =
    top.p >= FIJO_MIN_TOP_PROB &&
    top.p - second.p >= FIJO_MIN_EDGE &&
    confidence >= FIJO_MIN_CONFIDENCE &&
    disagreement <= MODEL_MARKET_DISAGREE_THRESHOLD &&
    dataQuality >= LOW_DATA_QUALITY &&
    !finalResult?.uncertain &&
    !finalResult?.forceDouble &&
    !finalResult?.lineTrapOnFavorite;

  return {
    fijo: { pick: top.sign, ventajaPp: fijoVentajaPp, prob: top.p },
    doble: { pick: `${top.sign}${second.sign}`, ventajaPp: dobleVentajaPp, prob: round(top.p + second.p, 3) },
    ventajaMayor,
    ventajaMayorPp: ventajaMayor === "fijo" ? fijoVentajaPp : dobleVentajaPp,
    ganadorClaro,
    isFijoEligible: ganadorClaro,
    sinGanadorClaro: !ganadorClaro,
    needsDoubleScore: round(computeRiskScore(finalResult, signs) + (finalResult?.forceDouble ? 0.12 : 0), 3),
    confidence,
    dataQuality,
    disagreement,
  };
}

/** Asigna un único signo (fijo) por partido: siempre la opción fijo del modelo, sin dobles. */
export function applyQuinielaFijoOnly(candidates) {
  return candidates.map((item) => ({
    ...item,
    type: "fijo",
    pick: item.options.fijo.pick,
    ventajaPp: item.options.fijo.ventajaPp,
    fijoForzadoPorCupo: false,
  }));
}

export function applyQuinielaDoubleCap(candidates) {
  const ranked = candidates
    .map((item, index) => ({
      index,
      riskScore: item.options.needsDoubleScore,
      eligible: !item.options.ganadorClaro,
    }))
    .filter((item) => item.eligible)
    .sort((a, b) => b.riskScore - a.riskScore);

  const doubleSlots = ranked.slice(0, MAX_QUINIELA_DOUBLES).map((item) => item.index);
  const doubleSet = new Set(doubleSlots);

  return candidates.map((item) => {
    const type = doubleSet.has(item.index) ? "doble" : "fijo";
    const pick = type === "fijo" ? item.options.fijo.pick : item.options.doble.pick;
    const ventajaPp = type === "fijo" ? item.options.fijo.ventajaPp : item.options.doble.ventajaPp;
    const fijoForzadoPorCupo = type === "fijo" && item.options.sinGanadorClaro;
    return { ...item, type, pick, ventajaPp, fijoForzadoPorCupo };
  });
}
