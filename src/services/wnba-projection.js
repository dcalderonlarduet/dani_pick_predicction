import { monteCarloSingleOver, monteCarloTotal } from "./pro-odds-scoring.js";

const SPORT = "wnba";

// [WNBA-OVERRIDE] Medias y varianza de liga
export const LEAGUE_DEFAULTS = {
  ppg: 83,
  pace: 88,
  ortg: 100,
  sigma_mc: 10,
};

export const FORMA_SAMPLE = 6;
export const FORMA_SAMPLE_TT = 8;
export const HOME_COURT_PTS = 2.8;

export const FACTOR_WEIGHTS_WNBA_TOTAL = {
  pace_combinado: 0.2,
  off_rtg_home: 0.2,
  off_rtg_away: 0.2,
  over_under_rate: 0.15,
  lesiones_totales: 0.12,
  h2h_totals: 0.08,
  arbitros: 0,
  home_away_split: 0.13,
};

export const FACTOR_WEIGHTS_WNBA_TEAM = {
  off_rtg_season: 0.245,
  def_rtg_rival: 0.245,
  pace_partido: 0.28,
  lesiones_key: 0.15,
  matchup_splits: 0.1,
  home_away_split: 0.08,
  fatiga: 0.05,
};

export const FACTOR_WEIGHTS_WNBA_ML = {
  elo_diff: 0.25,
  forma_reciente: 0.22,
  lesiones_netas: 0.23,
  net_rating_diff: 0.15,
  home_court: 0.08,
  h2h: 0,
  descanso: 0.07,
};

const SIGMA_MIN_SAMPLE = 5;

function readNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function basketballDefenseFactor(defRtg, avgDef) {
  const defense = readNumber(defRtg, avgDef);
  const average = readNumber(avgDef, LEAGUE_DEFAULTS.ortg) ?? LEAGUE_DEFAULTS.ortg;
  if (!Number.isFinite(defense)) return 1;
  if (defense < average - 3) return 0.93;
  if (defense > average + 3) return 1.07;
  return 1;
}

