import { computeTeamInjuryImpact, parseTeamInjuries } from "../services/injury-impact.js";
import {
  buildFormFromSummary,
  computeScheduleFatigue,
  espnSeasonYear,
  extractCompetitors,
  fetchEspnTeamSeasonStats,
  fetchEventSummary,
  fetchEspnJson,
  fetchScoreboard,
  leagueAverages,
  matchScoreboardEvent,
  parseEspnH2h1h,
  parseEspnH2hFullTotal,
  parseEspnRecentForm,
  parseEspnSeasonTeamForm,
  parseInjuryFlags,
} from "./shared/espn-pro.js";
import { loadApiSportsBasketballGameInsight } from "./api-sports-basketball.js";
import { mergeProGameContext } from "./shared/pro-context-merge.js";
const DEFAULT_LEAGUE_VALUES = {
  pace: 99,
  ptsPerGame: 114,
  pts1h: 112,
  offRtg1h: 114,
};

export const ESPN_NBA = {
  scoreboard: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  summary: "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}",
  stats:
    "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/{yr}/teams/{id}/statistics",
  injuries: "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/{id}/injuries",
  roster: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{id}/roster",
  standings: "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings",
  news: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news",
};

export async function loadNbaScoreboard(date) {
  return fetchScoreboard(ESPN_NBA.scoreboard, date, "nba");
}

export async function loadNbaSummary(eventId) {
  return fetchEventSummary(ESPN_NBA.summary, eventId);
}

export async function loadNbaStandings() {
  return fetchEspnJson(ESPN_NBA.standings, "nba|standings");
}

function normalizeProbability(value) {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.replace("%", "").trim() : value;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  if (num > 1) return num / 100;
  return num >= 0 && num <= 1 ? num : null;
}

function readCompetitorWinProbability(competitor, side, event) {
  const stat = competitor?.statistics?.find((row) => {
    const key = String(row?.name || row?.displayName || row?.abbreviation || "").toLowerCase();
    return key === "winprobability" || key === "win_probability" || key === "win percentage";
  });
  const competitionProb = event?.competitions?.[0]?.probabilities?.[0];
  const situationProb = event?.competitions?.[0]?.situation;
  const eventProb = event?.probabilities?.[0];
  const sideKey = side === "home" ? "homeWinPercentage" : "awayWinPercentage";
  return normalizeProbability(
    stat?.value ??
      stat?.displayValue ??
      situationProb?.[sideKey] ??
      competitor?.probabilities?.[0]?.[sideKey] ??
      competitionProb?.[sideKey] ??
      eventProb?.[sideKey]
  );
}

function extractEspnWinProbability(event) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  if (!Array.isArray(competitors) || competitors.length < 2) {
    return { home: null, away: null };
  }

  const homeComp = competitors.find((competitor) => competitor.homeAway === "home");
  const awayComp = competitors.find((competitor) => competitor.homeAway === "away");
  let home = readCompetitorWinProbability(homeComp, "home", event);
  let away = readCompetitorWinProbability(awayComp, "away", event);

  if (home != null && away == null) away = 1 - home;
  if (away != null && home == null) home = 1 - away;

  return { home, away };
}

