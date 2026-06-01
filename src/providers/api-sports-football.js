import { shiftDateString } from "../utils/madrid-date.js";
import { fetchJson } from "./shared/http.js";
import { loadWithCache, peekCacheEntry } from "./shared/resource-cache.js";
import { canonicalName } from "./shared/tennis-normalizers.js";

const DISCOVERY_NAMESPACE = "api-sports-football:discovery";
const DETAIL_NAMESPACE = "api-sports-football:detail";
const PREDICTIONS_NAMESPACE = "api-sports-football:predictions";
const LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT"]);
const MATCH_SCORE_MIN = 0.68;
const DETAIL_LOOKAHEAD_MINUTES = 210;
const MAX_DISCOVERY_DATES = 2;

function normalizeTeamName(value) {
  return canonicalName(value)
    .replace(/\b(football club|football|fc|cf|fk|ac|afc|club|deportivo|club de futbol|sad|ud|cd|sc|bk|kvinner|women|ladies|femenino)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createOrderedKey(home, away) {
  return `${normalizeTeamName(home)}::${normalizeTeamName(away)}`;
}

function createTokenSet(value) {
  return new Set(normalizeTeamName(value).split(" ").filter(Boolean));
}

function overlapScore(left, right) {
  const leftText = normalizeTeamName(left);
  const rightText = normalizeTeamName(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  if (
    leftText.length >= 4 &&
    rightText.length >= 4 &&
    (leftText.includes(rightText) || rightText.includes(leftText))
  ) {
    return 0.8;
  }

  const leftTokens = createTokenSet(left);
  const rightTokens = createTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function normalizeLeagueName(value) {
  return canonicalName(value)
    .replace(/\b(fc|cf|league|division|group|round|regular season)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leagueScore(evento, fixture) {
  const left = normalizeLeagueName(evento?.league?.name || evento?.league?.slug || "");
  const right = normalizeLeagueName(fixture?.league?.name || "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  return overlapScore(left, right);
}

function toTimeValue(dateLike) {
  const value = new Date(dateLike || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function kickoffScore(evento, fixture) {
  const left = toTimeValue(evento?.date);
  const right = toTimeValue(fixture?.fixture?.date);
  if (!left || !right) return 0;
  const diffMinutes = Math.abs(left - right) / 60000;
  if (diffMinutes <= 5) return 1;
  if (diffMinutes <= 30) return 0.9;
  if (diffMinutes <= 90) return 0.7;
  if (diffMinutes <= 180) return 0.4;
  return 0;
}

function fixtureMatchScore(evento, fixture) {
  const exactKey = createOrderedKey(evento?.home, evento?.away);
  const fixtureKey = createOrderedKey(fixture?.teams?.home?.name, fixture?.teams?.away?.name);
  if (exactKey && fixtureKey && exactKey === fixtureKey) return 1;

  const teamsScore =
    (overlapScore(evento?.home, fixture?.teams?.home?.name) + overlapScore(evento?.away, fixture?.teams?.away?.name)) / 2;
  return (teamsScore * 0.76) + (kickoffScore(evento, fixture) * 0.14) + (leagueScore(evento, fixture) * 0.1);
}

function getTimezoneDateString(dateLike, timezone = "Europe/Madrid") {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(dateLike));
  } catch {
    return null;
  }
}

function buildApiSportsUrl(pathname, config, params = {}) {
  const url = new URL(pathname, config.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchApiSports(pathname, config, params = {}, provider = "api-sports-football") {
  return fetchJson(buildApiSportsUrl(pathname, config, params), {
    provider,
    timeoutMs: 15000,
    headers: {
      "x-apisports-key": config.apiKey,
    },
  });
}

async function discoverFixturesForDate(date, config) {
  if (!config?.enabled || !config?.apiKey || !date) return [];
  const cacheKey = `${config.baseUrl}|${config.timezone}|${date}`;
  return loadWithCache(
    DISCOVERY_NAMESPACE,
    cacheKey,
    {
      ttlMs: Math.max(5, Number(config.discoveryMinutes || 360)) * 60 * 1000,
      staleMs: 12 * 60 * 60 * 1000,
    },
    async () => {
      const payload = await fetchApiSports(
        "/fixtures",
        config,
        { date, timezone: config.timezone },
        `api-sports-football:fixtures:${date}`
      );
      const fixtures = Array.isArray(payload?.response) ? payload.response : [];
      console.log(`[api-sports] discovery ${date}: ${fixtures.length} fixtures | errors: ${JSON.stringify(payload?.errors || {})}`);
      fixtures.forEach((f) => console.log(`[api-sports]   ${f?.teams?.home?.name} vs ${f?.teams?.away?.name} (${f?.league?.name})`));
      return fixtures;
    }
  );
}

function pickBestFixture(evento, fixtures) {
  const candidates = (fixtures || [])
    .map((fixture) => ({
      fixture,
      score: fixtureMatchScore(evento, fixture),
    }))
    .filter((item) => item.score >= MATCH_SCORE_MIN)
    .sort((left, right) => right.score - left.score);

  return candidates[0] || null;
}

function isLiveFixture(fixture) {
  const short = String(fixture?.fixture?.status?.short || "").toUpperCase();
  return LIVE_STATUSES.has(short);
}

function minutesUntilKickoff(dateLike) {
  const kickoffAt = toTimeValue(dateLike);
  if (!kickoffAt) return null;
  return Math.round((kickoffAt - Date.now()) / 60000);
}

function hasConfirmedLineup(lineup) {
  const starters = Array.isArray(lineup?.startXI) ? lineup.startXI.length : 0;
  return starters >= 10 || Boolean(lineup?.formation);
}

function findLineupForSide(detail, side) {
  const lineups = Array.isArray(detail?.lineups) ? detail.lineups : [];
  const teamId = String(detail?.teams?.[side]?.id || "");
  const teamName = normalizeTeamName(detail?.teams?.[side]?.name || "");

  return (
    lineups.find((entry) => String(entry?.team?.id || "") === teamId) ||
    lineups.find((entry) => normalizeTeamName(entry?.team?.name || "") === teamName) ||
    null
  );
}

function buildLineupState(detail) {
  const homeLineup = findLineupForSide(detail, "home");
  const awayLineup = findLineupForSide(detail, "away");
  const homeConfirmed = hasConfirmedLineup(homeLineup);
  const awayConfirmed = hasConfirmedLineup(awayLineup);

  return {
    available: Boolean(homeLineup || awayLineup),
    homeConfirmed,
    awayConfirmed,
    anyConfirmed: homeConfirmed || awayConfirmed,
    bothConfirmed: homeConfirmed && awayConfirmed,
    homeFormation: homeLineup?.formation || null,
    awayFormation: awayLineup?.formation || null,
  };
}

function buildFixtureInsight(evento, fixture, detail = null, predictions = null) {
  const snapshot = detail || fixture;
  const lineupState = detail ? buildLineupState(detail) : {
    available: false,
    homeConfirmed: false,
    awayConfirmed: false,
    anyConfirmed: false,
    bothConfirmed: false,
    homeFormation: null,
    awayFormation: null,
  };
  const predictionCtx = extractPredictions(predictions);

  return {
    eventId: String(evento?.id || ""),
    fixtureId: snapshot?.fixture?.id || fixture?.fixture?.id || null,
    leagueId: snapshot?.league?.id || fixture?.league?.id || null,
    stadium: snapshot?.fixture?.venue?.name || fixture?.fixture?.venue?.name || null,
    referee: snapshot?.fixture?.referee || fixture?.fixture?.referee || null,
    status: snapshot?.fixture?.status || fixture?.fixture?.status || null,
    lineups: lineupState,
    predictions: predictionCtx,
    ctx: {
      lesiones: [],
      home_lesiones: [],
      away_lesiones: [],
      lineup_confirmed: lineupState.anyConfirmed,
      home_lineup_confirmed: lineupState.homeConfirmed,
      away_lineup_confirmed: lineupState.awayConfirmed,
      api_sports_fixture_id: snapshot?.fixture?.id || fixture?.fixture?.id || null,
      api_sports_league_id: snapshot?.league?.id || fixture?.league?.id || null,
      fixture_status: snapshot?.fixture?.status?.short || fixture?.fixture?.status?.short || null,
      fixture_status_label: snapshot?.fixture?.status?.long || fixture?.fixture?.status?.long || null,
      ...(predictionCtx || {}),
    },
  };
}

function readDetailCacheSnapshot(fixtureId, config) {
  return peekCacheEntry(DETAIL_NAMESPACE, `${config.baseUrl}|${fixtureId}`);
}

async function loadFixtureDetail(fixtureId, config) {
  if (!fixtureId || !config?.enabled || !config?.apiKey) return null;
  const cacheKey = `${config.baseUrl}|${fixtureId}`;
  return loadWithCache(
    DETAIL_NAMESPACE,
    cacheKey,
    {
      ttlMs: Math.max(5, Number(config.refreshMinutes || 25)) * 60 * 1000,
      staleMs: 6 * 60 * 60 * 1000,
    },
    async () => {
      const payload = await fetchApiSports(
        "/fixtures",
        config,
        { id: fixtureId },
        `api-sports-football:fixture:${fixtureId}`
      );
      return payload?.response?.[0] || null;
    }
  );
}

async function loadFixturePredictions(fixtureId, config) {
  if (!fixtureId || !config?.enabled || !config?.apiKey) return null;
  const cacheKey = `${config.baseUrl}|predictions|${fixtureId}`;
  return loadWithCache(
    PREDICTIONS_NAMESPACE,
    cacheKey,
    { ttlMs: 60 * 60 * 1000, staleMs: 6 * 60 * 60 * 1000 },
    async () => {
      const payload = await fetchApiSports(
        "/predictions",
        config,
        { fixture: fixtureId },
        `api-sports-football:predictions:${fixtureId}`
      );
      return payload?.response?.[0] || null;
    }
  );
}

function parsePredictionPercent(value) {
  const n = Number(String(value || "").replace("%", "").trim());
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}

function extractPredictions(raw) {
  if (!raw) return null;
  const pct = raw?.predictions?.percent;
  const poisson = raw?.comparison?.poisson_distribution;
  const goals = raw?.predictions?.goals;
  const last5Home = raw?.teams?.home?.last_5;
  const last5Away = raw?.teams?.away?.last_5;

  const homeWinProb = parsePredictionPercent(poisson?.home ?? pct?.home);
  const drawProb = parsePredictionPercent(poisson?.draw ?? pct?.draw);
  const awayWinProb = parsePredictionPercent(poisson?.away ?? pct?.away);
  const goalsHome = Number.parseFloat(goals?.home) || null;
  const goalsAway = Number.parseFloat(goals?.away) || null;

  if (!homeWinProb && !awayWinProb) return null;

  return {
    model_home_prob: homeWinProb,
    model_draw_prob: drawProb,
    model_away_prob: awayWinProb,
    model_goals_home: goalsHome,
    model_goals_away: goalsAway,
    model_home_form: last5Home ? (last5Home.wins / Math.max(1, (last5Home.wins + last5Home.draws + last5Home.loses))) : null,
    model_away_form: last5Away ? (last5Away.wins / Math.max(1, (last5Away.wins + last5Away.draws + last5Away.loses))) : null,
    model_home_goals_for: Number.parseFloat(last5Home?.goals?.for?.average) || null,
    model_away_goals_for: Number.parseFloat(last5Away?.goals?.for?.average) || null,
    model_home_goals_against: Number.parseFloat(last5Home?.goals?.against?.average) || null,
    model_away_goals_against: Number.parseFloat(last5Away?.goals?.against?.average) || null,
    model_advice: raw?.predictions?.advice || null,
  };
}

function scoreDetailCandidate(evento, matched, snapshot) {
  const liveBoost = isLiveFixture(matched.fixture) ? 1000 : 0;
  const minutesToKickoff = minutesUntilKickoff(evento?.date);
  const soonBoost =
    minutesToKickoff != null && minutesToKickoff >= -30 && minutesToKickoff <= DETAIL_LOOKAHEAD_MINUTES
      ? 600 - Math.abs(minutesToKickoff)
      : 0;
  const freshnessPenalty = snapshot?.isFresh ? 500 : 0;
  return liveBoost + soonBoost + (matched.score * 100) - freshnessPenalty;
}

export async function loadApiSportsFootballInsights(eventosHoy, date, config) {
  if (!config?.enabled || !config?.apiKey || !Array.isArray(eventosHoy) || !eventosHoy.length) {
    return {};
  }

  const eventIndex = new Map(eventosHoy.map((evento) => [String(evento.id), evento]));
  const eventDates = [...new Set(
    eventosHoy
      .map((evento) => getTimezoneDateString(evento?.date, config.timezone))
      .filter(Boolean)
  )];

  const discoveryDates = (eventDates.length ? eventDates : [date, shiftDateString(date, 1)])
    .filter(Boolean)
    .slice(0, MAX_DISCOVERY_DATES);

  const discoveryLists = await Promise.all(
    discoveryDates.map((entryDate) => discoverFixturesForDate(entryDate, config).catch(() => []))
  );
  const fixtures = discoveryLists.flat();
  const matchedByEventId = new Map();
  const insights = {};

  for (const evento of eventosHoy) {
    const matched = pickBestFixture(evento, fixtures);
    if (!matched?.fixture?.fixture?.id) continue;
    matchedByEventId.set(String(evento.id), matched);
    insights[evento.id] = buildFixtureInsight(evento, matched.fixture);
  }

  const detailBudgetPerWindow = Math.max(0, Number.parseInt(config.detailBudgetPerWindow || 1, 10) || 0);
  if (!detailBudgetPerWindow || !matchedByEventId.size) {
    return insights;
  }

  const detailCandidates = [...matchedByEventId.entries()]
    .map(([eventId, matched]) => {
      const fixtureId = matched?.fixture?.fixture?.id;
      const snapshot = readDetailCacheSnapshot(fixtureId, config);
      return {
        eventId,
        evento: eventIndex.get(eventId),
        matched,
        fixtureId,
        snapshot,
        score: scoreDetailCandidate(eventIndex.get(eventId), matched, snapshot),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  let remainingBudget = detailBudgetPerWindow;
  for (const candidate of detailCandidates) {
    if (candidate.snapshot?.isFresh) {
      const predictions = await loadFixturePredictions(candidate.fixtureId, config).catch(() => null);
      insights[candidate.eventId] = buildFixtureInsight(candidate.evento, candidate.matched.fixture, candidate.snapshot.value, predictions);
      continue;
    }
    if (remainingBudget <= 0) break;

    const [detail, predictions] = await Promise.allSettled([
      loadFixtureDetail(candidate.fixtureId, config),
      loadFixturePredictions(candidate.fixtureId, config),
    ]).then((results) => results.map((r) => (r.status === "fulfilled" ? r.value : null)));

    if (detail) {
      insights[candidate.eventId] = buildFixtureInsight(candidate.evento, candidate.matched.fixture, detail, predictions);
    }
    remainingBudget -= 1;
  }

  return insights;
}
