import { getRuntimeConfig } from "../config/runtime.js";
import { clamp, round, percent } from "../utils/math.js";
import {
  persistAnalyzerPicksFromMatches,
  mapMlbPickToBacktestRecord,
} from "./backtesting.js";
import { computeMlbPitcherInjuryImpact } from "./injury-impact.js";
import { getOddsHarvesterMatchContext } from "./oddsharvester-snapshot.js";
import { findProOddsEntry, normalizeCommenceTime } from "./pro-analyzer-shared.js";
import { applyMlbProScoringToGame } from "./mlb-odds-policy.js";
import { MLB_BALLPARKS, lookupBallpark } from "../data/mlb-ballparks.js";
import { isMlbInSlateWindow, isMlbRecommendationBettable } from "../utils/bettable-events.js";
import { isMlbGameAlreadyPlayed, isMlbGameUpcoming } from "../utils/event-status.js";
import { shiftDateString } from "../utils/madrid-date.js";
import { fetchJson } from "../providers/shared/http.js";
import { loadWithCache, peekCacheEntry, clearNamespaceCache } from "../providers/shared/resource-cache.js";
import { canonicalName, normalizeBookmakersFromTheOdds } from "../providers/shared/tennis-normalizers.js";
import {
  loadMlbOddsMapForDates as loadMlbOddsMapFromOddsApiIoForDates,
  loadBaseballValueBets,
  loadBaseballDroppingOdds,
  oddsApiSkipMarketSignals,
} from "../providers/odds-api-io.js";
import {
  buildOddsComparison,
  buildOddsGapFactor,
  formatEventSchedule,
  mlbMarketSpecFromRecommendation,
} from "./odds-comparison.js";
import {
  MLB_MARKETS,
  buildTeamStatsPrediction,
  formatScoreFactors,
  plainMethodology,
  plainMoneylineRationale,
  plainPitcherHand,
  plainRecommendationTier,
  plainRiskNotes,
  plainSlateRiskNotes,
  plainRunLineRationale,
  plainTotalsRationale,
  plainMlbValueHeadline,
  plainMlbPitchingBattingContext,
  appendPitchersContextToRationale,
  plainPitcherFormStats,
  plainVerdictLabel,
  formatMlbRunsSelection,
  formatMlbMoneylineSelection,
} from "./mlb-copy.js";
import {
  monteCarloGameDistribution,
  probTeamTotalOver,
  probTotalOver,
  evFromProbability,
} from "./mlb-probability.js";
import {
  MLB_EV_ABS_CAP,
  applyMarketAnchor,
  bestMlbTotalsQuote,
  computeRecentStartsEra,
  lineupLeftHandPct,
  calibrateRunLineProbability,
  computeOffenseVsPitcherMatchup,
  effectivePitcherRunMetric,
  LEAGUE_AVG_BULLPEN_ERA,
  historyVsOpponentRunMetricMeta,
  normalizeExpectedValueMlb,
  pitcherEraContradictory,
  pitcherInsufficientSample,
  recentPitcherFormRunDelta,
  valueBetMatchesRecommendation,
} from "./mlb-model-enhancements.js";
import {
  parseUmpireFromFeed,
  scoreBullpenFatigue,
  computeScheduleFatigue,
  loadGameWeather,
  weatherRunAdjustment,
} from "./mlb-game-context.js";

const MLB_STATS_BASE_URL = "https://statsapi.mlb.com/api/v1";
const MLB_STATS_LIVE_BASE_URL = "https://statsapi.mlb.com/api/v1.1";
const DEFAULT_THE_ODDS_BASE_URL = "https://api.the-odds-api.com/v4";
const DEFAULT_ODDS_REGIONS = ["us", "us2"];
const DEFAULT_ODDS_MARKETS = ["h2h", "spreads", "totals"];
const MLB_CACHE_NAMESPACE = "mlb-stats-api";
const THE_ODDS_CACHE_NAMESPACE = "the-odds-api";
const _mlbCfg = getRuntimeConfig().mlb;
const MLB_MIN_ODDS = _mlbCfg.minOdds;
const MLB_MAX_ODDS = Math.max(MLB_MIN_ODDS, _mlbCfg.maxOdds);
const MLB_PICK_MODE = String(process.env.MLB_PICK_MODE || process.env.PICK_MODE || "value").toLowerCase();
const MLB_VALUE_EV_MIN = Number.parseFloat(process.env.MLB_VALUE_EV_MIN || "0.03");
const MLB_VALUE_EDGE_MIN = Number.parseFloat(process.env.MLB_VALUE_EDGE_MIN || "0.025");
const MLB_PROMOTED_PICK_MIN_ODDS = Math.max(1.45, MLB_MIN_ODDS);
const MLB_CONF_EDGE_CONFLICT_CONFIDENCE = 85;
const MLB_CONF_EDGE_CONFLICT_EDGE = 0.08;


function asNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function addDays(date, days) {
  const target = new Date(`${date}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() + days);
  return target.toISOString().slice(0, 10);
}

function daysBetween(firstDate, secondDate) {
  const first = new Date(firstDate);
  const second = new Date(secondDate);
  return Math.max(0, Math.round((second.getTime() - first.getTime()) / 86400000));
}

function buildMlbUrl(pathname, params = {}) {
  const url = new URL(`${MLB_STATS_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url.toString();
}

function buildMlbLiveUrl(pathname, params = {}) {
  const url = new URL(`${MLB_STATS_LIVE_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url.toString();
}

async function callMlb(pathname, params = {}, provider = "mlb-stats-api") {
  const url = buildMlbUrl(pathname, params);
  return loadWithCache(
    MLB_CACHE_NAMESPACE,
    url,
    getMlbCachePolicy(pathname, params),
    () => fetchJson(url, { provider, timeoutMs: 30000 })
  );
}

async function callMlbLive(pathname, params = {}, provider = "mlb-live-feed") {
  const url = buildMlbLiveUrl(pathname, params);
  return loadWithCache(
    MLB_CACHE_NAMESPACE,
    url,
    getMlbLiveCachePolicy(pathname),
    () => fetchJson(url, { provider, timeoutMs: 30000 })
  );
}

function buildOddsUrl(pathname, apiKey, params = {}) {
  const url = new URL(`${DEFAULT_THE_ODDS_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

async function callTheOdds(pathname, apiKey, params = {}) {
  const url = buildOddsUrl(pathname, apiKey, params);
  return loadWithCache(
    THE_ODDS_CACHE_NAMESPACE,
    url,
    { ttlMs: minutes(5), staleMs: minutes(20) },
    () =>
      fetchJson(url, {
        provider: `the-odds-api:${pathname}`,
        timeoutMs: 15000,
      })
  );
}

function minutes(value) {
  return value * 60 * 1000;
}

function hours(value) {
  return minutes(value * 60);
}

function days(value) {
  return hours(value * 24);
}

function getMlbCachePolicy(pathname, params = {}) {
  if (pathname === "/schedule" && params?.teamId) {
    return { ttlMs: minutes(15), staleMs: hours(2) };
  }

  if (pathname === "/schedule") {
    // TTL corto: los probable pitchers se actualizan durante el día
    // 5 min fresh, 30 min stale — garantiza que se ven los cambios de pitchers
    return { ttlMs: minutes(5), staleMs: minutes(30) };
  }

  if (/^\/people\/\d+$/.test(pathname)) {
    return { ttlMs: days(7), staleMs: days(30) };
  }

  if (/^\/people\/\d+\/stats$/.test(pathname)) {
    return params?.stats === "gameLog"
      ? { ttlMs: minutes(15), staleMs: hours(6) }
      : { ttlMs: minutes(15), staleMs: hours(2) };
  }

  if (/^\/teams\/\d+\/stats$/.test(pathname)) {
    if (params?.stats === "season" || params?.stats === "statSplits") {
      return { ttlMs: hours(1), staleMs: hours(6) };
    }
    return { ttlMs: minutes(15), staleMs: hours(2) };
  }

  return { ttlMs: minutes(15), staleMs: hours(2) };
}

function getMlbLiveCachePolicy(pathname) {
  if (/\/feed\/live$/.test(pathname)) {
    return { ttlMs: minutes(2), staleMs: minutes(10) };
  }
  return { ttlMs: minutes(5), staleMs: minutes(15) };
}

function statLineFromPayload(payload) {
  return payload?.stats?.[0]?.splits?.[0]?.stat || null;
}

function splitsFromPayload(payload) {
  return Array.isArray(payload?.stats?.[0]?.splits) ? payload.stats[0].splits : [];
}

function inningsToDecimal(value) {
  const text = String(value ?? "0");
  if (!text.includes(".")) return asNumber(text, 0);
  const [wholePart, fractionalPart] = text.split(".");
  const outs = asInteger(fractionalPart, 0);
  return asInteger(wholePart, 0) + outs / 3;
}

function computeFip(statLine) {
  if (!statLine) return null;
  const innings = inningsToDecimal(statLine.inningsPitched);
  if (!innings) return null;
  const hr = asNumber(statLine.homeRuns);
  const bb = asNumber(statLine.baseOnBalls) + asNumber(statLine.hitBatsmen);
  const strikeouts = asNumber(statLine.strikeOuts);
  return ((13 * hr) + (3 * bb) - (2 * strikeouts)) / innings + 3.2;
}

function computeXFipProxy(statLine) {
  if (!statLine) return null;
  const innings = inningsToDecimal(statLine.inningsPitched);
  if (!innings) return null;
  const flyBallsApprox = asNumber(statLine.airOuts) + asNumber(statLine.homeRuns);
  const expectedHomeRuns = flyBallsApprox * 0.12;
  const bb = asNumber(statLine.baseOnBalls) + asNumber(statLine.hitBatsmen);
  const strikeouts = asNumber(statLine.strikeOuts);
  return ((13 * expectedHomeRuns) + (3 * bb) - (2 * strikeouts)) / innings + 3.2;
}

function computeRate(value, plateAppearances) {
  const total = asNumber(plateAppearances, 0);
  if (!total) return 0;
  return asNumber(value, 0) / total;
}

function computeRunsPerGame(statLine) {
  const gamesPlayed = asNumber(statLine?.gamesPlayed, 0);
  if (!gamesPlayed) return 0;
  return asNumber(statLine?.runs, 0) / gamesPlayed;
}

function pitchHandCode(personPayload) {
  return personPayload?.people?.[0]?.pitchHand?.code || null;
}

function pitchHandLabel(code) {
  if (code === "L") return "zurdo";
  if (code === "R") return "diestro";
  return "N/D";
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractLineup(feed, side) {
  const team = feed?.liveData?.boxscore?.teams?.[side];
  if (!team?.battingOrder?.length) {
    return {
      confirmed: false,
      players: [],
    };
  }

  const players = team.battingOrder
    .map((playerId) => team.players?.[`ID${playerId}`]?.person?.fullName)
    .filter(Boolean);

  return {
    confirmed: players.length >= 8,
    players,
  };
}

function createMatchKey(homeName, awayName) {
  return [canonicalName(homeName), canonicalName(awayName)].join("::");
}

function mergeOddsMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    if (!map) continue;
    if (map instanceof Map) {
      for (const [key, value] of map.entries()) merged.set(key, value);
      continue;
    }
    if (typeof map === "object") {
      for (const [key, value] of Object.entries(map)) merged.set(key, value);
    }
  }
  return merged;
}

function parkProfile(venueName) {
  return lookupBallpark(venueName) || MLB_BALLPARKS[canonicalName(venueName)] || {
    category: "Neutro",
    runFactor: 1,
    note: "Sin ajuste fuerte de parque en el modelo.",
  };
}

function tierPitcherRunMetric(value) {
  if (!Number.isFinite(value)) return 4;
  if (value < 3.0) return 10;
  if (value < 3.5) return 8;
  if (value < 4.0) return 6;
  if (value < 4.5) return 4;
  return 2;
}

function tierPitcherVulnerability(value) {
  if (!Number.isFinite(value)) return 4;
  if (value >= 4.5) return 10;
  if (value >= 4.0) return 8;
  if (value >= 3.5) return 6;
  if (value >= 3.0) return 4;
  return 2;
}

function tierWhip(value) {
  if (!Number.isFinite(value)) return 4;
  if (value < 1.05) return 8;
  if (value < 1.15) return 6;
  if (value < 1.30) return 4;
  return 2;
}

function tierWhipVulnerability(value) {
  if (!Number.isFinite(value)) return 4;
  if (value > 1.40) return 8;
  if (value > 1.30) return 6;
  if (value > 1.15) return 4;
  return 2;
}

function tierK9(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > 10) return 5;
  if (value > 9) return 4;
  if (value >= 7) return 2;
  return 0;
}

function tierK9Vulnerability(value) {
  if (!Number.isFinite(value)) return 2;
  if (value < 5) return 5;
  if (value < 7) return 4;
  if (value <= 9) return 2;
  return 0;
}

function tierRest(daysRest) {
  if (daysRest >= 5) return 3;
  if (daysRest >= 4) return 2;
  if (daysRest >= 3) return 1;
  return 0;
}

function tierRestVulnerability(daysRest) {
  if (daysRest < 3) return 3;
  if (daysRest < 4) return 2;
  if (daysRest < 5) return 1;
  return 0;
}

function tierOpsProxy(value) {
  if (!Number.isFinite(value)) return 4;
  if (value > 0.76) return 10;
  if (value >= 0.72) return 6;
  return 2;
}

function tierSplitAdvantage(diff) {
  if (diff > 0.03) return 8;
  if (diff >= 0) return 6;
  if (diff >= -0.02) return 4;
  return 2;
}

function tierRunTrend(diff) {
  if (diff > 0.7) return 7;
  if (diff > 0.2) return 5;
  if (diff >= -0.2) return 3;
  return 1;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregatePitchCounts(gameLogSplits = []) {
  return gameLogSplits
    .slice()
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .map((entry) => ({
      date: entry.date,
      pitches: asInteger(entry?.stat?.numberOfPitches, 0),
      opponentId: entry?.opponent?.id || null,
      inningsPitched: entry?.stat?.inningsPitched || "0.0",
      summary: entry?.stat?.summary || "",
    }));
}

function computeHistoryVsOpponent(gameLogBySeason, opponentTeamId) {
  const relevant = gameLogBySeason
    .flat()
    .filter((entry) => String(entry?.opponent?.id) === String(opponentTeamId));

  if (!relevant.length) {
    return {
      games: 0,
      era: null,
      whip: null,
      strikeoutsPer9Inn: null,
    };
  }

  let innings = 0;
  let earnedRuns = 0;
  let hits = 0;
  let walks = 0;
  let strikeouts = 0;

  for (const entry of relevant) {
    innings += inningsToDecimal(entry?.stat?.inningsPitched);
    earnedRuns += asNumber(entry?.stat?.earnedRuns);
    hits += asNumber(entry?.stat?.hits);
    walks += asNumber(entry?.stat?.baseOnBalls) + asNumber(entry?.stat?.hitBatsmen);
    strikeouts += asNumber(entry?.stat?.strikeOuts);
  }

  return {
    games: relevant.length,
    era: innings ? (earnedRuns * 9) / innings : null,
    whip: innings ? (hits + walks) / innings : null,
    strikeoutsPer9Inn: innings ? (strikeouts * 9) / innings : null,
  };
}

function describeTrend(latestValue, baselineValue) {
  if (!Number.isFinite(latestValue) || !Number.isFinite(baselineValue)) return "N/D";
  if (latestValue > baselineValue + 0.2) return "↑";
  if (latestValue < baselineValue - 0.2) return "↓";
  return "→";
}

function createFallbackPitcher(pitcherId, pitcherName) {
  return {
    id: pitcherId || null,
    name: pitcherName || "Pendiente",
    record: { wins: 0, losses: 0, label: "0-0" },
    handCode: null,
    handLabel: "N/D",
    handLabelFull: "Mano no disponible",
    era30: NaN,
    fip30: null,
    xFip30: null,
    recentStartsEra: null,
    regressedRunMetric: 4.1,
    whip30: NaN,
    k9: NaN,
    bb9: NaN,
    hr9: NaN,
    innings30: "0.0",
    starts30: 0,
    velocityFastball: null,
    spinRate: null,
    whiffRate: null,
    restDays: 5,
    recentPitchCounts: [],
    previousPitchCount: null,
    historyVsOpponent: { games: 0, era: null, whip: null, k9: null },
    statcastAvailable: false,
  };
}

function createFallbackTeam(team) {
  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    record: team.record || { wins: 0, losses: 0, pct: null, label: "0-0" },
    offense: {
      seasonOps: 0.71,
      seasonAvg: 0.245,
      seasonObp: 0.313,
      seasonSlg: 0.397,
      babip: 0.295,
      kRate: 0.22,
      bbRate: 0.08,
      seasonRunsPerGame: 4.2,
      runsLast10: 4.2,
      runsLast20: 4.2,
      runsLast30: 4.2,
      allowedLast10: 4.2,
      allowedLast20: 4.2,
      allowedLast30: 4.2,
      splitVsHandOps: 0.71,
      splitVsHandAvg: 0.245,
      splitVsHandBabip: 0.295,
      homeAwayOps: 0.71,
      rispAvg: 0.245,
      rispOps: 0.71,
      wrcPlus: null,
      recentGames: [],
    },
    bullpen: {
      era7: 4.1,
      era14: 4.1,
      innings7: "0.0",
      innings14: "0.0",
      usage48hInnings: "0.0",
      usage48hPitches: 0,
      usage48hAppearances: 0,
      leverageIndex: null,
    },
    lineup: {
      confirmed: false,
      players: [],
    },
    scheduleFatigue: {
      fatigueScore: 0,
      tier: "bajo",
      label: "Calendario normal",
    },
  };
}

function attachFallbackBullpenFatigue(team) {
  if (!team?.bullpen) return team;
  if (!team.bullpen.fatigue) {
    team.bullpen.fatigue = scoreBullpenFatigue(team.bullpen);
  }
  return team;
}

async function loadSchedule(date) {
  return callMlb("/schedule", {
    sportId: 1,
    date,
    hydrate: ["probablePitcher", "team", "venue"],
  }, "mlb-stats-api:schedule");
}

async function loadLiveFeed(gamePk) {
  return callMlbLive(`/game/${gamePk}/feed/live`, {}, `mlb-stats-api:feed:${gamePk}`);
}

async function loadPerson(personId) {
  return callMlb(`/people/${personId}`, {}, `mlb-stats-api:person:${personId}`);
}

async function loadPitcherRecentStats(personId, startDate, endDate) {
  return callMlb(`/people/${personId}/stats`, {
    stats: "byDateRange",
    group: "pitching",
    startDate,
    endDate,
  }, `mlb-stats-api:pitcher-range:${personId}`);
}

async function loadPitcherSeasonGameLog(personId, season) {
  return callMlb(`/people/${personId}/stats`, {
    stats: "gameLog",
    group: "pitching",
    season,
  }, `mlb-stats-api:pitcher-gamelog:${personId}:${season}`);
}

async function loadTeamRecentSchedule(teamId, startDate, endDate) {
  return callMlb("/schedule", {
    sportId: 1,
    teamId,
    startDate,
    endDate,
  }, `mlb-stats-api:team-schedule:${teamId}`);
}

async function loadTeamHittingSeason(teamId) {
  return callMlb(`/teams/${teamId}/stats`, {
    stats: "season",
    group: "hitting",
  }, `mlb-stats-api:team-hit-season:${teamId}`);
}

async function loadTeamHittingSplits(teamId) {
  return callMlb(`/teams/${teamId}/stats`, {
    stats: "statSplits",
    group: "hitting",
    sitCodes: ["vl", "vr", "h", "a", "risp"],
  }, `mlb-stats-api:team-hit-splits:${teamId}`);
}

async function loadBullpenRange(teamId, startDate, endDate) {
  return callMlb(`/teams/${teamId}/stats`, {
    stats: "byDateRange",
    group: "pitching",
    startDate,
    endDate,
    sitCodes: "rp",
  }, `mlb-stats-api:team-bullpen:${teamId}:${startDate}:${endDate}`);
}

async function loadBullpenSeasonHandSplits(teamId) {
  return callMlb(`/teams/${teamId}/stats`, {
    stats: "season",
    group: "pitching",
    sitCodes: "vl,vr",
  }, `mlb-stats-api:team-bullpen-hands:${teamId}`);
}

function estimateOpponentLeftHandPct(opposingPitcherHandCode) {
  if (opposingPitcherHandCode === "L") return 0.32;
  if (opposingPitcherHandCode === "R") return 0.28;
  return 0.38;
}

function effectiveBullpenEra(bullpen = {}, leftHandPct = 0.38) {
  const fallback = Number.isFinite(bullpen.era7)
    ? bullpen.era7
    : Number.isFinite(bullpen.era14)
      ? bullpen.era14
      : LEAGUE_AVG_BULLPEN_ERA;
  const eraVsLeft = Number.isFinite(bullpen.eraVsLeft) ? bullpen.eraVsLeft : fallback;
  const eraVsRight = Number.isFinite(bullpen.eraVsRight) ? bullpen.eraVsRight : fallback;
  const pctLeft = clamp(leftHandPct, 0.2, 0.55);
  return pctLeft * eraVsLeft + (1 - pctLeft) * eraVsRight;
}

function splitByCode(splits, code) {
  return splits.find((entry) => entry?.split?.code === code)?.stat || null;
}

function parseRecentRuns(schedulePayload, teamId) {
  const games = safeArray(schedulePayload?.dates)
    .flatMap((dateBlock) => safeArray(dateBlock.games))
    .filter((game) => game?.status?.abstractGameState === "Final");

  const summaries = games
    .map((game) => {
      const isHome = String(game?.teams?.home?.team?.id) === String(teamId);
      const team = isHome ? game?.teams?.home : game?.teams?.away;
      const opponent = isHome ? game?.teams?.away : game?.teams?.home;

      return {
        date: game?.officialDate || game?.gameDate,
        runsScored: asNumber(team?.score, 0),
        runsAllowed: asNumber(opponent?.score, 0),
      };
    })
    .sort((left, right) => String(right.date).localeCompare(String(left.date)));

  const runs = summaries.map((entry) => entry.runsScored);
  const allowed = summaries.map((entry) => entry.runsAllowed);

  return {
    games: summaries,
    runsLast10: round(avg(runs.slice(0, 10)), 2),
    runsLast20: round(avg(runs.slice(0, 20)), 2),
    runsLast30: round(avg(runs.slice(0, 30)), 2),
    allowedLast10: round(avg(allowed.slice(0, 10)), 2),
    allowedLast20: round(avg(allowed.slice(0, 20)), 2),
    allowedLast30: round(avg(allowed.slice(0, 30)), 2),
  };
}

function formatTeamRecord(leagueRecord) {
  const wins = asInteger(leagueRecord?.wins, 0);
  const losses = asInteger(leagueRecord?.losses, 0);
  const pct = asNumber(leagueRecord?.pct, NaN);
  return {
    wins,
    losses,
    pct: Number.isFinite(pct) ? round(pct, 3) : null,
    label: `${wins}-${losses}`,
  };
}

function parseLineupContext(feed, side) {
  const lineup = extractLineup(feed, side);
  return {
    confirmed: lineup.confirmed,
    players: lineup.players,
    leftHandPct: lineupLeftHandPct(feed, side),
  };
}

async function loadTeamContext(team, opposingPitcherHandCode, isHomeTeam, date, caches) {
  const teamId = team.id;
  const cacheKey = `${teamId}::${String(date).slice(0, 10)}`;
  if (!caches.teams.has(cacheKey)) {
    caches.teams.set(cacheKey, {});
  }
  const bucket = caches.teams.get(cacheKey);

  const recentStart = addDays(date, -45);
  const bullpen7Start = addDays(date, -7);
  const bullpen14Start = addDays(date, -14);
  const bullpen2Start = addDays(date, -2);

  bucket.recentSchedule ||= loadTeamRecentSchedule(teamId, recentStart, date).catch(() => null);
  bucket.hittingSeason ||= loadTeamHittingSeason(teamId).catch(() => null);
  bucket.hittingSplits ||= loadTeamHittingSplits(teamId).catch(() => null);
  bucket.bullpen7 ||= loadBullpenRange(teamId, bullpen7Start, date).catch(() => null);
  bucket.bullpen14 ||= loadBullpenRange(teamId, bullpen14Start, date).catch(() => null);
  bucket.bullpen2 ||= loadBullpenRange(teamId, bullpen2Start, date).catch(() => null);

  if (!bucket.bullpenHandSplits) {
    bucket.bullpenHandSplits = loadBullpenSeasonHandSplits(teamId).catch(() => null);
  }

  const [recentSchedule, hittingSeasonPayload, hittingSplitsPayload, bullpen7Payload, bullpen14Payload, bullpen2Payload, bullpenHandPayload] =
    await Promise.all([
      bucket.recentSchedule,
      bucket.hittingSeason,
      bucket.hittingSplits,
      bucket.bullpen7,
      bucket.bullpen14,
      bucket.bullpen2,
      bucket.bullpenHandSplits,
    ]);

  const hittingSeason = statLineFromPayload(hittingSeasonPayload);
  const hittingSplits = splitsFromPayload(hittingSplitsPayload);
  const bullpenHandSplits = splitsFromPayload(bullpenHandPayload);
  const bullpenVsLeft = splitByCode(bullpenHandSplits, "vl");
  const bullpenVsRight = splitByCode(bullpenHandSplits, "vr");
  const vsHandCode = opposingPitcherHandCode === "L" ? "vl" : opposingPitcherHandCode === "R" ? "vr" : null;
  const splitVsHand = splitByCode(hittingSplits, vsHandCode);
  const splitHomeAway = splitByCode(hittingSplits, isHomeTeam ? "h" : "a");
  const splitRisp = splitByCode(hittingSplits, "risp");
  const recentRuns = parseRecentRuns(recentSchedule, teamId);
  const seasonRunsPerGame = round(computeRunsPerGame(hittingSeason), 2);

  return {
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    record: team.record,
    offense: {
      seasonOps: asNumber(hittingSeason?.ops),
      seasonAvg: asNumber(hittingSeason?.avg),
      seasonObp: asNumber(hittingSeason?.obp),
      seasonSlg: asNumber(hittingSeason?.slg),
      babip: asNumber(hittingSeason?.babip),
      kRate: computeRate(hittingSeason?.strikeOuts, hittingSeason?.plateAppearances),
      bbRate: computeRate(hittingSeason?.baseOnBalls, hittingSeason?.plateAppearances),
      seasonRunsPerGame,
      runsLast10: recentRuns.runsLast10,
      runsLast20: recentRuns.runsLast20,
      runsLast30: recentRuns.runsLast30,
      allowedLast10: recentRuns.allowedLast10,
      allowedLast20: recentRuns.allowedLast20,
      allowedLast30: recentRuns.allowedLast30,
      splitVsHandOps: asNumber(splitVsHand?.ops, asNumber(hittingSeason?.ops)),
      splitVsHandAvg: asNumber(splitVsHand?.avg, asNumber(hittingSeason?.avg)),
      splitVsHandBabip: asNumber(splitVsHand?.babip, asNumber(hittingSeason?.babip)),
      homeAwayOps: asNumber(splitHomeAway?.ops, asNumber(hittingSeason?.ops)),
      rispAvg: asNumber(splitRisp?.avg, asNumber(hittingSeason?.avg)),
      rispOps: asNumber(splitRisp?.ops, asNumber(hittingSeason?.ops)),
      wrcPlus: null,
      recentGames: recentRuns.games.slice(0, 10),
    },
    bullpen: (() => {
      const bullpen = {
        era7: asNumber(statLineFromPayload(bullpen7Payload)?.era, NaN),
        era14: asNumber(statLineFromPayload(bullpen14Payload)?.era, NaN),
        innings7: statLineFromPayload(bullpen7Payload)?.inningsPitched || "0.0",
        innings14: statLineFromPayload(bullpen14Payload)?.inningsPitched || "0.0",
        usage48hInnings: statLineFromPayload(bullpen2Payload)?.inningsPitched || "0.0",
        usage48hPitches: asInteger(statLineFromPayload(bullpen2Payload)?.numberOfPitches, 0),
        usage48hAppearances: asInteger(statLineFromPayload(bullpen2Payload)?.gamesPitched, 0),
        leverageIndex: null,
        eraVsLeft: asNumber(bullpenVsLeft?.era, NaN),
        eraVsRight: asNumber(bullpenVsRight?.era, NaN),
      };
      bullpen.fatigue = scoreBullpenFatigue(bullpen);
      return bullpen;
    })(),
    scheduleFatigue: computeScheduleFatigue(recentSchedule, teamId, date),
  };
}

async function loadPitcherContext(pitcherId, pitcherName, opponentTeamId, scheduledAt, caches) {
  const season = asInteger(String(scheduledAt).slice(0, 4), new Date().getUTCFullYear());
  const endDate = String(scheduledAt).slice(0, 10);
  const startDate30 = addDays(endDate, -30);

  if (!caches.pitchers.has(pitcherId)) {
    caches.pitchers.set(pitcherId, {});
  }
  const bucket = caches.pitchers.get(pitcherId);
  // Incluir opponentTeamId en la clave para separar estadísticas por partido.
  // Sin esto, el mismo pitcher en dos juegos consecutivos de la misma serie
  // comparte el bucket y puede usar datos desactualizados del partido anterior.
  const rangeCacheKey = `${endDate}:${opponentTeamId}`;

  bucket.person ||= loadPerson(pitcherId).catch(() => null);
  if (!bucket.ranges) bucket.ranges = new Map();
  if (!bucket.ranges.has(rangeCacheKey)) {
    bucket.ranges.set(rangeCacheKey, loadPitcherRecentStats(pitcherId, startDate30, endDate).catch(() => null));
  }
  // El gameLog de temporada es estable — puede compartirse entre partidos del mismo pitcher.
  // Solo necesitamos recargar si la temporada cambia (no ocurre en mitad de temporada).
  const gameLogKey = `${season}`;
  if (!bucket.gamelogs) bucket.gamelogs = new Map();
  if (!bucket.gamelogs.has(gameLogKey)) {
    bucket.gamelogs.set(gameLogKey, loadPitcherSeasonGameLog(pitcherId, season).catch(() => null));
  }

  const [personPayload, recentRangePayload, gameLogCurrent] = await Promise.all([
    bucket.person,
    bucket.ranges.get(rangeCacheKey),
    bucket.gamelogs.get(gameLogKey),
  ]);

  const recentStatLine = statLineFromPayload(recentRangePayload);
  const recentMetric = computeXFipProxy(recentStatLine);
  const recentFip = computeFip(recentStatLine);
  const gameLogSplits = safeArray(gameLogCurrent?.stats?.[0]?.splits);
  const pitchCounts = aggregatePitchCounts(gameLogSplits);
  const lastStartDate = pitchCounts[0]?.date || null;
  const daysRest = lastStartDate ? daysBetween(lastStartDate, scheduledAt) : 5;
  const historyVsOpponent = computeHistoryVsOpponent([safeArray(gameLogCurrent?.stats?.[0]?.splits)], opponentTeamId);
  const recentStartsEra = computeRecentStartsEra(gameLogSplits);
  const era30 = asNumber(recentStatLine?.era, NaN);
  const fip30 = Number.isFinite(recentFip) ? round(recentFip, 2) : null;
  const xFip30 = Number.isFinite(recentMetric) ? round(recentMetric, 2) : null;
  const starts30 = asInteger(recentStatLine?.gamesStarted, 0);
  const whip30 = asNumber(recentStatLine?.whip, NaN);
  const k9 = asNumber(recentStatLine?.strikeoutsPer9Inn, NaN);
  const historyVsOpponentSummary = {
    games: historyVsOpponent.games,
    era: historyVsOpponent.era != null ? round(historyVsOpponent.era, 2) : null,
    whip: historyVsOpponent.whip != null ? round(historyVsOpponent.whip, 2) : null,
    k9: historyVsOpponent.strikeoutsPer9Inn != null ? round(historyVsOpponent.strikeoutsPer9Inn, 2) : null,
  };
  const pitcherMetricInput = {
    era30,
    xFip30,
    fip30,
    recentStartsEra,
    starts30,
    whip30,
    k9,
    historyVsOpponent: historyVsOpponentSummary,
  };
  const historyMeta = historyVsOpponentRunMetricMeta(pitcherMetricInput);

  const pitcherWins = asInteger(recentStatLine?.wins, 0);
  const pitcherLosses = asInteger(recentStatLine?.losses, 0);

  return {
    id: pitcherId,
    name: pitcherName,
    record: {
      wins: pitcherWins,
      losses: pitcherLosses,
      label: `${pitcherWins}-${pitcherLosses}`,
    },
    handCode: pitchHandCode(personPayload),
    handLabel: pitchHandLabel(pitchHandCode(personPayload)),
    handLabelFull: plainPitcherHand(pitchHandCode(personPayload)),
    era30,
    fip30,
    xFip30,
    recentStartsEra,
    regressedRunMetric: historyMeta.metric,
    whip30,
    k9,
    bb9: asNumber(recentStatLine?.walksPer9Inn, NaN),
    hr9: asNumber(recentStatLine?.homeRunsPer9, NaN),
    innings30: recentStatLine?.inningsPitched || "0.0",
    starts30,
    velocityFastball: null,
    spinRate: null,
    whiffRate: null,
    restDays: daysRest,
    recentPitchCounts: pitchCounts.slice(0, 3),
    previousPitchCount: pitchCounts[0]?.pitches || null,
    historyVsOpponent: historyVsOpponentSummary,
    _historyVsOpponentApplied: historyMeta.applied,
    _historyVsOpponentGames: historyMeta.games,
    _historyVsOpponentGap: historyMeta.gap,
    statcastAvailable: false,
  };
}

function bestMlbOdds(bookmakers = {}, type, side) {
  let best = null;

  for (const [bookmaker, market] of Object.entries(bookmakers)) {
    if (type === "moneyline" && market.winner) {
      const index = side === "home" ? 0 : 1;
      const odd = market.winner[index];
      if (Number.isFinite(odd) && (!best || odd > best.odd)) {
        best = { bookmaker, odd };
      }
    }

    if (type === "totals-over" && market.totals?.over) {
      if (!best || market.totals.over > best.odd) {
        best = { bookmaker, odd: market.totals.over };
      }
    }

    if (type === "totals-under" && market.totals?.under) {
      if (!best || market.totals.under > best.odd) {
        best = { bookmaker, odd: market.totals.under };
      }
    }

    if (type === "runline" && market.spreads) {
      const odd = side === "home" ? market.spreads.home : market.spreads.away;
      const point = side === "home" ? market.spreads.pointHome : market.spreads.pointAway;
      if (Number.isFinite(odd) && Number.isFinite(point) && Math.abs(point) >= 1.5 && (!best || odd > best.odd)) {
        best = { bookmaker, odd, point };
      }
    }
  }

  return best;
}

async function loadMlbOddsMap(apiKey) {
  if (!apiKey) return new Map();

  const events = await callTheOdds("/sports/baseball_mlb/odds", apiKey, {
    regions: DEFAULT_ODDS_REGIONS,
    markets: DEFAULT_ODDS_MARKETS,
    oddsFormat: "decimal",
  }).catch(() => []);

  const map = new Map();
  for (const event of safeArray(events)) {
    const teamKey = createMatchKey(event.home_team, event.away_team);
    const normalizedTime = normalizeCommenceTime(event.commence_time || event.commenceTime);
    if (event.id) map.set(`event:${event.id}`, event);
    if (normalizedTime) {
      const dateKey = normalizedTime.slice(0, 10);
      map.set(`${teamKey}::${dateKey}::${normalizedTime}`, event);
      if (!map.has(`${teamKey}::${dateKey}`)) map.set(`${teamKey}::${dateKey}`, event);
    }
  }
  return map;
}

function inferTotalsLineFromBookmakers(bookmakers, fallbackTotal) {
  for (const market of Object.values(bookmakers || {})) {
    const line = market?.totals?.line;
    if (Number.isFinite(line)) return line;
  }
  return fallbackTotal;
}

function buildMlbBookmakers(event, fallbackTotal) {
  if (!event) return { bookmakers: {}, totalsLine: fallbackTotal };
  if (event.bookmakers && !Array.isArray(event.bookmakers)) {
    const bookmakers = event.bookmakers;
    const totalsLine =
      Number.isFinite(event.totalsLine) && event.totalsLine !== fallbackTotal
        ? event.totalsLine
        : inferTotalsLineFromBookmakers(bookmakers, event.totalsLine ?? fallbackTotal);
    return { bookmakers, totalsLine };
  }
  const normalized = normalizeBookmakersFromTheOdds(event, fallbackTotal);
  return {
    ...normalized,
    totalsLine: inferTotalsLineFromBookmakers(normalized.bookmakers, normalized.totalsLine),
  };
}

function moneylineModelProbability(sideRaw, rivalRaw) {
  const diff = sideRaw - rivalRaw;
  return clamp(0.5 + diff / 80, 0.18, 0.86);
}

function elitePitcherMultiplier(eff) {
  if (eff <= 2.0) return 0.72;
  if (eff <= 2.5) return 0.78;
  if (eff <= 3.0) return 0.85;
  if (eff <= 3.5) return 0.92;
  return 1.0;
}

function projectTeamRuns(offense, opposingPitcher, opposingBullpen, park, opposingPitcherHandCode = null, lineupLeftPctValue = null) {
  const recent10 = Number.isFinite(offense.runsLast10) ? offense.runsLast10 : 4.2;
  const recent20 = Number.isFinite(offense.runsLast20) ? offense.runsLast20 : recent10;
  const recent30 = Number.isFinite(offense.runsLast30) ? offense.runsLast30 : recent20;
  const pitcherRunMetric = effectivePitcherRunMetric(opposingPitcher);
  const pitcherWhip = Number.isFinite(opposingPitcher.whip30) ? opposingPitcher.whip30 : 1.24;
  const leftPct = Number.isFinite(lineupLeftPctValue)
    ? clamp(lineupLeftPctValue, 0.15, 0.65)
    : estimateOpponentLeftHandPct(opposingPitcherHandCode || opposingPitcher?.handCode);
  const bullpenEra = effectiveBullpenEra(opposingBullpen, leftPct);
  const bullpenPitches = asNumber(opposingBullpen.usage48hPitches, 0);
  const recentBase = recent10 * 0.4 + recent20 * 0.35 + recent30 * 0.25;
  const recentBaseAdjusted = recentBase * elitePitcherMultiplier(pitcherRunMetric);
  const offenseVsPitcher = computeOffenseVsPitcherMatchup(offense, opposingPitcher);
  const pitcherPenalty =
    (pitcherRunMetric - 4.05) * 0.3 +
    (pitcherWhip - 1.22) * 0.75;
  const bullpenFatigueScore = Number(opposingBullpen?.fatigue?.score) || 0;
  const bullpenPressure =
    (bullpenEra - 4.0) * 0.16 +
    (bullpenPitches / 180) * 0.16 +
    bullpenFatigueScore * 0.07;
  const parkBoost = (park.runFactor - 1) * 1.35;

  return clamp(
    recentBaseAdjusted + offenseVsPitcher.runDelta + pitcherPenalty + bullpenPressure + parkBoost,
    2.4,
    6.2
  );
}

function computeAdjustedProjections(game) {
  const weatherAdj = game.weatherAdjustment || { homeDelta: 0, awayDelta: 0, totalDelta: 0, runAdjust: 0 };
  const rawWeatherAdj = weatherAdj.runAdjust ?? weatherAdj.totalDelta ?? 0;
  // Proteger contra NaN: ?? no filtra NaN (solo null/undefined)
  const weatherMult = clamp(1 + (Number.isFinite(rawWeatherAdj) ? rawWeatherAdj : 0), 0.75, 1.25);

  const homePitchInj = computeMlbPitcherInjuryImpact({
    starterStatus: game.homePitcher?.status,
    pitcherName: game.homePitcher?.name,
  });
  const awayPitchInj = computeMlbPitcherInjuryImpact({
    starterStatus: game.awayPitcher?.status,
    pitcherName: game.awayPitcher?.name,
  });
  const homePitchOutBoost = homePitchInj.injuryPenalty * 0.15;
  const awayPitchOutBoost = awayPitchInj.injuryPenalty * 0.15;

  const homeBase = projectTeamRuns(
    game.homeTeam.offense,
    game.awayPitcher,
    game.awayTeam.bullpen,
    game.park,
    game.awayPitcher?.handCode,
    game.homeTeam.lineup?.leftHandPct
  );
  const awayBase = projectTeamRuns(
    game.awayTeam.offense,
    game.homePitcher,
    game.homeTeam.bullpen,
    game.park,
    game.homePitcher?.handCode,
    game.awayTeam.lineup?.leftHandPct
  );
  const home = clamp(round(homeBase * weatherMult + awayPitchOutBoost, 2), 2.0, 7.0);
  const away = clamp(round(awayBase * weatherMult + homePitchOutBoost, 2), 2.0, 7.0);
  const line = Number.isFinite(game.totalsLine) ? game.totalsLine : 8.5;
  const simulation = monteCarloGameDistribution(home, away, {
    line,
    spreadHome: -1.5,
    iterations: 5000,
    variance: game.bothLineupsConfirmed ? 0.14 : 0.2,
  });
  return {
    home,
    away,
    total: round(home + away, 2),
    simulation,
  };
}

function resolveModelProbability(game, type, options = {}) {
  const sim = game?.simulation;
  if (!sim) return options.fallback ?? null;

  if (type === "moneyline") {
    const side = options.side;
    const simProb = side === "home" ? sim.homeWinProb : 1 - sim.homeWinProb;
    const scoreProb = options.scoreProb;
    if (Number.isFinite(scoreProb)) {
      return round(simProb * 0.82 + scoreProb * 0.18, 3);
    }
    return simProb;
  }
  if (type === "totals") {
    return options.wantsOver ? sim.overProb : sim.underProb;
  }
  if (type === "team-total") {
    const lambda = options.side === "home" ? game.projections?.homeRuns : game.projections?.awayRuns;
    if (!Number.isFinite(lambda) || !Number.isFinite(options.line)) return null;
    const pOver = probTeamTotalOver(lambda, options.line);
    return options.wantsOver ? pOver : 1 - pOver;
  }
  if (type === "runline") {
    const side = options.side;
    const raw = side === "home" ? sim.homeCoverProb : 1 - sim.homeCoverProb;
    return calibrateRunLineProbability(raw);
  }
  return options.fallback ?? null;
}

function buildGameRiskNotes(game) {
  return plainRiskNotes(game);
}

function scoreSide(game, side) {
  const ownPitcher = side === "home" ? game.homePitcher : game.awayPitcher;
  const rivalPitcher = side === "home" ? game.awayPitcher : game.homePitcher;
  const ownTeam = side === "home" ? game.homeTeam : game.awayTeam;
  const rivalTeam = side === "home" ? game.awayTeam : game.homeTeam;
  const ownBullpen = ownTeam.bullpen;
  const rivalBullpen = rivalTeam.bullpen;

  const ownRunMetric = effectivePitcherRunMetric(ownPitcher);
  const rivalRunMetric = effectivePitcherRunMetric(rivalPitcher);
  const offenseVsRivalPitcher = computeOffenseVsPitcherMatchup(ownTeam.offense, rivalPitcher);

  const pitcherOwnScore =
    tierPitcherRunMetric(ownRunMetric) +
    tierWhip(ownPitcher.whip30) +
    tierK9(ownPitcher.k9) +
    tierRest(ownPitcher.restDays);

  const pitcherRivalScore =
    tierPitcherVulnerability(rivalRunMetric) +
    tierWhipVulnerability(rivalPitcher.whip30) +
    tierK9Vulnerability(rivalPitcher.k9) +
    tierRestVulnerability(rivalPitcher.restDays);

  const locationOps = side === "home" ? ownTeam.offense.homeAwayOps : null;
  const seasonOpsProxy = locationOps || ownTeam.offense.splitVsHandOps || ownTeam.offense.seasonOps;
  const splitDiff = seasonOpsProxy - ownTeam.offense.seasonOps;
  const trendDiff = ownTeam.offense.runsLast10 - ownTeam.offense.seasonRunsPerGame;
  const offenseScore =
    tierOpsProxy(seasonOpsProxy) +
    tierSplitAdvantage(splitDiff) +
    tierRunTrend(trendDiff) +
    Math.round(offenseVsRivalPitcher.scorePoints);

  let contextAdjustment = 0;
  if (ownBullpen.era7 < rivalBullpen.era7) contextAdjustment += 3;
  if (ownBullpen.usage48hPitches < rivalBullpen.usage48hPitches - 20) contextAdjustment += 2;
  const ownBpFatigue = ownBullpen.fatigue?.score || 0;
  const rivalBpFatigue = rivalBullpen.fatigue?.score || 0;
  if (rivalBpFatigue >= 5) contextAdjustment += 2;
  if (ownBpFatigue >= 5) contextAdjustment -= 2;
  const ownSchedFatigue = ownTeam.scheduleFatigue?.fatigueScore || 0;
  const rivalSchedFatigue = rivalTeam.scheduleFatigue?.fatigueScore || 0;
  if (rivalSchedFatigue >= 4) contextAdjustment += 2;
  if (ownSchedFatigue >= 4) contextAdjustment -= 2;
  if (ownTeam.lineup.confirmed && rivalTeam.lineup.confirmed) contextAdjustment += 2;
  if (game.park.category === "Favorece bateo" && ownTeam.offense.splitVsHandOps > 0.77) contextAdjustment += 2;
  if (game.park.category === "Favorece pitcheo" && ownRunMetric < 3.7) contextAdjustment += 2;
  const hvs = ownPitcher.historyVsOpponent;
  if (hvs?.games >= 3 && hvs.era != null) {
    if (hvs.era < 3.0) contextAdjustment += 2;
    else if (hvs.era > 5.0) contextAdjustment -= 2;
  }
  const recentFormDelta = recentPitcherFormRunDelta(ownPitcher);
  if (recentFormDelta > 0.25) contextAdjustment -= Math.min(Math.round(recentFormDelta * 8), 4);
  else if (recentFormDelta === 0 && Number.isFinite(ownPitcher.recentStartsEra) && ownPitcher.recentStartsEra + 0.5 < ownRunMetric) {
    contextAdjustment += 2;
  }

  const rawNoMarket = pitcherOwnScore + pitcherRivalScore + offenseScore + contextAdjustment;

  return {
    pitcherOwnScore,
    pitcherRivalScore,
    offenseScore,
    contextAdjustment,
    rawNoMarket,
    ownRunMetric,
    rivalRunMetric,
  };
}

function buildSideMoneylineCandidate(game, side, homeScore, awayScore) {
  const selectedTeam = side === "home" ? game.homeTeam : game.awayTeam;
  const selectedPitcher = side === "home" ? game.homePitcher : game.awayPitcher;
  const rivalPitcher = side === "home" ? game.awayPitcher : game.homePitcher;
  const score = side === "home" ? homeScore : awayScore;
  const rivalScore = side === "home" ? awayScore : homeScore;
  const scoreProb = moneylineModelProbability(score.rawNoMarket, rivalScore.rawNoMarket);
  const modelProbability = resolveModelProbability(game, "moneyline", {
    side,
    scoreProb,
    fallback: scoreProb,
  });
  const bestOdds = bestMlbOdds(game.bookmakers, "moneyline", side);
  const impliedProbability = bestOdds?.odd ? 1 / bestOdds.odd : null;

  let marketScore = 0;
  if (bestOdds?.odd && impliedProbability != null) {
    if (impliedProbability < 0.6 && modelProbability > 0.7) marketScore = 15;
    else if ((modelProbability * bestOdds.odd) > 1.05) marketScore = 12;
    else if ((modelProbability * bestOdds.odd) > 1) marketScore = 6;
    else marketScore = 1;
  }

  let confidence = clamp(
    round(score.rawNoMarket * 0.55 + modelProbability * 100 * 0.45 + marketScore, 1),
    38,
    96
  );
  const anchor = applyMarketAnchor(confidence, modelProbability, impliedProbability);
  confidence = anchor.confidence;
  const modelEv = evFromProbability(modelProbability, bestOdds?.odd);
  const bettable = Boolean(
    bestOdds?.odd &&
    confidence >= 70 &&
    modelEv != null &&
    modelEv >= 0.05
  );

  return {
    side,
    selectedTeam,
    selectedPitcher,
    rivalPitcher,
    score,
    scoreProb,
    modelProbability,
    bestOdds,
    impliedProbability,
    marketScore,
    confidence,
    modelEv,
    bettable,
    anchor,
  };
}

function buildMoneylineRecommendation(game, homeScore, awayScore) {
  const homeCand = buildSideMoneylineCandidate(game, "home", homeScore, awayScore);
  const awayCand = buildSideMoneylineCandidate(game, "away", homeScore, awayScore);
  const homeRank = Number.isFinite(homeCand.modelEv) ? homeCand.modelEv : -1;
  const awayRank = Number.isFinite(awayCand.modelEv) ? awayCand.modelEv : -1;

  let chosen = homeCand;
  if (awayRank > homeRank + 0.005) {
    chosen = awayCand;
  } else if (Math.abs(awayRank - homeRank) <= 0.005 && awayCand.score.rawNoMarket > homeCand.score.rawNoMarket) {
    chosen = awayCand;
  }

  const selectedSide = chosen.side;
  const chooseHome = selectedSide === "home";
  const {
    selectedTeam,
    selectedPitcher,
    rivalPitcher,
    score,
    modelProbability,
    bestOdds,
    impliedProbability,
    marketScore,
    confidence,
    modelEv,
    bettable,
    anchor,
  } = chosen;

  return {
    id: `${game.id}-moneyline-${selectedSide}`,
    type: "moneyline",
    matchId: game.id,
    matchLabel: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
    selection: formatMlbMoneylineSelection(selectedTeam.name),
    market: MLB_MARKETS.moneyline.label,
    marketKey: "moneyline",
    confidence,
    scoreBreakdown: {
      ownPitcher: score.pitcherOwnScore,
      rivalPitcher: score.pitcherRivalScore,
      offense: score.offenseScore,
      market: marketScore,
    },
    scoreFactors: formatScoreFactors({
      ownPitcher: score.pitcherOwnScore,
      rivalPitcher: score.pitcherRivalScore,
      offense: score.offenseScore,
      market: marketScore,
    }),
    bookmaker: bestOdds?.bookmaker || null,
    odds: bestOdds?.odd || null,
    impliedProbability: impliedProbability != null ? round(impliedProbability, 3) : null,
    modelProbability: round(modelProbability, 3),
    ev: modelEv,
    evPercent: modelEv != null ? round(modelEv * 100, 1) : null,
    bettable,
    teamSide: selectedSide,
    marketDisagreement: anchor.marketDisagreement,
    marketGapPp: anchor.marketGapPp,
    rationale: plainMoneylineRationale(game, selectedTeam, chooseHome, selectedPitcher, rivalPitcher),
    riskFlags: buildGameRiskNotes(game),
    details: {
      ownPitcherMetric: effectivePitcherRunMetric(selectedPitcher),
      rivalPitcherMetric: effectivePitcherRunMetric(rivalPitcher),
      offenseVsPitcher: computeOffenseVsPitcherMatchup(
        selectedSide === "home" ? game.homeTeam.offense : game.awayTeam.offense,
        rivalPitcher
      ),
      homeEv: homeCand.modelEv,
      awayEv: awayCand.modelEv,
    },
  };
}

function resolveModelProbabilityAtLine(game, wantsOver, line, homeLambda, awayLambda) {
  const simAtLine = monteCarloGameDistribution(homeLambda, awayLambda, {
    line,
    spreadHome: -1.5,
    iterations: 2000,
    variance: game.bothLineupsConfirmed ? 0.14 : 0.2,
  });
  const poissonProb = wantsOver
    ? probTotalOver(homeLambda, awayLambda, line)
    : 1 - probTotalOver(homeLambda, awayLambda, line);
  const simProb = wantsOver ? simAtLine.overProb : simAtLine.underProb;
  return round(simProb * 0.65 + poissonProb * 0.35, 3);
}

function applyPushRiskAdjustment(ev, projectedTotal, line) {
  if (!Number.isFinite(ev) || !Number.isFinite(projectedTotal) || !Number.isFinite(line)) return ev;
  const diff = Math.abs(projectedTotal - line);
  if (diff < 0.5) return round(ev * 0.65, 4);
  if (diff < 1.0) return round(ev * 0.8, 4);
  if (diff < 1.5) return round(ev * 0.92, 4);
  return ev;
}

function buildTotalRecommendation(game) {
  const homeProjection =
    game.projections?.homeRuns ??
    projectTeamRuns(
      game.homeTeam.offense,
      game.awayPitcher,
      game.awayTeam.bullpen,
      game.park,
      game.awayPitcher?.handCode,
      game.homeTeam.lineup?.leftHandPct
    );
  const awayProjection =
    game.projections?.awayRuns ??
    projectTeamRuns(
      game.awayTeam.offense,
      game.homePitcher,
      game.homeTeam.bullpen,
      game.park,
      game.homePitcher?.handCode,
      game.awayTeam.lineup?.leftHandPct
    );
  const totalProjection = game.projections?.totalRuns ?? round(homeProjection + awayProjection, 2);
  const preliminaryWantsOver = totalProjection >= game.totalsLine;
  const preliminaryQuote =
    bestMlbTotalsQuote(game.bookmakers, preliminaryWantsOver, game.totalsLine) ||
    bestMlbTotalsQuote(game.bookmakers, !preliminaryWantsOver, game.totalsLine);
  const activeLine = Number.isFinite(preliminaryQuote?.line) ? preliminaryQuote.line : game.totalsLine;
  const wantsOver = totalProjection >= activeLine;
  const finalQuote =
    bestMlbTotalsQuote(game.bookmakers, wantsOver, activeLine) ||
    preliminaryQuote || { bookmaker: null, odd: null, line: activeLine };
  const impliedProbability = finalQuote?.odd ? 1 / finalQuote.odd : null;
  const diff = Math.abs(totalProjection - activeLine);
  const confidenceBase = 48 + diff * 11 + (game.park.runFactor > 1.06 && wantsOver ? 5 : 0) + (game.park.runFactor < 0.95 && !wantsOver ? 5 : 0);
  const marketBoost =
    impliedProbability != null && finalQuote?.odd
      ? ((wantsOver ? totalProjection > activeLine : totalProjection < activeLine) && (1 / finalQuote.odd) < 0.56 ? 8 : 2)
      : 0;
  const homePitcherMetric = effectivePitcherRunMetric(game.homePitcher);
  const awayPitcherMetric = effectivePitcherRunMetric(game.awayPitcher);
  const minPitcherMetric = Math.min(homePitcherMetric, awayPitcherMetric);
  const dominancePenalty = wantsOver && minPitcherMetric < 2.5
    ? round(Math.min((2.5 - minPitcherMetric) * 9, 18), 1)
    : 0;
  const modelProbability = resolveModelProbabilityAtLine(
    game,
    wantsOver,
    activeLine,
    homeProjection,
    awayProjection
  );
  const modelEv = applyPushRiskAdjustment(
    evFromProbability(modelProbability, finalQuote?.odd),
    totalProjection,
    activeLine
  );
  let confidence = clamp(round(confidenceBase + marketBoost - dominancePenalty, 1), 35, 92);
  const anchor = applyMarketAnchor(confidence, modelProbability, impliedProbability);
  confidence = anchor.confidence;
  const bettable = Boolean(
    finalQuote?.odd &&
    confidence >= 70 &&
    (modelEv == null || modelEv >= 0.03)
  );

  return {
    id: `${game.id}-totals-${wantsOver ? "over" : "under"}`,
    type: "totals",
    matchId: game.id,
    matchLabel: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
    selection: formatMlbRunsSelection(wantsOver, activeLine),
    market: MLB_MARKETS.totals.label,
    marketKey: "totals",
    line: activeLine,
    totalsLine: activeLine,
    confidence,
    scoreBreakdown: {
      projectionDiff: round(diff * 10, 1),
      parkFactor: round((game.park.runFactor - 1) * 100, 1),
      market: marketBoost,
    },
    scoreFactors: formatScoreFactors({
      projectionDiff: round(diff * 10, 1),
      parkFactor: round((game.park.runFactor - 1) * 100, 1),
      market: marketBoost,
    }),
    bookmaker: finalQuote?.bookmaker || null,
    odds: finalQuote?.odd || null,
    impliedProbability: impliedProbability != null ? round(impliedProbability, 3) : null,
    modelProbability,
    ev: modelEv,
    evPercent: modelEv != null ? round(modelEv * 100, 1) : null,
    bettable,
    marketDisagreement: anchor.marketDisagreement,
    marketGapPp: anchor.marketGapPp,
    totalProjection,
    simulation: game.simulation || null,
    rationale: plainTotalsRationale(game, totalProjection, homeProjection, awayProjection, wantsOver),
    riskFlags: buildGameRiskNotes(game),
  };
}

function buildTeamTotalRecommendation(game, side) {
  const team = side === "home" ? game.homeTeam : game.awayTeam;
  const pitcher = side === "home" ? game.awayPitcher : game.homePitcher;
  const bullpen = side === "home" ? game.awayTeam.bullpen : game.homeTeam.bullpen;
  const projection =
    side === "home"
      ? game.projections?.homeRuns
      : game.projections?.awayRuns;
  const projectionRuns = round(
    Number.isFinite(projection)
      ? projection
      : projectTeamRuns(team.offense, pitcher, bullpen, game.park, pitcher?.handCode, team.lineup?.leftHandPct),
    2
  );
  const marketKey = side === "home" ? "teamTotalHome" : "teamTotalAway";
  const offers = [];

  for (const [bookmaker, markets] of Object.entries(game.bookmakers || {})) {
    const teamTotal = markets?.[marketKey];
    if (!teamTotal) continue;
    offers.push({
      bookmaker,
      line: Number.isFinite(teamTotal.line) ? teamTotal.line : null,
      over: Number.isFinite(teamTotal.over) ? teamTotal.over : null,
      under: Number.isFinite(teamTotal.under) ? teamTotal.under : null,
    });
  }

  let line = offers.find((offer) => Number.isFinite(offer.line))?.line ?? null;
  if (!Number.isFinite(line)) {
    line = side === "home" ? 4.5 : 4.0;
  }

  const wantsOver = projectionRuns >= line;
  const matchingOffers = offers.filter((offer) => Number.isFinite(offer.line) && Math.abs(offer.line - line) <= 0.01);
  const pricePool = matchingOffers.length ? matchingOffers : offers;
  let bestOdd = null;
  let bestBook = null;

  for (const offer of pricePool) {
    const odd = wantsOver ? offer.over : offer.under;
    if (Number.isFinite(odd) && (!bestOdd || odd > bestOdd)) {
      bestOdd = odd;
      bestBook = offer.bookmaker;
    }
  }

  const lineDelta = Math.abs(projectionRuns - line);
  if (lineDelta < 0.6) return null;

  const pitcherPenalty = pitcher.xFip30 >= 4.2 ? 12 : pitcher.xFip30 >= 3.8 ? 6 : 2;
  const offenseStrength =
    team.offense.splitVsHandOps >= 0.75 ? 10 : team.offense.splitVsHandOps >= 0.7 ? 6 : 2;
  const parkBoost = game.park.runFactor > 1.05 && wantsOver ? 6 : 0;
  const deltaScore = Math.min(lineDelta * 12, 18);
  const rawConfidence = pitcherPenalty + offenseStrength + parkBoost + deltaScore;
  const confidence = clamp(round(rawConfidence, 1), 38, 88);
  const bettable = confidence >= 68 && lineDelta >= 0.8 && Number.isFinite(bestOdd);

  if (confidence < 52) return null;

  const impliedProbability = Number.isFinite(bestOdd) ? round(1 / bestOdd, 3) : null;
  const heuristicProb = clamp(round(0.52 + lineDelta * 0.06, 3), 0.52, 0.78);
  const modelProbability =
    resolveModelProbability(game, "team-total", {
      side,
      line,
      wantsOver,
      fallback: heuristicProb,
    }) ?? heuristicProb;
  const ev = evFromProbability(modelProbability, bestOdd);
  const selection = formatMlbRunsSelection(wantsOver, line, team.name);

  return {
    id: `${game.id}-team-total-${side}-${wantsOver ? "over" : "under"}`,
    type: "team-total",
    matchId: game.id,
    matchLabel: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
    market: `Total de carreras ${side === "home" ? "local" : "visitante"}`,
    marketKey,
    selection,
    selectionLabel: selection,
    side,
    wantsOver,
    line,
    projection: projectionRuns,
    lineDelta,
    confidence,
    scoreBreakdown: {
      projectionDiff: round(lineDelta * 10, 1),
      rivalPitcher: pitcherPenalty,
      offense: offenseStrength,
      parkFactor: parkBoost,
    },
    scoreFactors: formatScoreFactors({
      projectionDiff: round(lineDelta * 10, 1),
      rivalPitcher: pitcherPenalty,
      offense: offenseStrength,
      parkFactor: parkBoost,
    }),
    bookmaker: bestBook || null,
    odds: bestOdd || null,
    impliedProbability,
    modelProbability,
    ev,
    bettable,
    preferLeanWithoutOdds: true,
    teamSide: side,
    rationale: (() => {
      const rivalForm = plainPitcherFormStats(pitcher);
      return (
        `Proyeccion ${projectionRuns} carreras para ${team.name} frente a linea ${line}. ` +
        `Pitcher rival ${pitcher.name || "N/D"}: xFIP ${Number.isFinite(pitcher.xFip30) ? pitcher.xFip30 : "N/D"}` +
        `${rivalForm ? ` (${rivalForm})` : ""} · park factor ${game.park.runFactor}.`
      );
    })(),
    riskFlags: buildGameRiskNotes(game),
    details: {
      pitcherMetric: Number.isFinite(pitcher.xFip30) ? pitcher.xFip30 : pitcher.era30,
      bullpenEra: bullpen?.eraLast10 ?? null,
    },
  };
}

function buildRunLineRecommendation(game, moneylineRecommendation, homeScore, awayScore) {
  const side = moneylineRecommendation.teamSide;
  const selectedTeam = side === "home" ? game.homeTeam : game.awayTeam;
  const ownPitcher = side === "home" ? game.homePitcher : game.awayPitcher;
  const ownScore = side === "home" ? homeScore : awayScore;
  const rivalScore = side === "home" ? awayScore : homeScore;
  const bestOdds = bestMlbOdds(game.bookmakers, "runline", side);
  if (!bestOdds?.odd || !Number.isFinite(bestOdds.point)) return null;

  const isFavoriteLine = bestOdds.point <= -1.5;
  const isDogLine = bestOdds.point >= 1.5;
  if (!isFavoriteLine && !isDogLine) return null;

  const rawGap = ownScore.rawNoMarket - rivalScore.rawNoMarket;
  const confidence = clamp(
    round(52 + rawGap * 0.7 + (isFavoriteLine ? 6 : 4) + (ownPitcher.restDays >= 5 ? 2 : 0), 1),
    38,
    90
  );
  const bettable = moneylineRecommendation.bettable && confidence >= 70;

  if (rawGap < 8 && isFavoriteLine) return null;

  return {
    id: `${game.id}-runline-${side}`,
    type: "runline",
    matchId: game.id,
    matchLabel: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
    selection: `${selectedTeam.name} ${bestOdds.point > 0 ? "+" : ""}${bestOdds.point}`,
    market: MLB_MARKETS.runline.label,
    marketKey: "runline",
    confidence,
    scoreBreakdown: {
      pitcherGap: round(rawGap, 1),
      market: 6,
    },
    scoreFactors: formatScoreFactors({
      pitcherGap: round(rawGap, 1),
      market: 6,
    }),
    bookmaker: bestOdds.bookmaker,
    odds: bestOdds.odd,
    impliedProbability: round(1 / bestOdds.odd, 3),
    modelProbability: resolveModelProbability(game, "runline", {
      side,
      fallback: clamp(0.5 + rawGap / 120, 0.35, 0.72),
    }),
    bettable,
    teamSide: side,
    rationale: plainRunLineRationale(selectedTeam, bestOdds.point, rawGap, ownPitcher),
    riskFlags: buildGameRiskNotes(game),
  };
}

function classifyRecommendation(confidence) {
  return plainRecommendationTier(confidence);
}

function valueLabelFromEv(ev) {
  if (!Number.isFinite(ev)) return "Sin valor";
  if (ev >= 0.1) return "Alto valor";
  if (ev >= 0.05) return "Valor moderado";
  if (ev >= 0.02) return "Valor marginal";
  return "Sin valor";
}

/** Puntuación para ordenar picks: EV acotado + confianza (evita penalizar run lines con EV null). */
function mlbPickRankScore(pick) {
  const score = Number.isFinite(pick?.score_final)
    ? pick.score_final / 100
    : Number.isFinite(pick?.score)
      ? pick.score / 100
      : 0;
  const ev = Number.isFinite(pick?.ev) ? pick.ev : Number.isFinite(pick?.ev_model) ? pick.ev_model : -1;
  const conf = Number.isFinite(pick?.confidence) ? pick.confidence / 100 : 0;
  const edge = Math.abs(Number.isFinite(pick?.edge) ? pick.edge : 0);
  const runlineBoost = pick?.type === "runline" && pick.confidence >= 75 ? 0.03 : 0;
  const valueBoost = pick?.valueModeApplied || pick?.valueBettable ? 0.05 : 0;
  return score * 0.55 + ev * 1.5 + conf * 0.3 + edge * 0.8 + runlineBoost + valueBoost;
}

function compareMlbPicksForRank(left, right) {
  const scoreDelta = mlbPickRankScore(right) - mlbPickRankScore(left);
  if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
  return (right.odds || 0) - (left.odds || 0);
}

function hasMlbConfEdgeConflict(pick) {
  const confidence = Number(pick?.confidence ?? pick?.confianza);
  const edge = Number(pick?.edge);
  return (
    Number.isFinite(confidence) &&
    Number.isFinite(edge) &&
    confidence >= MLB_CONF_EDGE_CONFLICT_CONFIDENCE &&
    Math.abs(edge) < MLB_CONF_EDGE_CONFLICT_EDGE
  );
}

function isPromotedMlbPick(pick) {
  const odds = Number(pick?.odds);
  if (!isMlbRecommendationBettable(pick)) return false;
  if (hasMlbConfEdgeConflict(pick)) return false;
  if (Number.isFinite(odds) && odds < MLB_PROMOTED_PICK_MIN_ODDS) return false;
  return true;
}

function mlbBetSideFromRec(rec) {
  if (rec.type === "moneyline" || rec.type === "runline") return rec.teamSide || null;
  if (rec.type === "totals" || rec.type === "team-total") {
    const sel = String(rec.selection || "").toLowerCase();
    return sel.includes("(+)") || sel.includes("más de") ? "over" : "under";
  }
  return null;
}

function hasRealRecommendationOdds(rec) {
  const odds = Number(rec?.odds);
  return Number.isFinite(odds) && odds > 1 && Boolean(rec?.bookmaker);
}

function applyMlbMarketSignals(game, valueBets, dropEntry) {
  const drop12h = dropEntry?.odds?.drop?.["12h"] || 0;
  const dropBetSide = dropEntry?.betSide || null;

  for (const rec of game.recommendations) {
    const targetBetSide = mlbBetSideFromRec(rec);

    const matchingVb = valueBets.find((vb) => valueBetMatchesRecommendation(rec, vb));

    if (matchingVb?.expectedValue && hasRealRecommendationOdds(rec)) {
      const rawEv = matchingVb.expectedValue / 100;
      const marketEv = normalizeExpectedValueMlb(rawEv);
      const localEv = Number.isFinite(rec.ev) ? rec.ev : null;
      if (marketEv != null && (localEv == null || marketEv > localEv)) {
        rec.ev = marketEv;
        rec.evPercent = round(marketEv * 100, 1);
        rec.evRaw = round(rawEv, 3);
        rec.evCapped = Math.abs(rawEv) > MLB_EV_ABS_CAP + 0.0001;
        rec.valueBetApplied = true;
        rec.valueLabel = valueLabelFromEv(marketEv);
      }
    }

    if (drop12h >= 5 && targetBetSide) {
      rec.drop12h = drop12h;
      const dropConfirms = dropBetSide === targetBetSide;
      if (dropConfirms) {
        rec.senalDoble = Boolean(matchingVb);
        rec.droppingOddsSignal = "confirmed";
        const boost = Math.min(Math.floor(drop12h / 4), 6);
        rec.confidence = clamp(round(rec.confidence + boost, 1), rec.confidence, 96);
      } else if (drop12h >= 10) {
        rec.droppingOddsSignal = "faded";
        rec.droppingOddsWarning = true;
        const penalty = Math.min(Math.floor(drop12h / 4), 10);
        rec.confidence = clamp(round(rec.confidence - penalty, 1), 38, rec.confidence);
        if (rec.bettable && rec.confidence < 70) rec.bettable = false;
      }
    }
  }
}

function enrichRecommendation(recommendation, hasOddsKey, game) {
  const marketSpec = mlbMarketSpecFromRecommendation(recommendation);
  const oddsComparison = buildOddsComparison(game?.bookmakers || {}, marketSpec);
  const oddsGapFactor = buildOddsGapFactor(oddsComparison);
  const hasRealOdds = hasRealRecommendationOdds(recommendation);
  const impliedProbability =
    hasRealOdds && Number.isFinite(recommendation.odds) ? round(1 / recommendation.odds, 3) : null;
  const oddsInRange =
    hasRealOdds &&
    Number.isFinite(recommendation.odds) &&
    recommendation.odds >= MLB_MIN_ODDS &&
    recommendation.odds <= MLB_MAX_ODDS;
  let evRaw =
    oddsInRange && Number.isFinite(recommendation.modelProbability)
      ? evFromProbability(recommendation.modelProbability, recommendation.odds)
      : null;
  if (
    recommendation.type === "totals" ||
    recommendation.marketKey === "totals" ||
    recommendation.marketKey === "game_total"
  ) {
    evRaw = applyPushRiskAdjustment(
      evRaw,
      recommendation.totalProjection ?? game?.projections?.totalRuns,
      recommendation.totalsLine ?? recommendation.line ?? game?.totalsLine
    );
  }
  const ev = normalizeExpectedValueMlb(evRaw);
  const evCapped =
    Number.isFinite(evRaw) && Number.isFinite(ev) && Math.abs(evRaw - ev) > 0.0001;
  const openingOdds = hasRealOdds
    ? recommendation.openingOdds ?? (Number.isFinite(recommendation.odds) ? recommendation.odds : null)
    : null;
  const finalBettable = Boolean(recommendation.bettable && oddsInRange && ev != null);
  const finalVerdict = finalBettable
    ? "valid"
    : recommendation.confidence >= 55 ||
        (recommendation.preferLeanWithoutOdds && !hasRealOdds && recommendation.confidence >= 52)
      ? "lean"
      : "avoid";

  const rationale = appendPitchersContextToRationale(recommendation.rationale, game);

  return {
    ...recommendation,
    status: game?.status || recommendation.status || "Scheduled",
    scheduledAt: game?.startTime || recommendation.scheduledAt || null,
    rationale,
    evCapped: hasRealOdds ? recommendation.evCapped ?? evCapped : false,
    evRaw: Number.isFinite(evRaw) ? round(evRaw, 3) : null,
    openingOdds,
    bookmaker: hasRealOdds ? oddsComparison.bestBookmaker || recommendation.bookmaker || null : null,
    confidence: clamp(
      round(recommendation.confidence + (oddsGapFactor.confidenceBoost || 0), 1),
      38,
      96
    ),
    bettable: finalBettable,
    proBettable: hasRealOdds ? recommendation.proBettable : false,
    valueBettable: hasRealOdds ? recommendation.valueBettable : false,
    valueModeApplied: hasRealOdds ? recommendation.valueModeApplied : false,
    verdict: finalVerdict,
    verdictLabel: hasRealOdds ? plainVerdictLabel(finalVerdict, hasOddsKey) : "Sin cuota real: EV no calculable",
    schedule: formatEventSchedule(game?.startTime, {
      tournament: "MLB",
      venue: game?.stadium,
    }),
    impliedProbability,
    ev,
    evPercent: Number.isFinite(ev) ? round(ev * 100, 1) : null,
    oddsGap: hasRealOdds ? oddsGapFactor.oddsGap : null,
    valueBook: hasRealOdds ? oddsGapFactor.valueBook : null,
    valueLabel: plainMlbValueHeadline(recommendation, ev),
    sportContextNote: plainMlbPitchingBattingContext(game),
    oddsComparison,
    scoreFactors: oddsGapFactor.summary
      ? [
          ...(recommendation.scoreFactors || []),
          {
            key: oddsGapFactor.key,
            label: oddsGapFactor.label,
            help: oddsGapFactor.summary,
            value: oddsGapFactor.score,
          },
        ]
      : recommendation.scoreFactors,
  };
}

function topLeans(games) {
  return games
    .map((game) => game.modelLean)
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5);
}

function topPicks(games) {
  const eligible = games
    .flatMap((game) => game.recommendations)
    .filter((pick) => isPromotedMlbPick(pick) && pick.color !== "gris" && !pick.discarded);

  const sorted = [...eligible].sort(compareMlbPicksForRank);
  const topRunline = sorted.find(
    (pick) => pick.type === "runline" && pick.confidence >= 75 && Number.isFinite(pick.ev) && pick.ev >= 0.05
  );
  const core = sorted.slice(0, 6);
  const merged =
    topRunline && !core.some((pick) => pick.id === topRunline.id)
      ? [...core.slice(0, 5), topRunline].sort(compareMlbPicksForRank)
      : core;

  return merged.map((pick, index) => ({
    ...pick,
    rank: index + 1,
  }));
}

function topModelPicks(games, limit = 12) {
  return games
    .flatMap((game) =>
      game.recommendations.map((pick) => ({
        ...pick,
        gameId: game.id,
        park: game.park.category,
        projections: game.projections,
      }))
    )
    .sort((left, right) => {
      const ranked = compareMlbPicksForRank(left, right);
      if (ranked !== 0) return ranked;
      const leftWeight = left.verdict === "valid" ? 2 : left.verdict === "lean" ? 1 : 0;
      const rightWeight = right.verdict === "valid" ? 2 : right.verdict === "lean" ? 1 : 0;
      if (rightWeight !== leftWeight) return rightWeight - leftWeight;
      return (right.odds || 0) - (left.odds || 0);
    })
    .slice(0, limit)
    .map((pick, index) => ({
      ...pick,
      rank: index + 1,
    }));
}

function topRunsPicks(games, limit = 8) {
  return games
    .map((game) =>
      [...game.recommendations]
        .filter((pick) => pick.type === "totals" || pick.type === "team-total")
        .sort((left, right) => right.confidence - left.confidence)[0]
    )
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, limit)
    .map((pick, index) => ({
      ...pick,
      rank: index + 1,
    }));
}

function topTeamPicks(games, limit = 8) {
  return games
    .map((game) => game.recommendations.find((pick) => pick.type === "moneyline"))
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, limit)
    .map((pick, index) => ({
      ...pick,
      rank: index + 1,
    }));
}

