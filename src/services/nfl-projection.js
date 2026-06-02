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

function readNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function matchupDefFactor(allowedPts, avgAllowed) {
  if (allowedPts < avgAllowed - 2) return 0.9;
  if (allowedPts > avgAllowed + 2) return 1.1;
  return 1;
}

function teamPtsFor(team, avg) {
  return readNumber(team?.form?.ptsPerGame, team?.form?.avgFor, avg.ptsGame / 2) ?? avg.ptsGame / 2;
}

function teamPtsAllowed(team, avg) {
  return readNumber(
    team?.form?.ptsAllowedPerGame,
    team?.form?.pointsAllowedPerGame,
    team?.form?.avgAgainst,
    team?.form?.defRtg,
    avg.ptsGame / 2
  ) ?? avg.ptsGame / 2;
}

function yardsMatchupFactor(team, rival) {
  const offense = readNumber(team?.form?.yardsPerGame);
  const rivalAllowed = readNumber(rival?.form?.yardsAllowedPerGame);
  if (!Number.isFinite(offense) || !Number.isFinite(rivalAllowed)) return 1;
  return clamp(1 + (offense - rivalAllowed) / 1000, 0.92, 1.08);
}

export function projectNflFirstHalfTotal(ctx) {
  const avg = ctx.averages;
  const clima = ctx.clima_factor ?? 1;
  const homePts = readNumber(ctx.home?.form?.pts1h, teamPtsFor(ctx.home, avg) * 0.48, avg.pts1h / 2) *
    matchupDefFactor(teamPtsAllowed(ctx.away, avg) * 0.48, avg.pts1h / 2);
  const awayPts = readNumber(ctx.away?.form?.pts1h, teamPtsFor(ctx.away, avg) * 0.48, avg.pts1h / 2) *
    matchupDefFactor(teamPtsAllowed(ctx.home, avg) * 0.48, avg.pts1h / 2);
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
  const pts = teamPtsFor(team, avg);
  const defRival = teamPtsAllowed(rival, avg);
  const qb = team?.qb_factor ?? 1;
  const fatigue = team?.fatigue?.factor ?? 1;
  const injuryPts = team?.injuryPenalty || 0;
  const projected = (pts * 0.6 + defRival * 0.4) * yardsMatchupFactor(team, rival) * qb * (ctx.clima_factor ?? 1) * fatigue - injuryPts;
  return { pts: Math.max(10, projected), factors_used: Object.keys(FACTOR_WEIGHTS_NFL_TEAM) };
}

export function projectNflGameTotal(ctx) {
  const home = projectNflTeamTotal(ctx, "home");
  const away = projectNflTeamTotal(ctx, "away");
  let muHome = home.pts;
  let muAway = away.pts;
  const h2hMean = Number(ctx.h2h?.averageTotal);
  if (Number.isFinite(h2hMean) && ctx.flags?.h2h_relevante) {
    const current = muHome + muAway;
    const blendedTotal = current * 0.75 + h2hMean * 0.25;
    const delta = blendedTotal - current;
    if (Math.abs(h2hMean - current) <= 10) {
      muHome += delta / 2;
      muAway += delta / 2;
    }
  }
  const sigmaHome = computeDynamicSigma(ctx.home, NFL_SIGMA_GAME, { minSample: 5, minSigma: 5 });
  const sigmaAway = computeDynamicSigma(ctx.away, NFL_SIGMA_GAME, { minSample: 5, minSigma: 5 });
  return {
    muHome,
    muAway,
    sigmaHome,
    sigmaAway,
    meanTotal: muHome + muAway,
    factors_used: ["team_total_home", "team_total_away", "sigma_dinamico", "h2h_full_total"],
  };
}

export function projectNflMoneyline(ctx) {
  const avg = ctx.averages;
  const homeNet = teamPtsFor(ctx.home, avg) - teamPtsAllowed(ctx.home, avg);
  const awayNet = teamPtsFor(ctx.away, avg) - teamPtsAllowed(ctx.away, avg);
  const homeYards = readNumber(ctx.home?.form?.yardsPerGame, 330);
  const awayYards = readNumber(ctx.away?.form?.yardsPerGame, 330);
  const yardEdge = Number.isFinite(homeYards) && Number.isFinite(awayYards) ? (homeYards - awayYards) / 100 : 0;
  const powerEdge = homeNet - awayNet;
  const qbEdge = (ctx.home?.qb_factor ?? 1) - (ctx.away?.qb_factor ?? 1);
  const score = powerEdge * 0.04 + yardEdge * 0.025 + qbEdge * 0.25 + 0.08;
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