async function buildEspnNbaContext({ date, home, away, eventId, events }) {
  const source_log = {};
  const scoreboard = events || (await loadNbaScoreboard(date));
  source_log.scoreboard = "espn";

  let match = null;
  if (eventId) {
    const event = scoreboard.find((row) => String(row?.id) === String(eventId));
    if (event) {
      const teams = extractCompetitors(event);
      if (teams) match = { event, teams };
    }
  }
  if (!match && !eventId) match = matchScoreboardEvent(scoreboard, home, away);

  const avg = leagueAverages("nba");
  if (!match) {
    return {
      found: false,
      source_log,
      averages: avg,
      home: { form: { ptsPerGame: avg.ptsGame / 2, pace: avg.pace, offRtg1h: avg.offRtg } },
      away: { form: { ptsPerGame: avg.ptsGame / 2, pace: avg.pace, offRtg1h: avg.offRtg } },
      hay_noticia_lesion: false,
    };
  }

  const { teams } = match;
  const seasonYear = espnSeasonYear(date, "nba");
  const [summary, homeSeasonStats, awaySeasonStats] = await Promise.all([
    loadNbaSummary(teams.eventId),
    fetchEspnTeamSeasonStats(ESPN_NBA.stats, teams.homeId, seasonYear),
    fetchEspnTeamSeasonStats(ESPN_NBA.stats, teams.awayId, seasonYear),
  ]);
  source_log.summary = "espn";
  if (homeSeasonStats || awaySeasonStats) source_log.season_stats = "espn";

  const injuryInfo = parseInjuryFlags(summary);
  source_log.injuries = "espn-summary";
  const espnWinProb = extractEspnWinProbability(match.event);
  if (espnWinProb.home != null || espnWinProb.away != null) {
    source_log.win_probability = "espn-scoreboard";
  }

  const [homeInjury, awayInjury] = await Promise.all([
    computeTeamInjuryImpact({
      sport: "nba",
      teamId: teams.homeId,
      rosterUrlTemplate: ESPN_NBA.roster,
      summary,
    }),
    computeTeamInjuryImpact({
      sport: "nba",
      teamId: teams.awayId,
      rosterUrlTemplate: ESPN_NBA.roster,
      summary,
    }),
  ]);
  source_log.injury_impact = "minutes-usage-onoff";

  const homeForm =
    parseEspnSeasonTeamForm(homeSeasonStats, "nba") ||
    parseEspnRecentForm(summary, "home", "nba") ||
    buildFormFromSummary(summary, "home", "nba") ||
    leagueDefaultForm("home", teams.homeId);
  const awayForm =
    parseEspnSeasonTeamForm(awaySeasonStats, "nba") ||
    parseEspnRecentForm(summary, "away", "nba") ||
    buildFormFromSummary(summary, "away", "nba") ||
    leagueDefaultForm("away", teams.awayId);

  if (!parseEspnSeasonTeamForm(homeSeasonStats, "nba")) {
    warnMissingEspnField("season_stats", teams.homeId);
  }
  if (!parseEspnSeasonTeamForm(awaySeasonStats, "nba")) {
    warnMissingEspnField("season_stats", teams.awayId);
  }

  const h2h1h = parseEspnH2h1h(summary, "nba") ?? avg.pts1h;
  const h2hFullTotal = parseEspnH2hFullTotal(summary);
  const homeFatigue = computeScheduleFatigue(scoreboard, teams.homeId, teams.startIso);
  const awayFatigue = computeScheduleFatigue(scoreboard, teams.awayId, teams.startIso);

  return {
    found: true,
    eventId: teams.eventId,
    homeName: teams.homeName,
    awayName: teams.awayName,
    startIso: teams.startIso,
    status: teams.status,
    venue: teams.venue,
    source_log,
    averages: avg,
    home: {
      teamId: teams.homeId,
      form: homeForm,
      fatigue: homeFatigue,
      injuryPenalty: homeInjury.injuryPenalty,
      injuryDetails: homeInjury.injuryDetails,
    },
    away: {
      teamId: teams.awayId,
      form: awayForm,
      fatigue: awayFatigue,
      injuryPenalty: awayInjury.injuryPenalty,
      injuryDetails: awayInjury.injuryDetails,
    },
    injuries: [
      ...parseTeamInjuries(summary, teams.homeId),
      ...parseTeamInjuries(summary, teams.awayId),
    ],
    hay_noticia_lesion: injuryInfo.hay_noticia_lesion,
    espnWinProb,
    espnWinProbHome: espnWinProb.home != null ? Math.round(espnWinProb.home * 1000) / 10 : null,
    espnWinProbAway: espnWinProb.away != null ? Math.round(espnWinProb.away * 1000) / 10 : null,
    h2h: {
      averageTotal: h2hFullTotal,
    },
    h2h_1h: h2h1h,
    over_rate_home: estimateOverRate(homeForm),
    over_rate_away: estimateOverRate(awayForm),
    flags: {
      stats_espn_disponibles: Boolean(summary?.boxscore || homeSeasonStats || awaySeasonStats),
      lesiones_confirmadas: injuryInfo.injuries.length > 0,
      alineacion_confirmada: Boolean(summary?.boxscore?.players),
      h2h_relevante: h2h1h != null && parseEspnH2h1h(summary, "nba") != null,
      muestra_suficiente: Boolean(
        Number(homeForm?.gamesPlayed ?? homeForm?.sample ?? 0) >= 5 ||
          Number(awayForm?.gamesPlayed ?? awayForm?.sample ?? 0) >= 5 ||
          homeSeasonStats ||
          awaySeasonStats
      ),
      freshness_ok: Boolean(
        summary && (homeSeasonStats || awaySeasonStats || summary?.boxscore?.players)
      ),
      mercado_actualizado: false,
      espn_win_prob_disponible: espnWinProb.home != null || espnWinProb.away != null,
      clima_disponible: false,
    },
  };
}

function estimateOverRate(form) {
  const pts = Number(form?.ptsPerGame);
  if (!Number.isFinite(pts)) return 0.5;
  if (pts >= 118) return 0.62;
  if (pts <= 108) return 0.42;
  return 0.5;
}

function warnMissingEspnField(campo, teamId) {
  console.warn(`[ESPN-NBA] Dato ${campo} no disponible para team ${teamId ?? "unknown"}`);
}

function leagueDefaultForm(side, teamId) {
  warnMissingEspnField("form", teamId);
  return {
    ptsPerGame: DEFAULT_LEAGUE_VALUES.ptsPerGame,
    pace: DEFAULT_LEAGUE_VALUES.pace,
    pts1h: DEFAULT_LEAGUE_VALUES.pts1h / 2,
    offRtg1h: DEFAULT_LEAGUE_VALUES.offRtg1h,
    source: "league-default",
  };
}

export async function buildNbaGameContext(params) {
  const espnCtx = await buildEspnNbaContext(params);
  const espnStatsOk =
    espnCtx?.home?.form?.source === "espn-season-stats" &&
    espnCtx?.away?.form?.source === "espn-season-stats";

  if (espnStatsOk && espnCtx?.found) return espnCtx;

  const apiCtx = await loadApiSportsBasketballGameInsight({
    date: params.date,
    home: params.home,
    away: params.away,
  }).catch(() => null);

  if (!apiCtx && !espnStatsOk && espnCtx?.found) {
    console.warn(
      `[ESPN-NBA] Stats incompletas para ${params.home ?? espnCtx.homeName} vs ${params.away ?? espnCtx.awayName}; usando medias de liga (fallback API-Sports no disponible)`
    );
  }

  return apiCtx ? mergeProGameContext(espnCtx, apiCtx) : espnCtx;
}