// [WNBA-OVERRIDE] Sigma dinámico; fallback si muestra < 5 partidos
export function computeSigma(teamSide) {
  const scores =
    teamSide?.form?.recentScores ||
    teamSide?.form?.lastGames?.map((game) => Number(game?.points)).filter(Number.isFinite) ||
    [];
  if (!Array.isArray(scores) || scores.length < SIGMA_MIN_SAMPLE) return null;

  const mean = scores.reduce((acc, value) => acc + value, 0) / scores.length;
  const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

function resolveSigma(teamSide) {
  return computeSigma(teamSide) ?? LEAGUE_DEFAULTS.sigma_mc;
}

export function projectWnbaTeamTotal(ctx, side) {
  const avg = ctx.averages;
  const team = side === "home" ? ctx.home : ctx.away;
  const rival = side === "home" ? ctx.away : ctx.home;
  const pace = ((ctx.home?.form?.pace ?? avg.pace) + (ctx.away?.form?.pace ?? avg.pace)) / 2;
  const defRtgRival = rival?.form?.defRtg ?? avg.defRtg;
  const matchup = basketballDefenseFactor(defRtgRival, avg.defRtg);
  const fatigue = team?.fatigue?.factor ?? 1;
  const injuryPts = team?.injuryPenalty || 0;
  const overrides = ["h2h_weight_0", "pace_weight_0.28", "injury_penalty_scaled"];
  const recentScoringInSitu = side === "home"
    ? team?.form?.ptsPerGameHome
    : team?.form?.ptsPerGameAway;

  let pts;
  if (Number.isFinite(recentScoringInSitu) && recentScoringInSitu > 0) {
    pts = recentScoringInSitu * matchup * fatigue - injuryPts;
    overrides.push("real_home_away_scoring_base");
  } else {
    const offRtg = team?.form?.offRtg1h ?? avg.offRtg;
    const homeAway = side === "home" ? 1.015 : 0.985;
    pts = (offRtg / 100) * pace * matchup * homeAway * fatigue - injuryPts;
    overrides.push("offrtg_fallback");
  }

  return {
    pts: Math.max(55, pts),
    factors_used: Object.keys(FACTOR_WEIGHTS_WNBA_TEAM),
    wnba_overrides_applied: overrides,
  };
}

export function projectWnbaGameTotal(ctx) {
  const home = projectWnbaTeamTotal(ctx, "home");
  const away = projectWnbaTeamTotal(ctx, "away");
  let muHome = home.pts;
  let muAway = away.pts;
  const overrides = ["arbitro_disabled", "dynamic_sigma"];

  if ((ctx.over_rate_home || 0) > 0.6 && (ctx.over_rate_away || 0) > 0.6) {
    muHome += 0.8;
    muAway += 0.8;
  }

  const currentTotal = muHome + muAway;
  const adjustedTotal = applyH2HAdjustment(currentTotal, ctx);
  if (adjustedTotal !== currentTotal) {
    const delta = adjustedTotal - currentTotal;
    muHome += delta / 2;
    muAway += delta / 2;
    overrides.push("h2h_blend_30");
  } else {
    overrides.push("h2h_not_applied");
  }

  // [WNBA-OVERRIDE] H2H desactivado — no ajustar por h2h_1h

  const sigmaHome = resolveSigma(ctx.home);
  const sigmaAway = resolveSigma(ctx.away);

  return {
    muHome,
    muAway,
    sigmaHome,
    sigmaAway,
    meanTotal: muHome + muAway,
    factors_used: Object.keys(FACTOR_WEIGHTS_WNBA_TOTAL),
    wnba_overrides_applied: overrides,
  };
}

export function projectWnbaMoneyline(ctx) {
  const avg = ctx.averages;
  const homeOff = ctx.home?.form?.offRtg1h ?? avg.offRtg;
  const awayOff = ctx.away?.form?.offRtg1h ?? avg.offRtg;
  const homeDef = ctx.home?.form?.defRtg ?? avg.defRtg;
  const awayDef = ctx.away?.form?.defRtg ?? avg.defRtg;
  const netDiff = (homeOff - homeDef) - (awayOff - awayDef) + HOME_COURT_PTS;
  const formDiff = (ctx.home?.form?.ptsPerGame ?? avg.ptsGame / 2) - (ctx.away?.form?.ptsPerGame ?? avg.ptsGame / 2);
  const injuryEdge = (ctx.away?.injuryPenalty || 0) - (ctx.home?.injuryPenalty || 0);
  const fatigueEdge =
    ((ctx.away?.fatigue?.factor ?? 1) - (ctx.home?.fatigue?.factor ?? 1)) * 2.5;
  const score = netDiff * 0.02 + formDiff * 0.006 + injuryEdge * 0.035 + fatigueEdge * 0.02 + 0.028;
  const probHome = 1 / (1 + Math.exp(-score * 2.4));

  return {
    probHome,
    probAway: 1 - probHome,
    factors_used: Object.keys(FACTOR_WEIGHTS_WNBA_ML),
    wnba_overrides_applied: ["h2h_disabled", "home_court_2.8", "lesiones_netas_boost"],
  };
}

export function simulateWnbaTotalOver(ctx, line) {
  const base = projectWnbaGameTotal(ctx);
  return monteCarloTotal({
    muHome: base.muHome,
    muAway: base.muAway,
    sigmaHome: base.sigmaHome,
    sigmaAway: base.sigmaAway,
    line,
  });
}

export function applyH2HAdjustment(projectedTotal, ctx) {
  const total = Number(projectedTotal);
  if (!Number.isFinite(total)) return projectedTotal;

  const h2hGames = Array.isArray(ctx?.h2h?.recentGames) ? ctx.h2h.recentGames : [];
  if (h2hGames.length < 2) return projectedTotal;

  const totals = h2hGames
    .slice(0, 4)
    .map((game) => {
      const homeScore = Number(game?.homeScore ?? game?.score?.home ?? game?.home?.score);
      const awayScore = Number(game?.awayScore ?? game?.score?.away ?? game?.away?.score);
      return Number.isFinite(homeScore) && Number.isFinite(awayScore) ? homeScore + awayScore : null;
    })
    .filter(Number.isFinite);

  if (totals.length < 2) return projectedTotal;
  const h2hAvg = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  if (!Number.isFinite(h2hAvg) || h2hAvg < 140) return projectedTotal;

  return Math.round((total * 0.7 + h2hAvg * 0.3) * 2) / 2;
}

export function simulateWnbaTeamOver(ctx, side, line) {
  const projection = projectWnbaTeamTotal(ctx, side);
  const team = side === "home" ? ctx.home : ctx.away;
  const sigma = resolveSigma(team);
  return monteCarloSingleOver({
    mu: projection.pts,
    sigma,
    line,
  });
}

export { SPORT };
