import { monteCarloSingleOver, monteCarloTotal, computeDynamicSigma } from "./pro-odds-scoring.js";

const NBA_SIGMA_1H = 6;
const MC_ITERATIONS = 5000;

export const FACTOR_WEIGHTS_NBA_1H = {
  pace_1h: 0.25,
  off_rtg_1h: 0.2,
  def_rtg_1h_rival: 0.2,
  lesiones: 0.15,
  arbitro_fouls: 0.1,
  forma_1h_5: 0.05,
  h2h_1h: 0.05,
};

export const FACTOR_WEIGHTS_NBA_TEAM = {
  off_rtg_season: 0.22,
  def_rtg_rival: 0.22,
  pace_partido: 0.18,
  lesiones_key: 0.15,
  matchup_splits: 0.1,
  home_away_split: 0.08,
  fatiga: 0.05,
};

export const FACTOR_WEIGHTS_NBA_ML = {
  elo_diff: 0.25,
  forma_reciente: 0.2,
  lesiones_netas: 0.2,
  net_rating_diff: 0.15,
  home_court: 0.1,
  h2h: 0.05,
  descanso: 0.05,
};

export function projectNbaFirstHalfTotal(ctx) {
  const avg = ctx.averages;
  const homePace = ctx.home?.form?.pace ?? avg.pace;
  const awayPace = ctx.away?.form?.pace ?? avg.pace;
  const pace = (homePace + awayPace) / 2;

  const homeOff = ctx.home?.form?.offRtg1h ?? avg.offRtg;
  const awayOff = ctx.away?.form?.offRtg1h ?? avg.offRtg;
  const homeInj = Math.max(0.85, 1 - (ctx.home?.injuryPenalty || 0) / 10);
  const awayInj = Math.max(0.85, 1 - (ctx.away?.injuryPenalty || 0) / 10);
  const homeFatigue = ctx.home?.fatigue?.factor ?? 1;
  const awayFatigue = ctx.away?.fatigue?.factor ?? 1;

  const projectedHome = ((pace * homeOff) / 100) * homeInj * homeFatigue;
  const projectedAway = ((pace * awayOff) / 100) * awayInj * awayFatigue;
  const formFactor = 1;
  const h2hFactor = ctx.h2h_1h ? ctx.h2h_1h / avg.pts1h : 1;

  const total = (projectedHome + projectedAway) * formFactor * h2hFactor;
  return {
    total,
    muHome: projectedHome,
    muAway: projectedAway,
    factors_used: Object.keys(FACTOR_WEIGHTS_NBA_1H),
  };
}

export function projectNbaTeamTotal(ctx, side) {
  const avg = ctx.averages;
  const team = side === "home" ? ctx.home : ctx.away;
  const rival = side === "home" ? ctx.away : ctx.home;
  const pace = ((ctx.home?.form?.pace ?? avg.pace) + (ctx.away?.form?.pace ?? avg.pace)) / 2;
  const offRtg = team?.form?.offRtg1h ?? avg.offRtg;
  const defRtgRival = rival?.form?.offRtg1h ?? avg.defRtg;
  const matchup = defRtgRival > avg.defRtg + 3 ? 0.93 : defRtgRival < avg.defRtg - 3 ? 1.07 : 1;
  const homeAway = side === "home" ? 1.02 : 0.98;
  const fatigue = team?.fatigue?.factor ?? 1;
  const injuryPts = team?.injuryPenalty || 0;
  const pts = (offRtg / 100) * pace * matchup * homeAway * fatigue - injuryPts;
  return { pts: Math.max(95, pts), factors_used: Object.keys(FACTOR_WEIGHTS_NBA_TEAM) };
}

export function projectNbaGameTotal(ctx) {
  const home = projectNbaTeamTotal(ctx, "home");
  const away = projectNbaTeamTotal(ctx, "away");
  let muHome = home.pts;
  let muAway = away.pts;
  if ((ctx.over_rate_home || 0) > 0.6 && (ctx.over_rate_away || 0) > 0.6) {
    muHome += 1;
    muAway += 1;
  }
  const h2hMean = Number(ctx.h2h_1h);
  if (Number.isFinite(h2hMean) && ctx.flags?.h2h_relevante) {
    const targetTotal = h2hMean;
    const current = muHome + muAway;
    const delta = targetTotal - current;
    if (Math.abs(delta) <= 4) {
      muHome += delta / 2;
      muAway += delta / 2;
    }
  }
  const sigmaHome = computeDynamicSigma(ctx.home, Math.max(8, (ctx.home?.form?.ptsPerGame || 110) * 0.08), {
    minSample: 5,
    minSigma: 8,
  });
  const sigmaAway = computeDynamicSigma(ctx.away, Math.max(8, (ctx.away?.form?.ptsPerGame || 110) * 0.08), {
    minSample: 5,
    minSigma: 8,
  });
  return {
    muHome,
    muAway,
    sigmaHome,
    sigmaAway,
    meanTotal: muHome + muAway,
    factors_used: ["team_total_home", "team_total_away", "monte_carlo", "over_rate", "h2h"],
  };
}

export function projectNbaMoneyline(ctx) {
  const avg = ctx.averages;
  const homeOff = ctx.home?.form?.offRtg1h ?? avg.offRtg;
  const awayOff = ctx.away?.form?.offRtg1h ?? avg.offRtg;
  const netDiff = homeOff - awayOff + 3.5;
  const injuryEdge = (ctx.away?.injuryPenalty || 0) - (ctx.home?.injuryPenalty || 0);
  const score = netDiff * 0.02 + injuryEdge * 0.03 + 0.035;
  const probHome = 1 / (1 + Math.exp(-score * 2.5));
  return {
    probHome,
    probAway: 1 - probHome,
    factors_used: Object.keys(FACTOR_WEIGHTS_NBA_ML),
  };
}

export function simulateNbaTotalOver(ctx, line) {
  const base = projectNbaGameTotal(ctx);
  return monteCarloTotal({
    muHome: base.muHome,
    muAway: base.muAway,
    sigmaHome: base.sigmaHome,
    sigmaAway: base.sigmaAway,
    line,
    iterations: MC_ITERATIONS,
  });
}

export function simulateNbaFirstHalfOver(ctx, line) {
  const base = projectNbaFirstHalfTotal(ctx);
  const sigma1h = computeDynamicSigma(ctx.home, NBA_SIGMA_1H, { minSample: 5, minSigma: 5 });
  return monteCarloTotal({
    muHome: base.muHome,
    muAway: base.muAway,
    sigmaHome: sigma1h,
    sigmaAway: sigma1h,
    line,
    iterations: MC_ITERATIONS,
  });
}

export function simulateNbaTeamOver(ctx, side, line) {
  const projection = projectNbaTeamTotal(ctx, side);
  const team = side === "home" ? ctx.home : ctx.away;
  const sigma = computeDynamicSigma(team, Math.max(6, projection.pts * 0.08), { minSample: 5, minSigma: 6 });
  return monteCarloSingleOver({ mu: projection.pts, sigma, line, iterations: MC_ITERATIONS });
}