function summarizeGames(games) {
  return games.map((game) => {
    const sorted = [...game.recommendations].sort((left, right) => right.confidence - left.confidence);
    const bestRuns = sorted.find((pick) => pick.type === "totals" || pick.type === "team-total") || null;
    const bestTeam = sorted.find((pick) => pick.type === "moneyline") || null;
    const bestOverall = sorted[0] || null;

    return {
      gameId: game.id,
      matchLabel: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
      projections: game.projections,
      bestOverall,
      bestRuns,
      bestTeam,
      recommendations: sorted,
    };
  });
}

function buildParlays(picks) {
  const parlays = [];
  const filtered = picks.filter((pick) => pick.type !== "runline");

  for (let index = 0; index < filtered.length; index += 1) {
    for (let inner = index + 1; inner < filtered.length; inner += 1) {
      const first = filtered[index];
      const second = filtered[inner];
      if (first.matchId === second.matchId) continue;
      if (!first.odds || !second.odds) continue;

      const totalOdds = round(first.odds * second.odds, 2);
      if (totalOdds < 1.5 || totalOdds > 2.2) continue;

      parlays.push({
        id: `parlay-${first.id}-${second.id}`,
        selections: [first, second],
        totalOdds,
        rationale:
          "Combina dos selecciones de alta confianza en partidos distintos, evitando correlacion negativa directa.",
      });

      if (parlays.length >= 2) {
        return parlays;
      }
    }
  }

  return parlays;
}

