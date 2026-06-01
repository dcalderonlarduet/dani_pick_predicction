import {
  canonicalName,
  normalizeBookmakersFromOddsApiIo,
} from "./shared/tennis-normalizers.js";
import {
  isMlbInSlateWindow,
  isSlateScheduleWindow,
} from "../utils/bettable-events.js";
import { extractRateLimitFromError } from "../utils/api-rate-limit.js";
import { fetchJson } from "./shared/http.js";
import { loadWithCache, peekCacheEntry } from "./shared/resource-cache.js";
import { normalizeCommenceTime } from "../services/schedule-match.js";
import { normalizeWnbaTeamName } from "../utils/wnba-team-names.js";

const DEFAULT_BASE_URL = "https://api.odds-api.io/v3";
const DEFAULT_BOOKMAKERS = ["Bet365", "Winamax FR"];
const MLB_LEAGUE_SLUG = "usa-mlb";
const NBA_LEAGUE_SLUG = "usa-nba";
const NFL_LEAGUE_SLUG = "usa-nfl";
const MLB_ODDS_MARKETS = "ML,Totals,Runline,Team Total Home,Team Total Away";
const BASKETBALL_ODDS_MARKETS = "ML,Spread,Totals,1st Half Totals,Team Total Home,Team Total Away";
const AMERICAN_FOOTBALL_ODDS_MARKETS = "ML,Spread,Totals,1st Half Totals,Team Total Home,Team Total Away";
const FOOTBALL_ODDS_MARKETS = "ML,Double Chance,Spread,Totals,Team Total Home,Team Total Away,Corners Totals,Corners Spread,Bookings Totals,Bookings Spread";
const DEBUG_ODDS = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG_ODDS || "").trim());
const ODDS_API_CACHE_NAMESPACE = "odds-api-io";
const ALLOW_SINGLE_ODDS_FALLBACK = /^(1|true|yes|on)$/i.test(
  String(process.env.ODDS_API_SINGLE_FALLBACK || "").trim()
);

let oddsApiRateLimitState = null;
let oddsApiNetworkCalls = { total: 0, byPath: {} };

export function resetOddsApiRequestStats() {
  oddsApiNetworkCalls = { total: 0, byPath: {} };
}

export function getOddsApiRequestStats() {
  return {
    total: oddsApiNetworkCalls.total,
    byPath: { ...oddsApiNetworkCalls.byPath },
  };
}

export function oddsApiSkipMarketSignals() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ODDS_API_SKIP_SIGNALS || "").trim());
}

function trackOddsApiNetworkCall(pathname) {
  oddsApiNetworkCalls.total += 1;
  oddsApiNetworkCalls.byPath[pathname] = (oddsApiNetworkCalls.byPath[pathname] || 0) + 1;
}

function getMultiChunkSize() {
  const parsed = Number.parseInt(process.env.ODDS_API_MULTI_CHUNK_SIZE || "10", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 10);
}

export function resetOddsApiRateLimitState() {
  oddsApiRateLimitState = null;
}

export function getOddsApiRateLimitState() {
  if (!oddsApiRateLimitState) return null;
  if (typeof oddsApiRateLimitState.retryAt === "number" && Date.now() >= oddsApiRateLimitState.retryAt) {
    oddsApiRateLimitState = null;
    return null;
  }
  return oddsApiRateLimitState;
}

function registerOddsApiRateLimit(error) {
  const rateLimit = error?.rateLimit || extractRateLimitFromError(error);
  if (!rateLimit) return;
  oddsApiRateLimitState = {
    ...rateLimit,
    detectedAt: Date.now(),
  };
}

function handleOddsApiFailure(error, fallback) {
  registerOddsApiRateLimit(error);
  return fallback;
}

function buildOddsApiRateLimitError(rateLimit) {
  const error = new Error(
    rateLimit?.message || "Odds-API.io limitó las consultas. Se reutiliza caché hasta la siguiente ventana."
  );
  error.name = "OddsApiRateLimitError";
  error.status = Number(rateLimit?.status || 429) || 429;
  error.rateLimit = rateLimit;
  return error;
}

