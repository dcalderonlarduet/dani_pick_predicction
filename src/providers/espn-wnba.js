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
  parseEspnRecentForm,
  parseEspnSeasonTeamForm,
  parseInjuryFlags,
} from "./shared/espn-pro.js";

const SPORT = "wnba";

// [WNBA-OVERRIDE] Muestras más cortas por temporada comprimida
const FORMA_SAMPLE = 6;
const FORMA_SAMPLE_TT = 8;

// [WNBA-OVERRIDE] Medias de liga WNBA
const DEFAULT_LEAGUE_VALUES = {
  pace: 88,
  ptsPerGame: 83,
  pts1h: 41,
  offRtg1h: 100,
};

export const ESPN_WNBA = {
  scoreboard: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
  summary: "https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event={id}",
  stats:
    "https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/seasons/{yr}/teams/{id}/statistics",
  injuries: "https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/teams/{id}/injuries",
  roster: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/{id}/roster",
  standings: "https://site.api.espn.com/apis/v2/sports/basketball/wnba/standings",
  news: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/news",
  schedule: "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/{id}/schedule?season={yr}",
};

export async function loadWnbaScoreboard(date) {
  return fetchScoreboard(ESPN_WNBA.scoreboard, date, SPORT);
}

export async function loadWnbaSummary(eventId) {
  return fetchEventSummary(ESPN_WNBA.summary, eventId);
}

export async function loadWnbaStandings() {
  return fetchEspnJson(ESPN_WNBA.standings, "wnba|standings");
}

function warnMissingEspnField(campo, teamId) {
  const fallback = DEFAULT_LEAGUE_VALUES[campo] ?? DEFAULT_LEAGUE_VALUES.ptsPerGame;
  console.warn(`[ESPN-WNBA] Dato ${campo} no disponible para team ${teamId ?? "unknown"} → usando default ${fallback}`);
}

function leagueDefaultForm(teamId) {
  warnMissingEspnField("form", teamId);
  return {
    ptsPerGame: DEFAULT_LEAGUE_VALUES.ptsPerGame,
    pace: DEFAULT_LEAGUE_VALUES.pace,
    pts1h: DEFAULT_LEAGUE_VALUES.pts1h,
    offRtg1h: DEFAULT_LEAGUE_VALUES.offRtg1h,
    sample: FORMA_SAMPLE,
    source: "league-default",
  };
}

function normalizeWnbaForm(form, sampleLimit = FORMA_SAMPLE_TT) {
  if (!form) return null;
  return {
    ...form,
    sample: Math.min(Number(form.sample) || sampleLimit, sampleLimit),
  };
}

function readScheduleScore(competitor) {
  const score = competitor?.score;
  return Number(
    score?.value ??
      score?.displayValue ??
      score ??
      competitor?.team?.score?.value ??
      competitor?.team?.score?.displayValue ??
      competitor?.team?.score
  );
}

function extractVenueScores(schedulePayload, teamId, venue, { limit = 5, beforeIso = null } = {}) {
  const events = schedulePayload?.events || schedulePayload?.team?.events || [];
  const venueKey = String(venue || "").toLowerCase();
  const cutoffMs = beforeIso ? new Date(beforeIso).getTime() : Date.now();
  return (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => new Date(b?.date || b?.competitions?.[0]?.date || 0) - new Date(a?.date || a?.competitions?.[0]?.date || 0))
    .flatMap((event) => {
      const eventMs = new Date(event?.date || event?.competitions?.[0]?.date || 0).getTime();
      if (Number.isFinite(cutoffMs) && Number.isFinite(eventMs) && eventMs >= cutoffMs) return [];
      const status = String(event?.competitions?.[0]?.status?.type?.name || event?.status?.type?.name || "").toLowerCase();
      const competitors = event?.competitions?.[0]?.competitors || [];
      const mine = competitors.find((row) => String(row?.team?.id || row?.id) === String(teamId));
      if (!mine || String(mine?.homeAway || "").toLowerCase() !== venueKey) return [];
      const score = readScheduleScore(mine);
      if (!/final|post|completed/.test(status) && !Number.isFinite(score)) return [];
      return Number.isFinite(score) && score > 0 ? [score] : [];
    })
    .slice(0, limit);
}