function getProviderManifest(hasOddsKey) {
  return [
    {
      id: "schedule-stats",
      name: "MLB Stats API",
      status: "configured",
      purpose: "Calendario, pitchers probables, lineups, jugadores y splits oficiales MLB.",
      docs: "https://statsapi.mlb.com/api/v1/schedule",
      productionCandidates: ["MLB Stats API"],
    },
    {
      id: "advanced-metrics",
      name: "Baseball Savant / PyBaseball",
      status: "partial",
      purpose: "xFIP, Statcast, velocidad, spin y whiff rate avanzados.",
      docs: "https://baseballsavant.mlb.com/",
      productionCandidates: ["Baseball Savant", "PyBaseball"],
      notes: "Esta version usa xFIP proxy calculada desde MLB Stats API; Statcast puro aun no esta conectado.",
    },
    {
      id: "weather",
      name: "Open-Meteo",
      status: "configured",
      purpose: "Temperatura y viento por estadio para ajustar proyección de carreras (sin API key).",
      docs: "https://open-meteo.com/",
    },
    {
      id: "odds",
      name: hasOddsKey && process.env.ODDS_API_IO_KEY ? "Odds-API.io" : "The Odds API",
      status: hasOddsKey ? "configured" : "missing-credentials",
      purpose: hasOddsKey && process.env.ODDS_API_IO_KEY
        ? "Moneyline, totales y run line desde Odds-API.io (250+ casas)."
        : "Moneyline, totals y run line desde multiples bookmakers.",
      docs: hasOddsKey && process.env.ODDS_API_IO_KEY ? "https://docs.odds-api.io/" : "https://the-odds-api.com/sports-odds-data/mlb-odds.html",
      productionCandidates: hasOddsKey && process.env.ODDS_API_IO_KEY ? ["Odds-API.io"] : ["The Odds API"],
    },
  ];
}