function buildOddsApiIoUrl(baseUrl, pathname, apiKey, params = {}) {
  const url = new URL(`${baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

async function callOddsApiIo(config, pathname, params = {}) {
  const url = buildOddsApiIoUrl(config.oddsApiIo.baseUrl, pathname, config.oddsApiIo.apiKey, params);
  const policy = getOddsApiCachePolicy(pathname, params);
  const activeRateLimit = getOddsApiRateLimitState();
  const cachedSnapshot = peekCacheEntry(ODDS_API_CACHE_NAMESPACE, url);

  if (activeRateLimit && cachedSnapshot?.isStaleUsable) {
    return cachedSnapshot.value;
  }

  if (activeRateLimit) {
    throw buildOddsApiRateLimitError(activeRateLimit);
  }

  try {
    return await loadWithCache(
      ODDS_API_CACHE_NAMESPACE,
      url,
      policy,
      () => {
        trackOddsApiNetworkCall(pathname);
        return fetchJson(url, {
          provider: `odds-api-io:${pathname}`,
          timeoutMs: 20000,
        }).catch((error) => {
          registerOddsApiRateLimit(error);
          throw error;
        });
      }
    );
  } catch (error) {
    registerOddsApiRateLimit(error);
    throw error;
  }
}

function minutes(value) {
  return value * 60 * 1000;
}

function hours(value) {
  return minutes(value * 60);
}

function getOddsApiCachePolicy(pathname, params = {}) {
  switch (pathname) {
    case "/bookmakers/selected":
      return { ttlMs: hours(12), staleMs: hours(24) };
    case "/events":
      return { ttlMs: minutes(15), staleMs: minutes(45) };
    case "/odds":
    case "/odds/multi":
      return { ttlMs: minutes(10), staleMs: minutes(30) };
    case "/odds/movements":
      return { ttlMs: minutes(10), staleMs: minutes(30) };
    case "/value-bets":
      return { ttlMs: minutes(30), staleMs: hours(1) };
    case "/dropping-odds":
      return { ttlMs: minutes(30), staleMs: hours(1) };
    default:
      return {
        ttlMs: params?.includeEventDetails ? minutes(5) : minutes(10),
        staleMs: minutes(20),
      };
  }
}

function debugOddsLog(...args) {
  if (!DEBUG_ODDS) return;
  console.log("[DEBUG_ODDS]", ...args);
}

function getLeagueMeta(event) {
  const rawLeague = event?.league;
  const rawSlug =
    typeof rawLeague === "string"
      ? rawLeague
      : rawLeague?.slug || rawLeague?.id || rawLeague?.name || "";
  const rawName =
    typeof rawLeague === "string" ? rawLeague : rawLeague?.name || rawLeague?.slug || rawLeague?.id || "";

  const slug = String(rawSlug)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = String(rawName)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  return { slug, name };
}

function isMlbEvent(event) {
  const { slug, name } = getLeagueMeta(event);
  return slug === MLB_LEAGUE_SLUG || name.includes("mlb");
}

function isNbaEvent(event) {
  const { slug, name } = getLeagueMeta(event);
  if (slug.includes("wnba") || name.includes("wnba")) return false;
  return slug === NBA_LEAGUE_SLUG || (name.includes("nba") && !name.includes("wnba"));
}

function isWnbaEvent(event) {
  const { slug, name } = getLeagueMeta(event);
  return slug.includes("wnba") || name.includes("wnba");
}

function isNflEvent(event) {
  const { slug, name } = getLeagueMeta(event);
  return slug === NFL_LEAGUE_SLUG || name.includes("nfl");
}

function filterOddsApiRowsByLeague(payload, leagueFilter) {
  return Array.isArray(payload) ? payload.filter((row) => leagueFilter(row?.event || row)) : [];
}

function isProSportInSlateWindow(event, date) {
  return isSlateScheduleWindow(event?.date || event?.startTime, date, {
    isLive: /live|in progress|halftime|q[1-4]/i.test(String(event?.status || "")),
    isActive: !/final|completed|postpon|cancel/i.test(String(event?.status || "")),
  });
}

async function fetchEventsBySport(config, sportSlug) {
  try {
    const payload = await callOddsApiIo(config, "/events", { sport: sportSlug });
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    return handleOddsApiFailure(error, []);
  }
}

async function resolveBookmakers(config) {
  if (config.oddsApiIo.bookmakers?.length) {
    return config.oddsApiIo.bookmakers;
  }

  try {
    const selected = await callOddsApiIo(config, "/bookmakers/selected", {});
    if (Array.isArray(selected) && selected.length) {
      return selected;
    }
  } catch (error) {
    handleOddsApiFailure(error, null);
  }

  return DEFAULT_BOOKMAKERS;
}

function extractReturnedMarketNames(entry) {
  const names = new Set();

  if (Array.isArray(entry?.bookmakers)) {
    entry.bookmakers.forEach((bookmaker) => {
      (bookmaker?.markets || []).forEach((market) => {
        if (market?.name) names.add(String(market.name));
      });
    });
  } else if (entry?.bookmakers && typeof entry.bookmakers === "object") {
    Object.values(entry.bookmakers).forEach((markets) => {
      (Array.isArray(markets) ? markets : []).forEach((market) => {
        const marketName = market?.name || market?.market;
        if (marketName) names.add(String(marketName));
      });
    });
  }

  return [...names].sort();
}

async function fetchOddsForEvents(config, eventIds, bookmakers, options = {}) {
  if (!eventIds.length) return [];
  const markets = options.markets ? String(options.markets) : undefined;

  try {
    const payload = await callOddsApiIo(config, "/odds/multi", {
      eventIds: eventIds.join(","),
      bookmakers: bookmakers.join(","),
      markets,
    });

    if (Array.isArray(payload) && payload.length) {
      if (options.debugLabel) {
        const names = [...new Set(payload.flatMap((entry) => extractReturnedMarketNames(entry)))];
        debugOddsLog(`${options.debugLabel} multi markets -> ${names.join(", ") || "none"}`);
      }
      return payload;
    }
  } catch (error) {
    handleOddsApiFailure(error, null);
  }

  if (!ALLOW_SINGLE_ODDS_FALLBACK) {
    return [];
  }

  const rows = [];
  for (const eventId of eventIds) {
    try {
      const single = await callOddsApiIo(config, "/odds", {
        eventId,
        bookmakers: bookmakers.join(","),
        markets,
      });
      if (single?.id || single?.home) {
        if (options.debugLabel) {
          const names = extractReturnedMarketNames(single);
          debugOddsLog(`${options.debugLabel} single ${eventId} -> ${names.join(", ") || "none"}`);
        }
        rows.push(single);
      }
    } catch (error) {
      handleOddsApiFailure(error, null);
    }
  }
  return rows;
}

function ingestProOddsRow(map, odds, fallbackLine, options = {}) {
  const normalized = normalizeBookmakersFromOddsApiIo(odds, fallbackLine);
  if (!Object.keys(normalized.bookmakers).length) return;

  const home = odds?.home || "";
  const away = odds?.away || "";
  const commenceTime = odds?.date || odds?.startTime || null;
  const entry = {
    home_team: home,
    away_team: away,
    bookmakers: normalized.bookmakers,
    totalsLine: normalized.totalsLine,
    firstHalfLine: normalized.firstHalfLine,
    scores: odds?.scores || null,
    status: odds?.status || null,
    eventId: odds?.id || null,
    commenceTime,
    source: "odds-api-io",
  };

  const eventId = odds?.id != null ? String(odds.id) : null;
  if (eventId) map.set(`event:${eventId}`, entry);

  const normalizeTeam = options.normalizeTeamName || canonicalName;
  const teamKeys = new Set([
    [canonicalName(home), canonicalName(away)].join("::"),
    [normalizeTeam(home), normalizeTeam(away)].join("::"),
  ]);
  const normalizedTime = normalizeCommenceTime(commenceTime);
  const dateKey = normalizedTime.slice(0, 10);
  for (const teamKey of teamKeys) {
    if (dateKey && normalizedTime) {
      map.set(`${teamKey}::${dateKey}::${normalizedTime}`, entry);
    }
    if (dateKey && !map.has(`${teamKey}::${dateKey}`)) {
      map.set(`${teamKey}::${dateKey}`, entry);
    }
  }
}

async function loadProOddsMapForDates(dates, config, options) {
  if (!config?.oddsApiIo?.apiKey) return new Map();
  if (!Array.isArray(dates) || !dates.length) return new Map();

  const { sportSlug, leagueFilter, windowFilter, markets, fallbackLine, debugLabel } = options;
  const bookmakers = await resolveBookmakers(config);
  const allEvents = await fetchEventsBySport(config, sportSlug);
  const uniqueEventsById = new Map();

  for (const date of dates) {
    const dayEvents = allEvents.filter(
      (event) =>
        leagueFilter(event) &&
        (windowFilter
          ? windowFilter(event, date)
          : isProSportInSlateWindow(event, date))
    );
    for (const event of dayEvents) {
      if (event?.id) uniqueEventsById.set(event.id, event);
    }
  }

  const uniqueEvents = [...uniqueEventsById.values()];
  const chunkSize = getMultiChunkSize();
  const map = new Map();

  for (let index = 0; index < uniqueEvents.length; index += chunkSize) {
    const chunk = uniqueEvents.slice(index, index + chunkSize);
    const oddsRows = await fetchOddsForEvents(
      config,
      chunk.map((event) => event.id),
      bookmakers,
      {
        markets,
        debugLabel: `${debugLabel || sportSlug}:${Math.floor(index / chunkSize) + 1}`,
      }
    );

    for (const odds of oddsRows) {
      ingestProOddsRow(map, odds, fallbackLine, {
        normalizeTeamName: options.normalizeTeamName,
      });
    }
  }

  return map;
}

export async function loadMlbOddsMapForDates(dates, config) {
  return loadProOddsMapForDates(dates, config, {
    sportSlug: "baseball",
    leagueFilter: isMlbEvent,
    windowFilter: (event, date) =>
      isMlbInSlateWindow({ startTime: event.date, status: event.status }, date),
    markets: MLB_ODDS_MARKETS,
    fallbackLine: 8.5,
    debugLabel: "mlb",
  });
}

export async function loadMlbOddsMap(date, config) {
  return loadMlbOddsMapForDates([date], config);
}

export function getOddsApiMultiChunkSize() {
  return getMultiChunkSize();
}

export function getOddsApiIoProviderEntry(apiKey) {
  return {
    id: "odds",
    name: "Odds-API.io",
    status: apiKey ? "configured" : "missing-credentials",
    purpose: "Cuotas y marcadores en vivo desde mas de 250 casas (MLB, futbol y otros deportes).",
    docs: "https://docs.odds-api.io/",
    productionCandidates: ["Odds-API.io"],
  };
}

function envOddsApiConfig() {
  return {
    oddsApiIo: {
      apiKey: process.env.ODDS_API_IO_KEY || "",
      baseUrl: process.env.ODDS_API_IO_BASE_URL || DEFAULT_BASE_URL,
      bookmakers: parseList(process.env.ODDS_API_IO_BOOKMAKERS, DEFAULT_BOOKMAKERS),
    },
  };
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function safeOddsApiCall(pathname, params = {}) {
  const config = envOddsApiConfig();
  if (!config.oddsApiIo.apiKey) return null;
  try {
    return await callOddsApiIo(config, pathname, params);
  } catch (error) {
    return handleOddsApiFailure(error, null);
  }
}

// ─── FOOTBALL: VALUE BETS ─────────────────────────────────────────────────────
export async function loadFootballValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "football",
    includeEventDetails: true,
    markets: FOOTBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

// ─── FOOTBALL: DROPPING ODDS ──────────────────────────────────────────────────
export async function loadFootballDroppingOdds(minDrop = 8, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "football",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: FOOTBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

// ─── FOOTBALL: ODDS MULTI ─────────────────────────────────────────────────────
export async function loadFootballOddsMulti(eventIds = [], bookmakers = "Bet365,Winamax FR") {
  if (!eventIds.length) return [];
  const chunkSize = getMultiChunkSize();
  const ids = eventIds.slice(0, chunkSize).join(",");
  const payload = await safeOddsApiCall("/odds/multi", {
    eventIds: ids,
    bookmakers,
    markets: FOOTBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

// ─── FOOTBALL: EVENTOS DEL DÍA ────────────────────────────────────────────────
export async function loadFootballEvents() {
  const payload = await safeOddsApiCall("/events", { sport: "football" });
  return Array.isArray(payload) ? payload : [];
}

// ─── BASEBALL: EVENTOS DEL DÍA (pre-warm) ────────────────────────────────────
export async function loadBaseballEvents() {
  const payload = await safeOddsApiCall("/events", { sport: "baseball" });
  return Array.isArray(payload) ? payload : [];
}

// ─── BASEBALL: VALUE BETS ─────────────────────────────────────────────────────
export async function loadBaseballValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "baseball",
    includeEventDetails: true,
    markets: MLB_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

// ─── BASEBALL: DROPPING ODDS (movimiento de línea sharps) ────────────────────
export async function loadBaseballDroppingOdds(minDrop = 5, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "baseball",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: MLB_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

export async function loadBasketballOddsMapForDates(dates, config) {
  return loadProOddsMapForDates(dates, config, {
    sportSlug: "basketball",
    leagueFilter: isNbaEvent,
    markets: BASKETBALL_ODDS_MARKETS,
    fallbackLine: 220.5,
    debugLabel: "nba",
  });
}

export async function loadNbaOddsMapForDates(dates, config) {
  return loadBasketballOddsMapForDates(dates, config);
}

export async function loadWnbaOddsMapForDates(dates, config) {
  return loadProOddsMapForDates(dates, config, {
    sportSlug: "basketball",
    leagueFilter: isWnbaEvent,
    markets: BASKETBALL_ODDS_MARKETS,
    fallbackLine: 165.5,
    debugLabel: "wnba",
    normalizeTeamName: normalizeWnbaTeamName,
  });
}

export async function loadAmericanFootballOddsMapForDates(dates, config) {
  return loadProOddsMapForDates(dates, config, {
    sportSlug: "american-football",
    leagueFilter: isNflEvent,
    markets: AMERICAN_FOOTBALL_ODDS_MARKETS,
    fallbackLine: 44.5,
    debugLabel: "nfl",
  });
}

export async function loadBasketballOddsMap(date, config) {
  return loadBasketballOddsMapForDates([date], config);
}

export async function loadNbaOddsMap(date, config) {
  return loadNbaOddsMapForDates([date], config);
}

export async function loadWnbaOddsMap(date, config) {
  return loadWnbaOddsMapForDates([date], config);
}

export async function loadAmericanFootballOddsMap(date, config) {
  return loadAmericanFootballOddsMapForDates([date], config);
}

export async function loadBasketballValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "basketball",
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

export async function loadNbaValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "basketball",
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return filterOddsApiRowsByLeague(payload, isNbaEvent);
}

export async function loadWnbaValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "basketball",
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return filterOddsApiRowsByLeague(payload, isWnbaEvent);
}

export async function loadNbaDroppingOdds(minDrop = 5, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "basketball",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return filterOddsApiRowsByLeague(payload, isNbaEvent);
}

export async function loadWnbaDroppingOdds(minDrop = 5, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "basketball",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return filterOddsApiRowsByLeague(payload, isWnbaEvent);
}

export async function loadAmericanFootballValueBets(bookmaker = "Bet365") {
  const payload = await safeOddsApiCall("/value-bets", {
    bookmaker,
    sport: "american-football",
    includeEventDetails: true,
    markets: AMERICAN_FOOTBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

export async function loadBasketballDroppingOdds(minDrop = 5, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "basketball",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: BASKETBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}

export async function loadAmericanFootballDroppingOdds(minDrop = 5, timeWindow = "12h") {
  const payload = await safeOddsApiCall("/dropping-odds", {
    sport: "american-football",
    minDrop,
    timeWindow,
    includeEventDetails: true,
    markets: AMERICAN_FOOTBALL_ODDS_MARKETS,
  });
  return Array.isArray(payload) ? payload : [];
}