function averageScores(scores, minGames = 2) {
  if (!Array.isArray(scores) || scores.length < minGames) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function enrichWnbaVenueScoring(form, schedulePayload, teamId, beforeIso = null) {
  if (!form) return form;
  const homeScores = extractVenueScores(schedulePayload, teamId, "home", { beforeIso });
  const awayScores = extractVenueScores(schedulePayload, teamId, "away", { beforeIso });
  const earlySeasonVenue = homeScores.length < 3 || awayScores.length < 3;
  return {
    ...form,
    ptsPerGameHome: averageScores(homeScores),
    ptsPerGameAway: averageScores(awayScores),
    venueDataFlag: earlySeasonVenue ? 'EARLY_SEASON_VENUE_PROXY' : null,
    venueGamesCount: { home: homeScores.length, away: awayScores.length },
    recentScores: Array.isArray(form.recentScores) && form.recentScores.length
      ? form.recentScores
      : [...homeScores, ...awayScores].slice(0, FORMA_SAMPLE_TT),
  };
}

// [WNBA-OVERRIDE] Lesiones: impacto dinámico (ver injury-impact.js)

function estimateOverRate(form) {
  const pts = Number(form?.ptsPerGame);
  if (!Number.isFinite(pts)) return 0.5;
  if (pts >= 90) return 0.62;
  if (pts <= 75) return 0.42;
  return 0.5;
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
  const homeComp = competitors.find((c) => c.homeAway === "home");
  const awayComp = competitors.find((c) => c.homeAway === "away");
  let home = readCompetitorWinProbability(homeComp, "home", event);
  let away = readCompetitorWinProbability(awayComp, "away", event);

  if (home != null && away == null) away = 1 - home;
  if (away != null && home == null) home = 1 - away;

  return { home, away };
}

function extractWnbaRecentH2H(summary) {
  const meetings =
    summary?.header?.lastFiveMeetings ||
    summary?.pickcenter?.previousGames ||
    summary?.againstTheSpread?.meetings ||
    [];
  const rows = Array.isArray(meetings) ? meetings : [];
  return rows
    .slice(0, 5)
    .map((row) => {
      const homeScore = Number(row?.homeScore ?? row?.score?.home ?? row?.home?.score);
      const awayScore = Number(row?.awayScore ?? row?.score?.away ?? row?.away?.score);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
      return {
        homeScore,
        awayScore,
        date: row?.date || row?.gameDate || null,
      };
    })
    .filter(Boolean);
}

async function buildEspnWnbaContext({ date, home, away, eventId, events }) {
  const source_log = {};
  const scoreboard = events || (await loadWnbaScoreboard(date));
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

  const avg = leagueAverages(SPORT);
  if (!match) {
    return {
      found: false,
      source_log,
      averages: avg,
      sport: SPORT,
      home: { form: leagueDefaultForm(null) },
      away: { form: leagueDefaultForm(null) },
      hay_noticia_lesion: false,
    };
  }

  const { teams } = match;
  const seasonYear = espnSeasonYear(date, SPORT);
  const [summary, homeSeasonStats, awaySeasonStats, homeSchedule, awaySchedule] = await Promise.all([
    loadWnbaSummary(teams.eventId),
    fetchEspnTeamSeasonStats(ESPN_WNBA.stats, teams.homeId, seasonYear),
    fetchEspnTeamSeasonStats(ESPN_WNBA.stats, teams.awayId, seasonYear),
    fetchEspnJson(
      ESPN_WNBA.schedule.replace("{id}", teams.homeId).replace("{yr}", String(seasonYear)),
      `espn-wnba-schedule|${teams.homeId}|${seasonYear}`
    ).catch(() => null),
    fetchEspnJson(
      ESPN_WNBA.schedule.replace("{id}", teams.awayId).replace("{yr}", String(seasonYear)),
      `espn-wnba-schedule|${teams.awayId}|${seasonYear}`
    ).catch(() => null),
  ]);
  source_log.summary = "espn";
  if (homeSeasonStats || awaySeasonStats) source_log.season_stats = "espn";
  if (homeSchedule || awaySchedule) source_log.schedule = "espn";

  const injuryInfo = parseInjuryFlags(summary);
  source_log.injuries = "espn-summary";
  const espnWinProb = extractEspnWinProbability(match.event);
  if (espnWinProb.home != null || espnWinProb.away != null) source_log.win_probability = "espn-scoreboard";
  const h2hRecentGames = extractWnbaRecentH2H(summary);
  const h2hAverageTotal = h2hRecentGames.length
    ? h2hRecentGames.reduce((sum, row) => sum + row.homeScore + row.awayScore, 0) / h2hRecentGames.length
    : null;

  const [homeInjury, awayInjury] = await Promise.all([
    computeTeamInjuryImpact({
      sport: SPORT,
      teamId: teams.homeId,
      rosterUrlTemplate: ESPN_WNBA.roster,
      summary,
    }),
    computeTeamInjuryImpact({
      sport: SPORT,
      teamId: teams.awayId,
      rosterUrlTemplate: ESPN_WNBA.roster,
      summary,
    }),
  ]);
  source_log.injury_impact = "minutes-usage-onoff";

  const homeForm = enrichWnbaVenueScoring(
    normalizeWnbaForm(parseEspnSeasonTeamForm(homeSeasonStats, SPORT)) ||
      normalizeWnbaForm(parseEspnRecentForm(summary, "home", SPORT), FORMA_SAMPLE) ||
      normalizeWnbaForm(buildFormFromSummary(summary, "home", SPORT), FORMA_SAMPLE) ||
      leagueDefaultForm(teams.homeId),
    homeSchedule,
    teams.homeId,
    teams.startIso
  );
  const awayForm = enrichWnbaVenueScoring(
    normalizeWnbaForm(parseEspnSeasonTeamForm(awaySeasonStats, SPORT)) ||
      normalizeWnbaForm(parseEspnRecentForm(summary, "away", SPORT), FORMA_SAMPLE) ||
      normalizeWnbaForm(buildFormFromSummary(summary, "away", SPORT), FORMA_SAMPLE) ||
      leagueDefaultForm(teams.awayId),
    awaySchedule,
    teams.awayId,
    teams.startIso
  );

  if (!parseEspnSeasonTeamForm(homeSeasonStats, SPORT)) {
    warnMissingEspnField("season_stats", teams.homeId);
  }
  if (!parseEspnSeasonTeamForm(awaySeasonStats, SPORT)) {
    warnMissingEspnField("season_stats", teams.awayId);
  }

  const homeFatigue = computeScheduleFatigue(scoreboard, teams.homeId, teams.startIso);
  const awayFatigue = computeScheduleFatigue(scoreboard, teams.awayId, teams.startIso);
  const outdoor = teams.indoor === false;

  return {
    found: true,
    sport: SPORT,
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
      recentGames: h2hRecentGames,
      averageTotal: h2hAverageTotal,
    },
    over_rate_home: estimateOverRate(homeForm),
    over_rate_away: estimateOverRate(awayForm),
    flags: {
      stats_espn_disponibles: Boolean(summary?.boxscore || homeSeasonStats || awaySeasonStats),
      lesiones_confirmadas: injuryInfo.injuries.length > 0,
      alineacion_confirmada: Boolean(summary?.boxscore?.players),
      muestra_suficiente: Boolean(
        (Number(homeForm?.sample) >= 5 || Number(awayForm?.sample) >= 5) ||
          homeSeasonStats ||
          awaySeasonStats
      ),
      freshness_ok: Boolean(
        summary && (homeSeasonStats || awaySeasonStats || summary?.boxscore?.players)
      ),
      mercado_actualizado: false,
      h2h_relevante: h2hRecentGames.length >= 2,
      espn_win_prob_disponible: espnWinProb.home != null || espnWinProb.away != null,
      clima_disponible: outdoor,
    },
    wnba_overrides_applied: ["h2h_recent_enabled", "api_sports_disabled", "forma_sample_reduced"],
  };
}

export async function buildWnbaGameContext(params) {
  const espnCtx = await buildEspnWnbaContext(params);
  const espnStatsOk =
    espnCtx?.source_log?.season_stats === "espn" ||
    espnCtx?.home?.form?.source === "espn-season-stats" ||
    espnCtx?.away?.form?.source === "espn-season-stats";

  if (!espnStatsOk && espnCtx?.found) {
    console.warn(
      `[ESPN-WNBA] Stats incompletas para ${params.home ?? espnCtx.homeName} vs ${params.away ?? espnCtx.awayName}; usando medias de liga (API-Sports desactivado)`
    );
  }

  return espnCtx;
}