function computeCoverage(games, hasOddsKey) {
  const lineupRate = games.length
    ? games.reduce((sum, game) => sum + (game.homeTeam.lineup.confirmed ? 1 : 0) + (game.awayTeam.lineup.confirmed ? 1 : 0), 0) / (games.length * 2)
    : 0;

  return {
    schedule: games.length ? 1 : 0,
    lineups: round(lineupRate, 2),
    pitching: 0.84,
    hitting: 0.82,
    bullpen: 0.82,
    weather: games.length
      ? round(games.filter((g) => g.weather?.label).length / games.length, 2)
      : 0,
    odds: hasOddsKey ? round(games.reduce((sum, game) => sum + (game.oddsAvailable ? 1 : 0), 0) / Math.max(games.length, 1), 2) : 0,
    simulation: games.length
      ? round(games.filter((g) => g.simulation).length / games.length, 2)
      : 0,
    statcast: 0,
  };
}

function computeStaleness(games, hasOddsKey) {
  const statuses = games.map((game) => game.status);
  const liveActive = statuses.some((status) => status === "Live" || status === "In Progress");
  return {
    schedule: liveActive ? 5 : 12,
    odds: hasOddsKey ? 7 : 999,
    lineups: 15,
  };
}

/** Datos deportivos cargados en esta corrida (independiente de cuotas). */
function isMlbStructuralDataFresh(homePitcher, awayPitcher, homeTeam, awayTeam) {
  if (!homePitcher?.id || !awayPitcher?.id) return false;
  const pitcherMetricsLoaded =
    Number.isFinite(homePitcher.era30) ||
    Number.isFinite(homePitcher.xFip30) ||
    Number.isFinite(awayPitcher.era30) ||
    Number.isFinite(awayPitcher.xFip30) ||
    (Number(homePitcher.starts30) > 0 || Number(awayPitcher.starts30) > 0);
  const offenseLoaded =
    Number.isFinite(homeTeam?.offense?.seasonRunsPerGame) &&
    Number.isFinite(awayTeam?.offense?.seasonRunsPerGame);
  return pitcherMetricsLoaded && offenseLoaded;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function buildGameContext(rawGame, date, oddsMap, caches, hasOddsConfigured = false) {
  if (isMlbGameAlreadyPlayed(rawGame)) return null;

  const homeRaw = rawGame?.teams?.home;
  const awayRaw = rawGame?.teams?.away;
  const homePitcherRaw = homeRaw?.probablePitcher;
  const awayPitcherRaw = awayRaw?.probablePitcher;
  const homeTeamRaw = homeRaw?.team;
  const awayTeamRaw = awayRaw?.team;
  if (!homeTeamRaw || !awayTeamRaw) return null;

  const gamePk = rawGame.gamePk;
  caches.feeds.set(gamePk, loadLiveFeed(gamePk).catch(() => null));
  const feed = await caches.feeds.get(gamePk);
  const homePitcherName = homePitcherRaw?.fullName || feed?.gameData?.probablePitchers?.home?.fullName || "Pendiente";
  const awayPitcherName = awayPitcherRaw?.fullName || feed?.gameData?.probablePitchers?.away?.fullName || "Pendiente";
  const homePitcherId = homePitcherRaw?.id || feed?.gameData?.probablePitchers?.home?.id || null;
  const awayPitcherId = awayPitcherRaw?.id || feed?.gameData?.probablePitchers?.away?.id || null;
  const homePitcher = homePitcherId
    ? await loadPitcherContext(homePitcherId, homePitcherName, awayTeamRaw.id, rawGame.gameDate, caches).catch(() => createFallbackPitcher(homePitcherId, homePitcherName))
    : createFallbackPitcher(null, homePitcherName);
  const awayPitcher = awayPitcherId
    ? await loadPitcherContext(awayPitcherId, awayPitcherName, homeTeamRaw.id, rawGame.gameDate, caches).catch(() => createFallbackPitcher(awayPitcherId, awayPitcherName))
    : createFallbackPitcher(null, awayPitcherName);

  // Marcar si algún pitcher no está confirmado — el modelo debe penalizar la confianza
  homePitcher.isPending = !homePitcherId || homePitcherName === "Pendiente" || homePitcherName === "TBD";
  awayPitcher.isPending = !awayPitcherId || awayPitcherName === "Pendiente" || awayPitcherName === "TBD";
  const hasPendingPitcher = homePitcher.isPending || awayPitcher.isPending;

  homePitcher.status =
    homePitcherRaw?.status || feed?.gameData?.probablePitchers?.home?.status || rawGame?.status?.detailedState;
  awayPitcher.status =
    awayPitcherRaw?.status || feed?.gameData?.probablePitchers?.away?.status || rawGame?.status?.detailedState;

  const homeSeed = {
    id: homeTeamRaw.id,
    name: homeTeamRaw.name,
    abbreviation: homeTeamRaw.abbreviation,
    record: formatTeamRecord(homeRaw.leagueRecord),
  };
  const awaySeed = {
    id: awayTeamRaw.id,
    name: awayTeamRaw.name,
    abbreviation: awayTeamRaw.abbreviation,
    record: formatTeamRecord(awayRaw.leagueRecord),
  };

  const [homeTeam, awayTeam] = await Promise.all([
    loadTeamContext(homeSeed, awayPitcher.handCode, true, date, caches).catch(() => attachFallbackBullpenFatigue(createFallbackTeam(homeSeed))),
    loadTeamContext(awaySeed, homePitcher.handCode, false, date, caches).catch(() => attachFallbackBullpenFatigue(createFallbackTeam(awaySeed))),
  ]);

  homeTeam.lineup = parseLineupContext(feed, "home");
  awayTeam.lineup = parseLineupContext(feed, "away");

  const park = parkProfile(rawGame?.venue?.name || "Unknown Park");
  const rawOddsEntry = findProOddsEntry(
    oddsMap,
    homeTeamRaw.name,
    awayTeamRaw.name,
    null,
    date,
    rawGame.gameDate
  );
  const normalizedOdds = buildMlbBookmakers(rawOddsEntry, 8.5);

  const game = {
    id: String(gamePk),
    sport: "mlb",
    status: rawGame?.status?.detailedState || "Scheduled",
    startTime: rawGame?.gameDate,
    scheduleDate: date,
    officialDate: rawGame?.officialDate || String(rawGame?.gameDate || "").slice(0, 10) || date,
    stadium: rawGame?.venue?.name || "Unknown Park",
    park,
    homeTeam,
    awayTeam,
    homePitcher,
    awayPitcher,
    totalsLine: normalizedOdds.totalsLine || 8.5,
    bookmakers: normalizedOdds.bookmakers,
    oddsAvailable: Object.keys(normalizedOdds.bookmakers).length > 0,
    oddsApiIoEventId: rawOddsEntry?.eventId || null,
    notes: [],
  };

  game.bothLineupsConfirmed = Boolean(homeTeam.lineup.confirmed && awayTeam.lineup.confirmed);
  game.hasPendingPitcher = hasPendingPitcher;
  game.pitcherDataQuality = hasPendingPitcher ? "pending" : isMlbStructuralDataFresh(homePitcher, awayPitcher, homeTeam, awayTeam) ? "full" : "partial";
  game.umpire = parseUmpireFromFeed(feed);
  const weather = await loadGameWeather(homeTeamRaw.id, rawGame.gameDate, park).catch(() => null);
  game.weather = weather;
  game.weatherAdjustment = weatherRunAdjustment(weather, park, homeTeamRaw.id);

  const homePitchInjPreview = computeMlbPitcherInjuryImpact({
    starterStatus: homePitcher.status,
    pitcherName: homePitcher.name,
  });
  const awayPitchInjPreview = computeMlbPitcherInjuryImpact({
    starterStatus: awayPitcher.status,
    pitcherName: awayPitcher.name,
  });
  const [lmMoneyline, lmTotals] = await Promise.all([
    getOddsHarvesterMatchContext({
      home: homeTeam.name,
      away: awayTeam.name,
      sport: "mlb",
      marketKey: "moneyline",
      eventId: rawOddsEntry?.eventId || null,
      scheduleDate: date,
      startTime: rawGame?.gameDate,
    }).catch(() => null),
    getOddsHarvesterMatchContext({
      home: homeTeam.name,
      away: awayTeam.name,
      sport: "mlb",
      marketKey: "game_total",
      eventId: rawOddsEntry?.eventId || null,
      scheduleDate: date,
      startTime: rawGame?.gameDate,
    }).catch(() => null),
  ]);
  game.lineMovementInput = {
    pct_tickets_home: lmMoneyline?.pct_tickets_home ?? 50,
    pct_tickets_away: lmMoneyline?.pct_tickets_away ?? (lmMoneyline?.pct_tickets_home != null ? 100 - lmMoneyline.pct_tickets_home : 50),
    pct_money_home: lmMoneyline?.pct_money_home ?? 50,
    cuota_apertura_home: lmMoneyline?.cuota_apertura_home ?? null,
    cuota_apertura_away: lmMoneyline?.cuota_apertura_away ?? null,
    cuota_actual_home: lmMoneyline?.cuota_actual_home ?? null,
    cuota_actual_away: lmMoneyline?.cuota_actual_away ?? null,
    linea_apertura: lmTotals?.linea_apertura ?? game.totalsLine,
    linea_actual: lmTotals?.linea_actual ?? game.totalsLine,
    game_total_apertura: lmTotals?.linea_apertura ?? null,
  };
  game.mlbContext = {
    hay_noticia_lesion: Boolean(homePitchInjPreview.injuryPenalty || awayPitchInjPreview.injuryPenalty),
    sampleGames: Math.min(homeTeam.offense?.gamesPlayed || 0, awayTeam.offense?.gamesPlayed || 0) || null,
    flags: {
      stats_espn_disponibles: Boolean(homePitcherId && awayPitcherId),
      mercado_actualizado: game.oddsAvailable,
      alineacion_confirmada: game.bothLineupsConfirmed,
      lesiones_confirmadas: Boolean(homePitchInjPreview.injuryPenalty || awayPitchInjPreview.injuryPenalty),
      h2h_relevante: Boolean(homePitcher._historyVsOpponentApplied || awayPitcher._historyVsOpponentApplied),
      clima_disponible: Boolean(weather),
      muestra_suficiente: Boolean(homePitcherId && awayPitcherId),
      freshness_ok: isMlbStructuralDataFresh(homePitcher, awayPitcher, homeTeam, awayTeam),
      pitcher_confirmado: Boolean(homePitcherId && awayPitcherId),
      pitcher_era_contradictorio:
        pitcherEraContradictory(homePitcher) || pitcherEraContradictory(awayPitcher),
      muestra_insuficiente_pitcher:
        pitcherInsufficientSample(homePitcher) || pitcherInsufficientSample(awayPitcher),
      bullpen_era_7d: (() => {
        const homeEra = homeTeam.bullpen?.era7;
        const awayEra = awayTeam.bullpen?.era7;
        if (Number.isFinite(homeEra) && Number.isFinite(awayEra)) return (homeEra + awayEra) / 2;
        if (Number.isFinite(homeEra)) return homeEra;
        if (Number.isFinite(awayEra)) return awayEra;
        return null;
      })(),
      datos_parciales:
        !game.bothLineupsConfirmed ||
        !Number.isFinite(homeTeam.bullpen?.era7) ||
        !Number.isFinite(awayTeam.bullpen?.era7),
    },
  };

  const adjusted = computeAdjustedProjections(game);
  game.projections = {
    homeRuns: adjusted.home,
    awayRuns: adjusted.away,
    totalRuns: adjusted.total,
    diffVsLine: round(adjusted.total - game.totalsLine, 2),
  };
  game.simulation = adjusted.simulation;
  game.proContext = {
    weather: weather?.label || null,
    weatherNote: game.weatherAdjustment?.note || null,
    umpire: game.umpire?.label || null,
    homeBullpenFatigue: homeTeam.bullpen?.fatigue?.label || null,
    awayBullpenFatigue: awayTeam.bullpen?.fatigue?.label || null,
    homeScheduleFatigue: homeTeam.scheduleFatigue?.label || null,
    awayScheduleFatigue: awayTeam.scheduleFatigue?.label || null,
    monteCarlo: {
      homeWinPct: percent(game.simulation.homeWinProb),
      overPct: percent(game.simulation.overProb),
      expectedTotal: game.simulation.expectedTotal,
    },
  };

  const homeScore = scoreSide(game, "home");
  const awayScore = scoreSide(game, "away");

  const moneyline = enrichRecommendation(
    buildMoneylineRecommendation(game, homeScore, awayScore),
    hasOddsConfigured,
    game
  );
  const totals = enrichRecommendation(buildTotalRecommendation(game), hasOddsConfigured, game);
  const runLine = buildRunLineRecommendation(game, moneyline, homeScore, awayScore);
  const teamTotalHome = buildTeamTotalRecommendation(game, "home");
  const teamTotalAway = buildTeamTotalRecommendation(game, "away");
  const recommendations = [
    moneyline,
    totals,
    runLine ? enrichRecommendation(runLine, hasOddsConfigured, game) : null,
    teamTotalHome ? enrichRecommendation(teamTotalHome, hasOddsConfigured, game) : null,
    teamTotalAway ? enrichRecommendation(teamTotalAway, hasOddsConfigured, game) : null,
  ].filter(Boolean);
  const modelLean = {
    ...moneyline,
    market: moneyline.odds ? moneyline.market : "Idea del modelo (sin cuota)",
    bettable: moneyline.bettable,
  };

  game.recommendations = recommendations;
  game.modelLean = modelLean;
  game.bestRunsPick =
    [...recommendations]
      .filter((pick) => pick.type === "totals" || pick.type === "team-total")
      .sort((left, right) => right.confidence - left.confidence)[0] || totals;
  game.bestTeamPick = moneyline;
  game.teamStatsPrediction = buildTeamStatsPrediction(game, homeScore, awayScore, game.projections);
  game.parkPlain = game.park.category;
  game.scoreSummary = {
    home: clamp(round(homeScore.rawNoMarket + (moneyline.teamSide === "home" ? moneyline.scoreBreakdown.market : 0), 1), 0, 100),
    away: clamp(round(awayScore.rawNoMarket + (moneyline.teamSide === "away" ? moneyline.scoreBreakdown.market : 0), 1), 0, 100),
  };
  game.notes = buildGameRiskNotes(game);
  game.recommendationTier = classifyRecommendation(modelLean.confidence);
  game.schedule = formatEventSchedule(game.startTime, {
    tournament: "MLB",
    venue: game.stadium,
  });

  return game;
}

function resolveMlbOddsRuntime() {
  const oddsApiIoKey = process.env.ODDS_API_IO_KEY || "";
  const theOddsKey = process.env.THE_ODDS_API_KEY || "";
  const preferred = process.env.MLB_ODDS_PROVIDER || (oddsApiIoKey ? "odds-api-io" : "the-odds-api");

  if (preferred === "odds-api-io" && oddsApiIoKey) {
    return {
      provider: "odds-api-io",
      hasOddsKey: true,
      config: {
        oddsApiIo: {
          apiKey: oddsApiIoKey,
          baseUrl: process.env.ODDS_API_IO_BASE_URL || "https://api.odds-api.io/v3",
          bookmakers: (process.env.ODDS_API_IO_BOOKMAKERS || "Bet365,Winamax FR")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        },
      },
    };
  }

  return {
    provider: theOddsKey ? "the-odds-api" : "none",
    hasOddsKey: Boolean(theOddsKey),
    config: null,
    theOddsKey,
  };
}

async function loadMlbOddsMapForRuntimeMulti(dates, runtime) {
  if (runtime.provider === "odds-api-io") {
    return loadMlbOddsMapFromOddsApiIoForDates(dates, runtime.config);
  }
  return loadMlbOddsMap(runtime.theOddsKey || "");
}

function buildMlbUnavailableAnalysis(date, reason, oddsRuntime, hasOddsKey) {
  const providers = getProviderManifest(hasOddsKey);

  return {
    app: "Tennis Oracle",
    module: "MLB Desk",
    sport: "mlb",
    date,
    generatedAt: new Date().toISOString(),
    dataAvailable: false,
    unavailableReason: reason,
    methodology: plainMethodology(hasOddsKey),
    providers,
    runtime: {
      dataProvider: "mlb-stats-api",
      oddsProvider: oddsRuntime.provider,
      statcastProvider: "pending",
      unavailableReason: reason,
      pickMode: MLB_PICK_MODE === "pro" || MLB_PICK_MODE === "strict" ? "pro" : "value",
      valueEvMin: MLB_VALUE_EV_MIN,
      valueEdgeMin: MLB_VALUE_EDGE_MIN,
    },
    coverage: { schedule: 0, odds: 0, lineups: 0, overall: 0 },
    stalenessMinutes: 999,
    slateSummary: {
      gamesAnalyzed: 0,
      recommendationsGenerated: 0,
      readyRecommendations: 0,
      lineupsConfirmed: 0,
    },
    picks: [],
    modelPicks: [],
    runsPicks: [],
    teamPicks: [],
    gameSummaries: [],
    leans: [],
    parlays: [],
    games: [],
    riskNotes: [
      "No se pudo cargar el calendario MLB ni construir el analisis del dia.",
      reason,
    ],
  };
}

export async function buildMlbAnalysis(date) {
  const oddsRuntime = resolveMlbOddsRuntime();
  const hasOddsKey = oddsRuntime.hasOddsKey;
  const providers = getProviderManifest(hasOddsKey);
  const yesterday = shiftDateString(date, -1);
  const nextDay = shiftDateString(date, 1);

  let todayPayload = null;
  let yesterdayPayload = null;
  let nextDayPayload = null;
  try {
    [todayPayload, yesterdayPayload, nextDayPayload] = await Promise.all([
      loadSchedule(date),
      loadSchedule(yesterday).catch(() => null),
      loadSchedule(nextDay).catch(() => null),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return buildMlbUnavailableAnalysis(
      date,
      `Datos no disponibles: no se pudo cargar el calendario MLB (${reason}).`,
      oddsRuntime,
      hasOddsKey
    );
  }

  const seenGameIds = new Set();
  const rawGamesWithDate = [];
  for (const [scheduleDate, payload] of [[yesterday, yesterdayPayload], [date, todayPayload], [nextDay, nextDayPayload]]) {
    if (!payload) continue;
    for (const rawGame of safeArray(payload?.dates?.[0]?.games)) {
      if (isMlbGameAlreadyPlayed(rawGame)) continue;
      const gameId = String(rawGame.gamePk || rawGame.gameId || rawGame.id || "");
      if (!gameId || seenGameIds.has(gameId)) continue;
      seenGameIds.add(gameId);
      rawGamesWithDate.push({ rawGame, scheduleDate });
    }
  }

  if (rawGamesWithDate.length === 0) {
    return buildMlbUnavailableAnalysis(
      date,
      "Datos no disponibles: no hay partidos MLB para ayer, hoy ni mañana.",
      oddsRuntime,
      hasOddsKey
    );
  }

  const slateDates = [yesterday, date, nextDay];
  const skipSignals = oddsApiSkipMarketSignals();
  const [oddsMap, vbBet365, vbWinamax, droppingOdds] = await Promise.all([
    loadMlbOddsMapForRuntimeMulti(slateDates, oddsRuntime).catch(() => new Map()),
    skipSignals ? Promise.resolve([]) : loadBaseballValueBets("Bet365").catch(() => []),
    skipSignals ? Promise.resolve([]) : loadBaseballValueBets("Winamax FR").catch(() => []),
    skipSignals
      ? Promise.resolve([])
      : loadBaseballDroppingOdds(Number.parseFloat(process.env.MLB_DROP_MIN || "5"), "12h").catch(() => []),
  ]);

  const mlbVbIndex = {};
  const mlbDropIndex = {};
  [...vbBet365, ...vbWinamax].forEach((vb) => {
    if (!vb?.eventId) return;
    const key = String(vb.eventId);
    if (!mlbVbIndex[key]) mlbVbIndex[key] = [];
    mlbVbIndex[key].push(vb);
  });
  droppingOdds.forEach((entry) => {
    if (!entry?.eventId) return;
    const key = String(entry.eventId);
    const drop12h = entry.odds?.drop?.["12h"] || 0;
    if (!mlbDropIndex[key] || drop12h > (mlbDropIndex[key]?.odds?.drop?.["12h"] || 0)) {
      mlbDropIndex[key] = entry;
    }
  });

  const caches = {
    teams: new Map(),
    pitchers: new Map(),
    feeds: new Map(),
  };

  const games = (
    await mapWithConcurrency(rawGamesWithDate, 3, ({ rawGame, scheduleDate }) =>
      buildGameContext(rawGame, scheduleDate, oddsMap, caches, hasOddsKey)
    )
  ).filter((game) => game && isMlbGameUpcoming(game));

  // Invalidar cache del schedule del día siguiente si algún partido tiene pitcher pendiente.
  // Esto garantiza que el próximo prewarm recargue desde MLB API con los pitchers actualizados
  // en lugar de servir el snapshot cacheado con probablePitcher = null.
  {
    const hasPendingNextDay = games.some((g) => g.hasPendingPitcher && g.scheduleDate === nextDay);
    if (hasPendingNextDay) {
      const nextDayUrl = buildMlbUrl("/schedule", {
        sportId: 1, date: nextDay, hydrate: ["probablePitcher", "team", "venue"],
      });
      if (peekCacheEntry(MLB_CACHE_NAMESPACE, nextDayUrl)) {
        // Invalida caché MLB para que el próximo análisis recargue schedule (pitchers actualizados)
        clearNamespaceCache(MLB_CACHE_NAMESPACE);
        console.info(`[mlb-cache] Schedule ${nextDay} expirado por pitcher(s) pendiente(s) — se recargará en el próximo análisis.`);
      }
    }
  }

  if (games.length === 0) {
    return buildMlbUnavailableAnalysis(
      date,
      "Datos no disponibles: el calendario llego pero no se pudo analizar ningun partido con datos completos.",
      oddsRuntime,
      hasOddsKey
    );
  }

  for (const game of games) {
    const eventId = String(game.oddsApiIoEventId || "");
    if (eventId) {
      applyMlbMarketSignals(game, mlbVbIndex[eventId] || [], mlbDropIndex[eventId] || null);
    }
    applyMlbProScoringToGame(game);
    if (game.modelLean) {
      game.recommendationTier = classifyRecommendation(game.modelLean.confidence);
    }
  }

  const upcomingGames = games.filter((game) => game && isMlbInSlateWindow(game, date));
  const bettableGames = upcomingGames.filter((game) => (
    Array.isArray(game?.recommendations) &&
    game.recommendations.some(isPromotedMlbPick)
  ));

  const gamesPendingYesterday = upcomingGames.filter((game) => String(game.scheduleDate || "").slice(0, 10) === yesterday).length;
  const gamesToday = upcomingGames.filter((game) => String(game.scheduleDate || "").slice(0, 10) === date).length;
  const gamesNextDay = upcomingGames.filter((game) => String(game.scheduleDate || "").slice(0, 10) === nextDay).length;

  const picks = topPicks(bettableGames);
  const modelPicks = topModelPicks(upcomingGames);
  const runsPicks = topRunsPicks(upcomingGames);
  const teamPicks = topTeamPicks(upcomingGames);
  const gameSummaries = summarizeGames(upcomingGames);
  const leans = topLeans(upcomingGames);
  const parlays = buildParlays(picks);
  persistAnalyzerPicksFromMatches(upcomingGames, "mlb", mapMlbPickToBacktestRecord).catch((err) => {
    console.warn("[backtesting] MLB persist:", err.message);
  });
  const lineupsConfirmed = upcomingGames.reduce(
    (sum, game) => sum + (game.homeTeam.lineup.confirmed ? 1 : 0) + (game.awayTeam.lineup.confirmed ? 1 : 0),
    0
  );

  return {
    app: "Tennis Oracle",
    module: "MLB Desk",
    sport: "mlb",
    date,
    generatedAt: new Date().toISOString(),
    dataAvailable: true,
    methodology: plainMethodology(hasOddsKey),
    providers,
    runtime: {
      dataProvider: "mlb-stats-api",
      oddsProvider: oddsRuntime.provider,
      statcastProvider: "pending",
      probabilityEngine: "poisson-monte-carlo",
      weatherProvider: "open-meteo",
      pickMode: MLB_PICK_MODE === "pro" || MLB_PICK_MODE === "strict" ? "pro" : "value",
      valueEvMin: MLB_VALUE_EV_MIN,
      valueEdgeMin: MLB_VALUE_EDGE_MIN,
    },
    coverage: computeCoverage(games, hasOddsKey),
    stalenessMinutes: computeStaleness(games, hasOddsKey),
    slateSummary: {
      gamesToday,
      gamesPendingYesterday,
      gamesNextDay,
      gamesBettable: bettableGames.length,
      gamesAnalyzed: upcomingGames.length,
      gamesScanned: games.length,
      recommendationsGenerated: upcomingGames.reduce((sum, game) => sum + game.recommendations.length, 0),
      readyRecommendations: picks.length,
      lineupsConfirmed,
    },
    picks,
    modelPicks,
    runsPicks,
    teamPicks,
    gameSummaries,
    leans,
    parlays,
    games: upcomingGames,
    bettableGames,
    riskNotes: plainSlateRiskNotes(hasOddsKey),
  };
}
