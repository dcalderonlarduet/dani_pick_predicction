import { monteCarloSingleOver, monteCarloTotal, computeDynamicSigma } from "./pro-odds-scoring.js";

const NFL_SIGMA_GAME = 7;
const NFL_SIGMA_1H = 4.5;
const NFL_SIGMA_TEAM = 4.5;
const MC_ITERATIONS = 5000;

export const FACTOR_WEIGHTS_NFL_1H = {
  scripted_offense_1h: 0.22,
  pts_1h_anotados: 0.2,
  pts_1h_concedidos: 0.2,
  ritmo_plays_1h: 0.12,
  qb_status: 0.12,
  clima: 0.08,
  h2h_1h: 0.06,
};

export const FACTOR_WEIGHTS_NFL_TEAM = {
  pts_anotados_temp: 0.2,
  def_rival_pts: 0.2,
  oline_vs_dline: 0.15,
  qb_performance: 0.15,
  red_zone_eff: 0.1,
  lesiones_skill: 0.1,
  clima: 0.05,
  fatiga_calendario: 0.05,
};

export const FACTOR_WEIGHTS_NFL_ML = {
  power_rating: 0.25,
  forma_reciente: 0.2,
  qb_status: 0.2,
  matchup_yds: 0.15,
  home_viaje: 0.1,
  tabla_context: 0.05,
  h2h_divisional: 0.05,
};

function matchupDefFactor(defRtg, avgDef) {
  if (defRtg > avgDef + 2) return 0.88;
  if (defRtg < avgDef - 2) return 1.12;
  return 1;
}

export function projectNflFirstHalfTotal(ctx) {
  const avg = ctx.averages;
  const clima = ctx.clima_factor ?? 1;
  const homePts = (ctx.home?.form?.pts1h ?? avg.pts1h) * matchupDefFactor(ctx.away?.form?.ptsPerGame ?? avg.defRtg, avg.defRtg);
  const awayPts = (ctx.away?.form?.pts1h ?? avg.pts1h) * matchupDefFactor(ctx.home?.form?.ptsPerGame ?? avg.defRtg, avg.defRtg);
  const homeQb = ctx.home?.qb_factor ?? 1;
  const awayQb = ctx.away?.qb_factor ?? 1;
  const total = (homePts * homeQb + awayPts * awayQb) * clima;
  return {
    total,
    muHome: homePts * homeQb * clima,
    muAway: awayPts * awayQb * clima,
    factors_used: Object.keys(FACTOR_WEIGHTS_NFL_1H),
  };
}

export function projectNflTeamTotal(ctx, side) {
  const avg = ctx.averages;
  const team = side === "home" ? ctx.home : ctx.away;
  const rival = side === "home" ? ctx.away : ctx.home;
  const pts = (team?.form?.ptsPerGame ?? avg.ptsGame / 2) * 0.98;
  const defRival = rival?.form?.ptsPerGame ?? avg.ptsGame / 2;
  const qb = team?.qb_factor ?? 1;
  const fatigue = team?.fatigue?.factor ?? 1;
  const injuryPts = team?.injuryPenalty || 0;
  const projected = ((pts + (avg.ptsGame / 2 - defRival)) / 2) * qb * (ctx.clima_factor ?? 1) * fatigue - injuryPts;
  return { pts: Math.max(10, projected), factors_used: Object.keys(FACTOR_WEIGHTS_NFL_TEAM) };
}

export function projectNflGameTotal(ctx) {
  const home = projectNflTeamTotal(ctx, "home");
  const away = projectNflTeamTotal(ctx, "away");
  const sigmaHome = computeDynamicSigma(ctx.home, NFL_SIGMA_GAME, { minSample: 5, minSigma: 5 });
  const sigmaAway = computeDynamicSigma(ctx.away, NFL_SIGMA_GAME, { minSample: 5, minSigma: 5 });
  return {
    muHome: home.pts,
    muAway: away.pts,
    sigmaHome,
    sigmaAway,
    meanTotal: home.pts + away.pts,
    factors_used: ["team_total_home", "team_total_away", "sigma_dinamico"],
  };
}

export function projectNflMoneyline(ctx) {
  const homePower = (ctx.home?.form?.ptsPerGame ?? 22) - (ctx.away?.form?.ptsPerGame ?? 22);
  const qbEdge = (ctx.home?.qb_factor ?? 1) - (ctx.away?.qb_factor ?? 1);
  const score = homePower * 0.04 + qbEdge * 0.25 + 0.08;
  const probHome = 1 / (1 + Math.exp(-score * 2.2));
  return {
    probHome,
    probAway: 1 - probHome,
    factors_used: Object.keys(FACTOR_WEIGHTS_NFL_ML),
  };
}

export function simulateNflTotalOver(ctx, line) {
  const base = projectNflGameTotal(ctx);
  return monteCarloTotal({
    muHome: base.muHome,
    muAway: base.muAway,
    sigmaHome: base.sigmaHome,
    sigmaAway: base.sigmaAway,
    line,
    iterations: MC_ITERATIONS,
  });
}

export function simulateNflFirstHalfOver(ctx, line) {
  const base = projectNflFirstHalfTotal(ctx);
  const sigma1h = computeDynamicSigma(ctx.home, NFL_SIGMA_1H, { minSample: 5, minSigma: 3.5 }) * 0.65;
  return monteCarloTotal({
    muHome: base.muHome,
    muAway: base.muAway,
    sigmaHome: sigma1h,
    sigmaAway: sigma1h,
    line,
    iterations: MC_ITERATIONS,
  });
}

export function simulateNflTeamOver(ctx, side, line) {
  const projection = projectNflTeamTotal(ctx, side);
  const team = side === "home" ? ctx.home : ctx.away;
  const sigma = computeDynamicSigma(team, NFL_SIGMA_TEAM, { minSample: 5, minSigma: 3.5 });
  return monteCarloSingleOver({
    mu: projection.pts,
    sigma,
    line,
    iterations: MC_ITERATIONS,
  });
}
