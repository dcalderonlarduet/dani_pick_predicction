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
  parseEspnH2hFullTotal,
  parseEspnH2h1h,
  parseEspnRecentForm,
  parseEspnSeasonTeamForm,
  parseEspnTeamRecentScoring,
  parseInjuryFlags,
} from "./shared/espn-pro.js";
import { loadApiSportsNflGameInsight } from "./api-sports-american-football.js";
import { mergeProGameContext } from "./shared/pro-context-merge.js";

export const ESPN_NFL = {
  scoreboard: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  summary: "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={id}",
  stats:
    "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/types/2/teams/{id}/statistics",
  injuries: "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/{id}/injuries",
  depthchart:
    "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/teams/{id}/depthcharts",
  roster: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}?enable=roster,stats",
  standings: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/standings",
  schedule: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{id}/schedule?season={yr}",
};

export async function loadNflScoreboard(date) {
  return fetchScoreboard(ESPN_NFL.scoreboard, date, "nfl");
}

export async function loadNflSummary(eventId) {
  return fetchEventSummary(ESPN_NFL.summary, eventId);
}

async function buildEspnNflContext({ date, home, away, eventId, events }) {
  const source_log = {};
  const scoreboard = events || (await loadNflScoreboard(date));
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

  const avg = leagueAverages("nfl");
  if (!match) {
    return {
      found: false,
      source_log,
      averages: avg,
      home: { form: { ptsPerGame: avg.ptsGame / 2 } },
      away: { form: { ptsPerGame: avg.ptsGame / 2 } },
      hay_noticia_lesion: false,
      clima_factor: 1,
    };
  }

  const { teams } = match;
  const seasonYear = espnSeasonYear(date, "nfl");
  const [summary, homeSeasonStats, awaySeasonStats, homeSchedule, awaySchedule] = await Promise.all([
    loadNflSummary(teams.eventId),
    fetchEspnTeamSeasonStats(ESPN_NFL.stats, teams.homeId, seasonYear),
    fetchEspnTeamSeasonStats(ESPN_NFL.stats, teams.awayId, seasonYear),
    fetchEspnJson(
      ESPN_NFL.schedule.replace("{id}", teams.homeId).replace("{yr}", String(seasonYear)),
      `espn-nfl-schedule|${teams.homeId}|${seasonYear}`
    ).catch(() => null),
    fetchEspnJson(
      ESPN_NFL.schedule.replace("{id}", teams.awayId).replace("{yr}", String(seasonYear)),
      `espn-nfl-schedule|${teams.awayId}|${seasonYear}`
    ).catch(() => null),
  ]);
  source_log.summary = "espn";
  if (homeSeasonStats || awaySeasonStats) source_log.season_stats = "espn";

  const injuryInfo = parseInjuryFlags(summary);

  const [homeInjury, awayInjury] = await Promise.all([
    computeTeamInjuryImpact({
      sport: "nfl",
      teamId: teams.homeId,
      rosterUrlTemplate: ESPN_NFL.roster,
      summary,
    }),
    computeTeamInjuryImpact({
      sport: "nfl",
      teamId: teams.awayId,
      rosterUrlTemplate: ESPN_NFL.roster,
      summary,
    }),
  ]);
  source_log.injury_impact = "minutes-usage-onoff";
  const homeForm =
    parseEspnSeasonTeamForm(homeSeasonStats, "nfl") ||
    parseEspnRecentForm(summary, "home", "nfl") ||
    buildFormFromSummary(summary, "home", "nfl");
  const awayForm =
    parseEspnSeasonTeamForm(awaySeasonStats, "nfl") ||
    parseEspnRecentForm(summary, "away", "nfl") ||
    buildFormFromSummary(summary, "away", "nfl");

  const homeRecentScoring = parseEspnTeamRecentScoring(homeSchedule, teams.homeId, { limit: 8 });
  const awayRecentScoring = parseEspnTeamRecentScoring(awaySchedule, teams.awayId, { limit: 8 });
  homeForm.recentTotals = homeRecentScoring.pointsFor;
  homeForm.recentScores = homeRecentScoring.pointsFor;
  homeForm.recentGameTotals = homeRecentScoring.totals;
  homeForm.recentPointsAllowed = homeRecentScoring.pointsAgainst;
  homeForm.ptsAllowedPerGame = Number.isFinite(homeForm.ptsAllowedPerGame)
    ? homeForm.ptsAllowedPerGame
    : homeRecentScoring.avgAgainst;
  homeForm.gamesPlayed = homeForm.gamesPlayed ?? homeRecentScoring.sample;
  awayForm.recentTotals = awayRecentScoring.pointsFor;
  awayForm.recentScores = awayRecentScoring.pointsFor;
  awayForm.recentGameTotals = awayRecentScoring.totals;
  awayForm.recentPointsAllowed = awayRecentScoring.pointsAgainst;
  awayForm.ptsAllowedPerGame = Number.isFinite(awayForm.ptsAllowedPerGame)
    ? awayForm.ptsAllowedPerGame
    : awayRecentScoring.avgAgainst;
  awayForm.gamesPlayed = awayForm.gamesPlayed ?? awayRecentScoring.sample;

  const weather = summary?.gameInfo?.weather || summary?.weather;
  let clima_factor = 1;
  if (weather) {
    source_log.clima = "espn";
    const wind = Number(weather?.windSpeed || weather?.wind || 0);
    const condition = String(weather?.displayValue || weather?.condition || "").toLowerCase();
    if (wind > 20) clima_factor = 0.88;
    else if (/rain|snow|sleet/.test(condition)) clima_factor = 0.92;
    else if (teams.indoor) clima_factor = 1;
  }

  const qbOutHome = homeInjury.injuryDetails.some((d) => String(d.position || "").includes("QB"));
  const qbOutAway = awayInjury.injuryDetails.some((d) => String(d.position || "").includes("QB"));

  const h2h1h = parseEspnH2h1h(summary, "nfl") ?? avg.pts1h;
  const h2hFullTotal = parseEspnH2hFullTotal(summary);

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
    clima_factor,
    home: {
      teamId: teams.homeId,
      form: homeForm,
      qb_factor: qbOutHome ? homeInjury.qb_factor : 1,
      injuryPenalty: homeInjury.injuryPenalty,
      injuryDetails: homeInjury.injuryDetails,
      fatigue: computeScheduleFatigue(scoreboard, teams.homeId, teams.startIso),
    },
    away: {
      teamId: teams.awayId,
      form: awayForm,
      qb_factor: qbOutAway ? awayInjury.qb_factor : 1,
      injuryPenalty: awayInjury.injuryPenalty,
      injuryDetails: awayInjury.injuryDetails,
      fatigue: computeScheduleFatigue(scoreboard, teams.awayId, teams.startIso),
    },
    injuries: [
      ...parseTeamInjuries(summary, teams.homeId),
      ...parseTeamInjuries(summary, teams.awayId),
    ],
    hay_noticia_lesion: injuryInfo.hay_noticia_lesion,
    h2h: {
      averageTotal: h2hFullTotal,
    },
    h2h_1h: h2h1h,
    flags: {
      stats_espn_disponibles: Boolean(summary?.boxscore || homeSeasonStats || awaySeasonStats),
      lesiones_confirmadas: injuryInfo.injuries.length > 0,
      alineacion_confirmada: Boolean(summary?.boxscore?.players),
      h2h_relevante: parseEspnH2h1h(summary, "nfl") != null,
      clima_disponible: Boolean(weather),
    },
  };
}

export async function buildNflGameContext(params) {
  const espnCtx = await buildEspnNflContext(params);
  const espnStatsOk =
    espnCtx?.home?.form?.source === "espn-season-stats" &&
    espnCtx?.away?.form?.source === "espn-season-stats";

  if (espnStatsOk && espnCtx?.found) return espnCtx;

  const apiCtx = await loadApiSportsNflGameInsight({
    date: params.date,
    home: params.home,
    away: params.away,
  }).catch(() => null);

  if (!apiCtx) return espnCtx;
  return mergeProGameContext(espnCtx, apiCtx);
}
