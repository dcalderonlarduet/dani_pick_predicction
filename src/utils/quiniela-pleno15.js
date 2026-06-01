/**
 * Pleno al 15 — marcador por goles de cada equipo (0, 1, 2, M).
 * M = 3 o más goles. Formato boleto: "1-M" (local-visitante).
 */
import { clamp, round } from "./math.js";

export const PLENO_GOAL_SIGNS = ["0", "1", "2", "M"];

export function goalsExpectedToPlenoSign(goals) {
  const g = Number(goals);
  if (!Number.isFinite(g) || g < 0) return "1";
  if (g >= 2.75) return "M";
  if (g >= 1.75) return "2";
  if (g >= 0.75) return "1";
  return "0";
}

export function formatPleno15Pick(homeSign, awaySign) {
  return `${homeSign}-${awaySign}`;
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) term *= lambda / i;
  return term;
}

/** Probabilidad de marcar exactamente el signo quiniela (0, 1, 2, M). */
export function plenoSignProbability(sign, lambda) {
  const lam = Math.max(0.05, Number(lambda) || 0);
  if (sign === "M") {
    let p = 0;
    for (let k = 3; k <= 10; k += 1) p += poissonPmf(k, lam);
    return clamp(p, 0, 1);
  }
  const k = Number(sign);
  if (!Number.isFinite(k) || k < 0 || k > 2) return 0;
  return poissonPmf(k, lam);
}

function bestPlenoSign(probsBySign) {
  return PLENO_GOAL_SIGNS.reduce((best, sign) =>
    (probsBySign[sign] || 0) > (probsBySign[best] || 0) ? sign : best
  , "1");
}

export function resolvePlenoLambdas(bundle = {}, finalResult = {}) {
  const ctx = bundle?.footballCtx || {};
  const mm = bundle?.matchModel || {};

  let lambdaHome = Number(ctx.model_goals_home ?? mm.model_goals_home);
  let lambdaAway = Number(ctx.model_goals_away ?? mm.model_goals_away);

  if (Number.isFinite(lambdaHome) && Number.isFinite(lambdaAway) && lambdaHome >= 0 && lambdaAway >= 0) {
    return {
      lambdaHome: round(lambdaHome, 2),
      lambdaAway: round(lambdaAway, 2),
      source: "model-goals-split",
    };
  }

  const homeFor = Number(ctx.goles_favor_local ?? ctx.home_goals_for);
  const awayFor = Number(ctx.goles_favor_away ?? ctx.away_goals_for);
  if (Number.isFinite(homeFor) && Number.isFinite(awayFor) && homeFor >= 0 && awayFor >= 0) {
    return {
      lambdaHome: round(homeFor, 2),
      lambdaAway: round(awayFor, 2),
      source: "team-scoring-form",
    };
  }

  const total = Number(ctx.expected_goals ?? mm.expectedGoals ?? mm.expected_goals);
  const probs = finalResult?.probs;
  if (Number.isFinite(total) && total > 0 && probs) {
    const p1 = probs.p1 || 0.33;
    const p2 = probs.p2 || 0.33;
    const px = probs.px || 0.34;
    const denom = p1 + p2 + px || 1;
    const homeShare = clamp((p1 + px * 0.42) / denom, 0.22, 0.78);
    const awayShare = clamp((p2 + px * 0.42) / denom, 0.22, 0.78);
    const sumShare = homeShare + awayShare || 1;
    return {
      lambdaHome: round((total * homeShare) / sumShare, 2),
      lambdaAway: round((total * awayShare) / sumShare, 2),
      source: "expected-goals-1x2-split",
    };
  }

  return { lambdaHome: 1.25, lambdaAway: 1.05, source: "default-league" };
}

export function buildPleno15Distribution(lambda) {
  const dist = {};
  for (const sign of PLENO_GOAL_SIGNS) {
    dist[sign] = round(plenoSignProbability(sign, lambda) * 100, 1);
  }
  return dist;
}

export function buildPleno15Proposal({ home, away, bundle, finalResult } = {}) {
  const homeName = String(home || "").trim();
  const awayName = String(away || "").trim();
  if (!homeName || !awayName) return null;

  const { lambdaHome, lambdaAway, source } = resolvePlenoLambdas(bundle, finalResult);
  const distHome = {};
  const distAway = {};
  for (const sign of PLENO_GOAL_SIGNS) {
    distHome[sign] = plenoSignProbability(sign, lambdaHome);
    distAway[sign] = plenoSignProbability(sign, lambdaAway);
  }

  const pickHome = bestPlenoSign(distHome);
  const pickAway = bestPlenoSign(distAway);
  const pick = formatPleno15Pick(pickHome, pickAway);
  const jointProb = (distHome[pickHome] || 0) * (distAway[pickAway] || 0);
  const dataQuality = round((finalResult?.dataQuality ?? 0) * 100, 0);
  const method = finalResult?.method || "no-data";

  const pct = (sign, dist) => `${sign} ${round((dist[sign] || 0) * 100, 0)}%`;
  const explicacion =
    `Pleno al 15: ${pick} (${homeName} ${pickHome} · ${awayName} ${pickAway}). ` +
    `Goles esperados λ ${round(lambdaHome, 1)}-${round(lambdaAway, 1)} (total ${round(lambdaHome + lambdaAway, 1)}). ` +
    `Distribución local ${PLENO_GOAL_SIGNS.map((s) => pct(s, distHome)).join(" · ")}. ` +
    `Visitante ${PLENO_GOAL_SIGNS.map((s) => pct(s, distAway)).join(" · ")}. ` +
    `Fuente goles: ${source}; 1X2: ${method}.`;

  return {
    order: 15,
    partido: `${homeName} vs ${awayName}`,
    home: homeName,
    away: awayName,
    pick,
    pickHome,
    pickAway,
    label: pick,
    tipo: "pleno15",
    confianza: round(jointProb * 100, 1),
    lambdaHome,
    lambdaAway,
    expectedGoalsTotal: round(lambdaHome + lambdaAway, 2),
    distribucion: {
      home: buildPleno15Distribution(lambdaHome),
      away: buildPleno15Distribution(lambdaAway),
    },
    metodo: method,
    fuenteGoles: source,
    dataQuality,
    explicacion,
    signosAyuda: "0 = 0 goles · 1 = 1 gol · 2 = 2 goles · M = 3 o más",
  };
}
