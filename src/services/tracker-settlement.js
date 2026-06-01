import { round } from "../utils/math.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { fetchJson } from "../providers/shared/http.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import { getDateStringInTimezone, shiftDateString } from "../utils/madrid-date.js";
import {
  getPendingPickTimingMetaLive,
  getPicks,
  updatePickResult,
} from "./picks-db.js";
import { parseMlbMoneylineTeamName } from "./mlb-copy.js";
import { notifyDailyBalanceTelegram, notifyResolvedPickTelegram } from "./telegram-notifier.js";

const RUNTIME_CONFIG = getRuntimeConfig();

const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=";
const ESPN_SOCCER_BASE_URL =
  process.env.ESPN_SOCCER_BASE_URL || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_WNBA_SCOREBOARD_URL =
  process.env.ESPN_WNBA_SCOREBOARD_URL ||
  "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=";
const TRACKER_SYNC_TTL_MS = 60 * 1000;
const TRACKER_PROVIDER_CACHE_TTL_MS =
  Math.max(30, Number.parseInt(process.env.TRACKER_PROVIDER_CACHE_SECONDS || "75", 10) || 75) * 1000;

const MLB_FINAL_STATES = new Set(["final", "completed early", "game over"]);
const MLB_VOID_STATES = new Set(["postponed", "cancelled", "canceled"]);
const SOCCER_FINAL_STATES = new Set(["post", "final", "full time", "after extra time", "after penalties"]);
const SOCCER_VOID_STATES = new Set(["postponed", "cancelled", "canceled", "abandoned", "suspended"]);
const WNBA_FINAL_STATES = new Set(["post", "final", "full time"]);
const WNBA_VOID_STATES = new Set(["postponed", "cancelled", "canceled", "suspended"]);
const TENNIS_FINAL_STATES = new Set(["settled", "post", "finished", "final"]);
const TENNIS_VOID_STATES = new Set(["cancelled", "canceled", "postponed"]);

const FOOTBALL_LEAGUE_MAPPINGS = [
  { test: /(england-premier-league|premier league|eng\.1)/i, slug: "eng.1" },
  { test: /(spain-laliga|laliga|la liga|esp\.1)/i, slug: "esp.1" },
  { test: /(germany-bundesliga|bundesliga|ger\.1)/i, slug: "ger.1" },
  { test: /(italy-serie-a|serie a|ita\.1)/i, slug: "ita.1" },
  { test: /(france-ligue-1|ligue 1|fra\.1)/i, slug: "fra.1" },
  { test: /(uefa-champions-league|champions league|uefa champions|uefa\.champions)/i, slug: "uefa.champions" },
  { test: /(uefa-europa-league|europa league|uefa europa|uefa\.europa)/i, slug: "uefa.europa" },
  { test: /(uefa-conference-league|conference league|uefa conference)/i, slug: "uefa.europa.conf" },
  { test: /(concacaf champions|concacaf champions cup|concacaf\.champions|concacaf)/i, slug: "concacaf.champions" },
  { test: /(fa cup|eng\.fa)/i, slug: "eng.fa" },
  { test: /(copa del rey)/i, slug: "esp.copa_del_rey" },
  { test: /(coppa italia)/i, slug: "ita.coppa_italia" },
  { test: /(dfb pokal)/i, slug: "ger.dfb_pokal" },
  { test: /(coupe de france)/i, slug: "fra.coupe_de_france" },
];

let syncPromise = null;
let lastSyncAt = 0;

const soccerScoreboardCache = new Map();
const soccerSummaryCache = new Map();
const wnbaScoreboardCache = new Map();
const tennisEventsCache = new Map();

function getCachedProviderPromise(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt > Date.now()) return entry.promise;
  cache.delete(key);
  return null;
}

function setCachedProviderPromise(cache, key, promise, ttlMs = TRACKER_PROVIDER_CACHE_TTL_MS) {
  cache.set(key, {
    promise,
    expiresAt: Date.now() + ttlMs,
  });
  promise.catch(() => cache.delete(key));
  return promise;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePickDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return getDateStringInTimezone(value);
  }
  const text = String(value || "");
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function asNumber(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function parseOverUnderPick(label) {
  const text = normalizeText(label);
  const wantsOver =
    text.includes("(+)") ||
    text.includes("mas de") ||
    text.includes("over");
  const wantsUnder =
    text.includes("(-)") ||
    text.includes("menos de") ||
    text.includes("under");
  const lineMatch = String(label || "").match(/(\d+(?:[.,]\d+)?)/);
  const line = lineMatch ? Number.parseFloat(lineMatch[1].replace(",", ".")) : null;
  if (!Number.isFinite(line)) return null;
  return { line, wantsOver, wantsUnder };
}

function parseSignedLine(label) {
  const match = String(label || "").match(/([+-]\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidHourLabel(value) {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value.trim());
}

function madridDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function madridTimeLabel(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function minutesSinceScheduledStart(pick, now = new Date()) {
  const pickDate = normalizePickDateKey(pick?.pick_date);
  const hora = String(pick?.hora_partido || "").trim();
  const today = madridDateKey(now);
  if (!pickDate) return null;
  if (pickDate < today) return 24 * 60;
  if (pickDate > today || !isValidHourLabel(hora)) return null;

  const [currentHours, currentMinutes] = madridTimeLabel(now).split(":").map((value) => Number.parseInt(value, 10));
  const [pickHours, pickMinutes] = hora.split(":").map((value) => Number.parseInt(value, 10));
  const currentTotal = currentHours * 60 + currentMinutes;
  const pickTotal = pickHours * 60 + pickMinutes;
  return currentTotal - pickTotal;
}

function hasLeagueCoverage(events, leagueLabel) {
  const target = normalizeText(leagueLabel);
  if (!target) return Array.isArray(events) && events.length > 0;
  return events.some((event) => {
    const eventLeague = normalizeText(event?.league?.name || event?.league || "");
    return eventLeague && (eventLeague.includes(target) || target.includes(eventLeague));
  });
}

function shouldAutoVoidUnmatchedPick(pick, events, cutoffMinutes, now = new Date()) {
  if (!Array.isArray(events) || !events.length) return false;
  if (!hasLeagueCoverage(events, pick?.liga || "")) return false;

  const pickDate = normalizePickDateKey(pick?.pick_date);
  const today = madridDateKey(now);
  if (pickDate && pickDate < today) return true;

  const deltaMinutes = minutesSinceScheduledStart(pick, now);
  return Number.isFinite(deltaMinutes) && deltaMinutes >= cutoffMinutes;
}

function parseMatchLabel(label) {
  const text = String(label || "").trim();
  if (text.includes("@")) {
    const [away, home] = text.split("@").map((part) => part.trim()).filter(Boolean);
    return { away, home };
  }
  if (/ vs /i.test(text)) {
    const [left, right] = text.split(/ vs /i).map((part) => part.trim()).filter(Boolean);
    return { away: left, home: right };
  }
  return { away: "", home: "" };
}

function matchKey(left, right) {
  return [canonicalName(left), canonicalName(right)].sort().join("::");
}

function overlapScore(left, right) {
  const leftTokens = canonicalName(left).split(" ").filter(Boolean);
  const rightTokens = canonicalName(right).split(" ").filter(Boolean);
  if (!leftTokens.length || !rightTokens.length) return 0;

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.includes(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.length, rightTokens.length);
}

function pickTeamSideByLabel(label, homeName, awayName) {
  const normalized = normalizeText(label);
  const homeKey = normalizeText(homeName);
  const awayKey = normalizeText(awayName);
  if (homeKey && normalized.includes(homeKey)) return "home";
  if (awayKey && normalized.includes(awayKey)) return "away";
  return null;
}

function scoreboardState(status = {}) {
  return normalizeText(status?.state || status?.description || status?.detail || status?.shortDetail || "");
}

function toOddsApiDateRange(date) {
  return {
    from: `${date}T00:00:00Z`,
    to: `${date}T23:59:59Z`,
  };
}

function buildOddsApiUrl(pathname, params = {}) {
  const url = new URL(`${RUNTIME_CONFIG.oddsApiIo.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  url.searchParams.set("apiKey", RUNTIME_CONFIG.oddsApiIo.apiKey);
  return url.toString();
}

async function callOddsApi(pathname, params = {}) {
  if (!RUNTIME_CONFIG.oddsApiIo.apiKey) {
    throw new Error("ODDS_API_IO_KEY no configurada para settlement de tennis.");
  }
  return fetchJson(buildOddsApiUrl(pathname, params), {
    provider: `odds-api-io:${pathname}`,
    timeoutMs: 20000,
  });
}

async function loadMlbSchedule(date) {
  const payload = await fetchJson(`${MLB_SCHEDULE_URL}${date}`, {
    provider: "mlb-schedule",
    timeoutMs: 20000,
  }).catch(() => null);
  return payload?.dates?.[0]?.games || [];
}

function scoreMlbGameCandidate(game, pickDate) {
  const state = normalizeText(game?.status?.detailedState || game?.status?.abstractGameState);
  const officialDate = normalizePickDateKey(game?.officialDate);
  const previousDate = pickDate ? shiftDateString(pickDate, -1) : "";
  let score = 0;

  if (MLB_FINAL_STATES.has(state)) score += 30;
  else if (MLB_VOID_STATES.has(state)) score += 20;
  else if (state.includes("live") || state.includes("progress")) score += 10;

  if (officialDate === pickDate) score += 4;
  if (officialDate === previousDate) score += 3;

  return score;
}

function findMlbGameForPick(pick, games) {
  const { away, home } = parseMatchLabel(pick.partido);
  const awayKey = normalizeText(away);
  const homeKey = normalizeText(home);
  if (!awayKey || !homeKey) return null;

  const candidates = games.filter((game) => {
    const gameAway = normalizeText(game?.teams?.away?.team?.name);
    const gameHome = normalizeText(game?.teams?.home?.team?.name);
    return gameAway === awayKey && gameHome === homeKey;
  });
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const pickDate = normalizePickDateKey(pick.pick_date);
  return candidates
    .slice()
    .sort((left, right) => scoreMlbGameCandidate(right, pickDate) - scoreMlbGameCandidate(left, pickDate))[0];
}

function settleMlbMoneyline(pick, game) {
  const selectedTeam = normalizeText(parseMlbMoneylineTeamName(pick.pick_label));
  const awayTeam = normalizeText(game?.teams?.away?.team?.name);
  const homeTeam = normalizeText(game?.teams?.home?.team?.name);
  const awayScore = Number(game?.teams?.away?.score ?? NaN);
  const homeScore = Number(game?.teams?.home?.score ?? NaN);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;

  const winner = awayScore > homeScore ? awayTeam : homeScore > awayScore ? homeTeam : null;
  if (!winner) return "void";
  return selectedTeam === winner ? "ganado" : "perdido";
}

function settleMlbTotals(pick, game) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  const awayScore = Number(game?.teams?.away?.score ?? NaN);
  const homeScore = Number(game?.teams?.home?.score ?? NaN);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;

  const totalRuns = awayScore + homeScore;
  if (totalRuns === parsed.line) return "void";
  if (parsed.wantsOver) return totalRuns > parsed.line ? "ganado" : "perdido";
  if (parsed.wantsUnder) return totalRuns < parsed.line ? "ganado" : "perdido";
  return null;
}

function settleMlbTeamTotal(pick, game) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  const pickLabel = normalizeText(pick.pick_label);
  const awayTeam = normalizeText(game?.teams?.away?.team?.name);
  const homeTeam = normalizeText(game?.teams?.home?.team?.name);
  const awayScore = Number(game?.teams?.away?.score ?? NaN);
  const homeScore = Number(game?.teams?.home?.score ?? NaN);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;

  const teamRuns = pickLabel.includes(awayTeam) ? awayScore : pickLabel.includes(homeTeam) ? homeScore : null;
  if (!Number.isFinite(teamRuns)) return null;
  if (teamRuns === parsed.line) return "void";
  if (parsed.wantsOver) return teamRuns > parsed.line ? "ganado" : "perdido";
  if (parsed.wantsUnder) return teamRuns < parsed.line ? "ganado" : "perdido";
  return null;
}

function settleMlbRunline(pick, game) {
  const line = parseSignedLine(pick.pick_label);
  const awayTeam = normalizeText(game?.teams?.away?.team?.name);
  const homeTeam = normalizeText(game?.teams?.home?.team?.name);
  const pickLabel = normalizeText(pick.pick_label);
  const awayScore = Number(game?.teams?.away?.score ?? NaN);
  const homeScore = Number(game?.teams?.home?.score ?? NaN);
  if (line == null || !Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;

  const side = pickLabel.includes(awayTeam) ? "away" : pickLabel.includes(homeTeam) ? "home" : null;
  if (!side) return null;

  const selected = side === "away" ? awayScore : homeScore;
  const opponent = side === "away" ? homeScore : awayScore;
  const adjusted = round(selected + line - opponent, 2);
  if (adjusted === 0) return "void";
  return adjusted > 0 ? "ganado" : "perdido";
}

function getMlbSettlementOutcome(pick, game) {
  const state = normalizeText(game?.status?.detailedState || game?.status?.abstractGameState);
  if (MLB_VOID_STATES.has(state)) return "void";
  if (!MLB_FINAL_STATES.has(state)) return null;

  const market = normalizeText(pick.mercado);
  if (market.includes("ganador")) return settleMlbMoneyline(pick, game);
  if (market.includes("total de carreras local") || market.includes("total de carreras visitante")) {
    return settleMlbTeamTotal(pick, game);
  }
  if (market.includes("total de carreras del juego")) return settleMlbTotals(pick, game);
  if (market.includes("run line") || market.includes("handicap") || market.includes("hándicap")) {
    return settleMlbRunline(pick, game);
  }
  return null;
}

async function reconcilePendingMlbPicks(picks) {
  const byDate = new Map();
  picks.forEach((pick) => {
    const dateKey = normalizePickDateKey(pick.pick_date);
    if (!dateKey) return;
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(pick);
  });

  const summary = { checked: 0, resolved: 0, unresolved: 0, resolvedPicks: [] };
  const scheduleCache = new Map();

  for (const [date, datePicks] of byDate.entries()) {
    const candidateDates = Array.from(new Set([shiftDateString(date, -1), date]));
    const gamesByDate = await Promise.all(candidateDates.map(async (candidateDate) => {
      if (!scheduleCache.has(candidateDate)) {
        scheduleCache.set(candidateDate, await loadMlbSchedule(candidateDate));
      }
      return scheduleCache.get(candidateDate) || [];
    }));
    const games = gamesByDate.flat();

    for (const pick of datePicks) {
      summary.checked += 1;
      const game = findMlbGameForPick(pick, games);
      if (!game) {
        summary.unresolved += 1;
        continue;
      }

      const outcome = getMlbSettlementOutcome(pick, game);
      if (!outcome) {
        summary.unresolved += 1;
        continue;
      }

      const resolvedPick = await updatePickResult(Number(pick.id), outcome);
      summary.resolvedPicks.push(resolvedPick);
      summary.resolved += 1;
    }
  }

  return summary;
}

function resolveFootballLeagueSlug(...values) {
  const haystack = values.filter(Boolean).join(" ");
  for (const entry of FOOTBALL_LEAGUE_MAPPINGS) {
    if (entry.test.test(haystack)) return entry.slug;
  }
  return null;
}

function extractSoccerCompetitors(event) {
  if (Array.isArray(event?.competitions?.[0]?.competitors)) {
    return event.competitions[0].competitors;
  }
  return [];
}

function extractSoccerEventMeta(event) {
  const competitors = extractSoccerCompetitors(event);
  if (competitors.length < 2) return null;
  const home = competitors.find((item) => item?.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item?.homeAway === "away") || competitors[1];

  const homeScore = firstFinite(home?.score?.value, home?.score);
  const awayScore = firstFinite(away?.score?.value, away?.score);

  return {
    eventId: String(event?.id || ""),
    homeName: home?.team?.displayName || home?.displayName || null,
    awayName: away?.team?.displayName || away?.displayName || null,
    homeId: home?.team?.id || home?.id || null,
    awayId: away?.team?.id || away?.id || null,
    homeScore,
    awayScore,
    statusState: scoreboardState(event?.status?.type || event?.competitions?.[0]?.status?.type || {}),
  };
}

function scoreSoccerEventMatch(event, pick) {
  const parsed = extractSoccerEventMeta(event);
  if (!parsed?.homeName || !parsed?.awayName) return 0;
  const { away, home } = parseMatchLabel(pick.partido);
  const exact = `${normalizeText(home)}::${normalizeText(away)}`;
  const candidate = `${normalizeText(parsed.homeName)}::${normalizeText(parsed.awayName)}`;
  if (exact && exact === candidate) return 1;
  const directScore = (
    overlapScore(home, parsed.homeName) +
    overlapScore(away, parsed.awayName)
  ) / 2;
  if (!/ vs /i.test(String(pick.partido || ""))) return directScore;

  const reversedScore = (
    overlapScore(away, parsed.homeName) +
    overlapScore(home, parsed.awayName)
  ) / 2;
  return Math.max(directScore, reversedScore);
}

async function fetchSoccerScoreboard(leagueSlug, date) {
  const cacheKey = `${leagueSlug}|${date}`;
  const cached = getCachedProviderPromise(soccerScoreboardCache, cacheKey);
  if (cached) return cached;
  const promise = fetchJson(
    `${ESPN_SOCCER_BASE_URL}/${leagueSlug}/scoreboard?dates=${String(date).replaceAll("-", "")}`,
    {
      provider: `espn-soccer:${leagueSlug}:scoreboard`,
      timeoutMs: 15000,
    }
  ).catch(() => null);
  return setCachedProviderPromise(soccerScoreboardCache, cacheKey, promise);
}

async function fetchSoccerSummary(leagueSlug, eventId) {
  const cacheKey = `${leagueSlug}|${eventId}`;
  if (soccerSummaryCache.has(cacheKey)) return soccerSummaryCache.get(cacheKey);
  const promise = fetchJson(
    `${ESPN_SOCCER_BASE_URL}/${leagueSlug}/summary?event=${eventId}`,
    {
      provider: `espn-soccer:${leagueSlug}:summary`,
      timeoutMs: 15000,
    }
  ).catch(() => null);
  soccerSummaryCache.set(cacheKey, promise);
  return promise;
}

function extractSoccerTeamStats(summary, teamId) {
  const teams = Array.isArray(summary?.boxscore?.teams) ? summary.boxscore.teams : [];
  return teams.find((entry) => String(entry?.team?.id || "") === String(teamId || "")) || null;
}

function extractSoccerStat(summary, teamId, statName) {
  const team = extractSoccerTeamStats(summary, teamId);
  const stats = Array.isArray(team?.statistics) ? team.statistics : [];
  const row = stats.find((entry) => entry?.name === statName);
  return firstFinite(row?.displayValue, row?.value);
}

function totalSoccerCards(summary, homeId, awayId) {
  const yellowHome = extractSoccerStat(summary, homeId, "yellowCards") || 0;
  const yellowAway = extractSoccerStat(summary, awayId, "yellowCards") || 0;
  const redHome = extractSoccerStat(summary, homeId, "redCards") || 0;
  const redAway = extractSoccerStat(summary, awayId, "redCards") || 0;
  return yellowHome + yellowAway + redHome + redAway;
}

function totalSoccerCorners(summary, homeId, awayId) {
  const homeCorners = extractSoccerStat(summary, homeId, "wonCorners") || 0;
  const awayCorners = extractSoccerStat(summary, awayId, "wonCorners") || 0;
  return homeCorners + awayCorners;
}

function settleOverUnderValue(parsed, actualValue) {
  if (!parsed || !Number.isFinite(actualValue)) return null;
  if (actualValue === parsed.line) return "void";
  if (parsed.wantsOver) return actualValue > parsed.line ? "ganado" : "perdido";
  if (parsed.wantsUnder) return actualValue < parsed.line ? "ganado" : "perdido";
  return null;
}

function settleSoccerMoneyline(pick, eventMeta) {
  const homeScore = eventMeta.homeScore;
  const awayScore = eventMeta.awayScore;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const label = normalizeText(pick.pick_label);

  if (label.includes("empate")) {
    return homeScore === awayScore ? "ganado" : "perdido";
  }

  const side = pickTeamSideByLabel(pick.pick_label, eventMeta.homeName, eventMeta.awayName);
  if (side === "home") return homeScore > awayScore ? "ganado" : "perdido";
  if (side === "away") return awayScore > homeScore ? "ganado" : "perdido";
  return null;
}

function settleSoccerDoubleChance(pick, eventMeta) {
  const homeScore = eventMeta.homeScore;
  const awayScore = eventMeta.awayScore;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const label = normalizeText(pick.pick_label);
  if (label.includes("no hay empate")) return homeScore !== awayScore ? "ganado" : "perdido";
  if (label.includes("gana o empata")) {
    const side = pickTeamSideByLabel(pick.pick_label, eventMeta.homeName, eventMeta.awayName);
    if (side === "home") return homeScore >= awayScore ? "ganado" : "perdido";
    if (side === "away") return awayScore >= homeScore ? "ganado" : "perdido";
  }
  return null;
}

function settleSoccerTeamTotal(pick, eventMeta) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  const side = pickTeamSideByLabel(pick.pick_label, eventMeta.homeName, eventMeta.awayName);
  const teamGoals = side === "home" ? eventMeta.homeScore : side === "away" ? eventMeta.awayScore : null;
  return settleOverUnderValue(parsed, teamGoals);
}

function settleSoccerSpread(pick, eventMeta, summary) {
  const line = parseSignedLine(pick.pick_label);
  if (line == null) return null;
  const side = pickTeamSideByLabel(pick.pick_label, eventMeta.homeName, eventMeta.awayName);
  if (!side) return null;

  let selected = null;
  let opponent = null;
  const market = normalizeText(pick.mercado);

  if (market.includes("corner")) {
    const homeCorners = extractSoccerStat(summary, eventMeta.homeId, "wonCorners");
    const awayCorners = extractSoccerStat(summary, eventMeta.awayId, "wonCorners");
    selected = side === "home" ? homeCorners : awayCorners;
    opponent = side === "home" ? awayCorners : homeCorners;
  } else if (market.includes("tarjeta") || market.includes("booking")) {
    const homeCards =
      (extractSoccerStat(summary, eventMeta.homeId, "yellowCards") || 0) +
      (extractSoccerStat(summary, eventMeta.homeId, "redCards") || 0);
    const awayCards =
      (extractSoccerStat(summary, eventMeta.awayId, "yellowCards") || 0) +
      (extractSoccerStat(summary, eventMeta.awayId, "redCards") || 0);
    selected = side === "home" ? homeCards : awayCards;
    opponent = side === "home" ? awayCards : homeCards;
  } else {
    selected = side === "home" ? eventMeta.homeScore : eventMeta.awayScore;
    opponent = side === "home" ? eventMeta.awayScore : eventMeta.homeScore;
  }

  if (!Number.isFinite(selected) || !Number.isFinite(opponent)) return null;
  const adjusted = round(selected + line - opponent, 2);
  if (adjusted === 0) return "void";
  return adjusted > 0 ? "ganado" : "perdido";
}

function getSoccerSettlementOutcome(pick, eventMeta, summary) {
  const state = eventMeta.statusState;
  if (SOCCER_VOID_STATES.has(state)) return "void";
  if (!SOCCER_FINAL_STATES.has(state)) return null;

  const market = normalizeText(pick.mercado);
  if (market === "ml" || market.includes("ganador")) return settleSoccerMoneyline(pick, eventMeta);
  if (market.includes("double chance") || market.includes("doble oportunidad")) return settleSoccerDoubleChance(pick, eventMeta);
  if (market.includes("team total home") || market.includes("team total away") || market.includes("equipo local") || market.includes("equipo visitante")) {
    return settleSoccerTeamTotal(pick, eventMeta);
  }
  if (market.includes("corners totals") || market.includes("total de corners")) {
    return settleOverUnderValue(parseOverUnderPick(pick.pick_label), totalSoccerCorners(summary, eventMeta.homeId, eventMeta.awayId));
  }
  if (market.includes("bookings totals") || market.includes("total de tarjetas")) {
    return settleOverUnderValue(parseOverUnderPick(pick.pick_label), totalSoccerCards(summary, eventMeta.homeId, eventMeta.awayId));
  }
  if (market.includes("spread") || market.includes("handicap")) {
    return settleSoccerSpread(pick, eventMeta, summary);
  }
  if (market.includes("totals") || market.includes("total de goles")) {
    return settleOverUnderValue(parseOverUnderPick(pick.pick_label), (eventMeta.homeScore || 0) + (eventMeta.awayScore || 0));
  }
  return null;
}

async function reconcilePendingFootballPicks(picks) {
  const grouped = new Map();
  picks.forEach((pick) => {
    const dateKey = normalizePickDateKey(pick.pick_date);
    const leagueSlug = resolveFootballLeagueSlug(pick.liga || "", pick.mercado || "", pick.partido || "");
    if (!dateKey || !leagueSlug) return;
    const key = `${dateKey}|${leagueSlug}`;
    if (!grouped.has(key)) grouped.set(key, { date: dateKey, leagueSlug, picks: [] });
    grouped.get(key).picks.push(pick);
  });

  const summary = { checked: 0, resolved: 0, unresolved: 0, resolvedPicks: [] };

  for (const group of grouped.values()) {
    const candidateDates = [...new Set([
      shiftDateString(group.date, -1),
      group.date,
      shiftDateString(group.date, 1),
    ])];
    const scoreboards = await Promise.all(
      candidateDates.map((date) => fetchSoccerScoreboard(group.leagueSlug, date))
    );
    const events = scoreboards.flatMap((scoreboard) =>
      Array.isArray(scoreboard?.events) ? scoreboard.events : []
    );

    for (const pick of group.picks) {
      summary.checked += 1;
      const event = events
        .map((entry) => ({ entry, score: scoreSoccerEventMatch(entry, pick) }))
        .filter((item) => item.score >= 0.58)
        .sort((left, right) => right.score - left.score)[0]?.entry;

      if (!event) {
        if (shouldAutoVoidUnmatchedPick(pick, events, 180)) {
          const resolvedPick = await updatePickResult(Number(pick.id), "void");
          summary.resolvedPicks.push(resolvedPick);
          summary.resolved += 1;
          continue;
        }
        summary.unresolved += 1;
        continue;
      }

      const eventMeta = extractSoccerEventMeta(event);
      if (!eventMeta?.eventId) {
        summary.unresolved += 1;
        continue;
      }

      const settlementState = eventMeta.statusState;
      if (SOCCER_VOID_STATES.has(settlementState)) {
        const resolvedPick = await updatePickResult(Number(pick.id), "void");
        summary.resolvedPicks.push(resolvedPick);
        summary.resolved += 1;
        continue;
      }

      if (!SOCCER_FINAL_STATES.has(settlementState)) {
        summary.unresolved += 1;
        continue;
      }

      const detailsNeeded =
        normalizeText(pick.mercado).includes("corner") ||
        normalizeText(pick.mercado).includes("booking") ||
        normalizeText(pick.mercado).includes("tarjeta") ||
        normalizeText(pick.mercado).includes("spread") ||
        normalizeText(pick.mercado).includes("handicap");
      const summaryPayload = detailsNeeded ? await fetchSoccerSummary(group.leagueSlug, eventMeta.eventId) : null;
      const outcome = getSoccerSettlementOutcome(pick, eventMeta, summaryPayload);

      if (!outcome) {
        summary.unresolved += 1;
        continue;
      }

      const resolvedPick = await updatePickResult(Number(pick.id), outcome);
      summary.resolvedPicks.push(resolvedPick);
      summary.resolved += 1;
    }
  }

  return summary;
}

async function loadWnbaScoreboard(date) {
  const dateKey = String(date || "").replaceAll("-", "");
  if (!dateKey) return [];
  const cached = getCachedProviderPromise(wnbaScoreboardCache, dateKey);
  if (cached) return cached;

  const promise = fetchJson(`${ESPN_WNBA_SCOREBOARD_URL}${dateKey}`, {
    provider: `espn-wnba:scoreboard:${dateKey}`,
    timeoutMs: 15000,
  })
    .then((payload) => (Array.isArray(payload?.events) ? payload.events : []))
    .catch(() => []);

  return setCachedProviderPromise(wnbaScoreboardCache, dateKey, promise);
}

function extractWnbaCompetitors(event) {
  if (Array.isArray(event?.competitions?.[0]?.competitors)) {
    return event.competitions[0].competitors;
  }
  return [];
}

function extractWnbaEventMeta(event) {
  const competitors = extractWnbaCompetitors(event);
  if (competitors.length < 2) return null;
  const home = competitors.find((item) => item?.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item?.homeAway === "away") || competitors[1];

  return {
    eventId: String(event?.id || ""),
    homeName: home?.team?.displayName || home?.displayName || null,
    awayName: away?.team?.displayName || away?.displayName || null,
    homeScore: firstFinite(home?.score?.value, home?.score),
    awayScore: firstFinite(away?.score?.value, away?.score),
    statusState: scoreboardState(event?.status?.type || event?.competitions?.[0]?.status?.type || {}),
    completed: Boolean(event?.status?.type?.completed || event?.competitions?.[0]?.status?.type?.completed),
  };
}

function scoreWnbaEventMatch(event, pick) {
  const parsed = extractWnbaEventMeta(event);
  if (!parsed?.homeName || !parsed?.awayName) return 0;
  const { away, home } = parseMatchLabel(pick.partido);
  const exact = `${normalizeText(home)}::${normalizeText(away)}`;
  const candidate = `${normalizeText(parsed.homeName)}::${normalizeText(parsed.awayName)}`;
  if (exact && exact === candidate) return 1;
  return (
    overlapScore(home, parsed.homeName) +
    overlapScore(away, parsed.awayName)
  ) / 2;
}

function pickTeamSideByMarketOrLabel(pick, homeName, awayName) {
  const market = normalizeText(pick?.mercado);
  const label = normalizeText(pick?.pick_label);
  if (market.includes("local") || market.includes("home")) return "home";
  if (market.includes("visitante") || market.includes("away")) return "away";
  if (label.includes("local")) return "home";
  if (label.includes("visitante")) return "away";
  return pickTeamSideByLabel(pick?.pick_label, homeName, awayName);
}

function settleWnbaMoneyline(pick, eventMeta) {
  const homeScore = eventMeta.homeScore;
  const awayScore = eventMeta.awayScore;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const side = pickTeamSideByMarketOrLabel(pick, eventMeta.homeName, eventMeta.awayName);
  if (!side) return null;
  if (homeScore === awayScore) return "void";
  const winner = homeScore > awayScore ? "home" : "away";
  return side === winner ? "ganado" : "perdido";
}

function settleWnbaTeamTotal(pick, eventMeta) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  const side = pickTeamSideByMarketOrLabel(pick, eventMeta.homeName, eventMeta.awayName);
  const teamScore = side === "home" ? eventMeta.homeScore : side === "away" ? eventMeta.awayScore : null;
  return settleOverUnderValue(parsed, teamScore);
}

function settleWnbaGameTotal(pick, eventMeta) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  if (!Number.isFinite(eventMeta.homeScore) || !Number.isFinite(eventMeta.awayScore)) return null;
  return settleOverUnderValue(parsed, eventMeta.homeScore + eventMeta.awayScore);
}

function getWnbaSettlementOutcome(pick, eventMeta) {
  const state = eventMeta.statusState;
  if (WNBA_VOID_STATES.has(state)) return "void";
  if (!eventMeta.completed && !WNBA_FINAL_STATES.has(state)) return null;

  const market = normalizeText(pick.mercado);
  if (market.includes("team total") || market.includes("team_total") || market.includes("total local") || market.includes("total visitante")) {
    return settleWnbaTeamTotal(pick, eventMeta);
  }
  if (market.includes("game total") || market.includes("game_total") || market.includes("totals") || market.includes("total partido") || market.includes("total puntos")) {
    return settleWnbaGameTotal(pick, eventMeta);
  }
  if (market === "ml" || market.includes("moneyline") || market.includes("ganador")) {
    return settleWnbaMoneyline(pick, eventMeta);
  }
  return null;
}

async function reconcilePendingWnbaPicks(picks) {
  const byDate = new Map();
  picks.forEach((pick) => {
    const dateKey = normalizePickDateKey(pick.pick_date);
    if (!dateKey) return;
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(pick);
  });

  const summary = { checked: 0, resolved: 0, unresolved: 0, resolvedPicks: [] };

  for (const [date, datePicks] of byDate.entries()) {
    const candidateDates = [...new Set([shiftDateString(date, -1), date, shiftDateString(date, 1)])];
    const events = (await Promise.all(candidateDates.map((candidateDate) => loadWnbaScoreboard(candidateDate)))).flat();

    for (const pick of datePicks) {
      summary.checked += 1;
      const event = events
        .map((entry) => ({ entry, score: scoreWnbaEventMatch(entry, pick) }))
        .filter((item) => item.score >= 0.58)
        .sort((left, right) => right.score - left.score)[0]?.entry;

      if (!event) {
        if (shouldAutoVoidUnmatchedPick(pick, events, 360)) {
          const resolvedPick = await updatePickResult(Number(pick.id), "void");
          summary.resolvedPicks.push(resolvedPick);
          summary.resolved += 1;
          continue;
        }
        summary.unresolved += 1;
        continue;
      }

      const eventMeta = extractWnbaEventMeta(event);
      if (!eventMeta?.eventId) {
        summary.unresolved += 1;
        continue;
      }

      const outcome = getWnbaSettlementOutcome(pick, eventMeta);
      if (!outcome) {
        summary.unresolved += 1;
        continue;
      }

      const resolvedPick = await updatePickResult(Number(pick.id), outcome);
      summary.resolvedPicks.push(resolvedPick);
      summary.resolved += 1;
    }
  }

  return summary;
}

function extractTennisPeriods(scores = {}) {
  const periods = scores?.periods;
  const rows = [];

  if (Array.isArray(periods)) {
    periods.forEach((entry, index) => {
      const home = firstFinite(entry?.home, entry?.values?.home, entry?.[0]);
      const away = firstFinite(entry?.away, entry?.values?.away, entry?.[1]);
      if (home != null || away != null) {
        rows.push({ period: index + 1, home, away });
      }
    });
  } else if (periods && typeof periods === "object") {
    for (const [key, value] of Object.entries(periods)) {
      if (Number.parseInt(key, 10) === 0) continue; // period 0 = overall sets score, not individual game counts
      const home = firstFinite(value?.home, value?.values?.home, value?.[0]);
      const away = firstFinite(value?.away, value?.values?.away, value?.[1]);
      if (home != null || away != null) {
        rows.push({ period: Number.parseInt(key, 10) || rows.length + 1, home, away });
      }
    }
  }

  return rows.sort((left, right) => left.period - right.period);
}

async function fetchSettledTennisEvents(date) {
  const cacheKey = date;
  const cached = getCachedProviderPromise(tennisEventsCache, cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const { from, to } = toOddsApiDateRange(date);
    const events = await callOddsApi("/events", {
      sport: "tennis",
      from,
      to,
      status: "settled,live,pending",
      limit: 200,
    }).catch(() => []);
    return Array.isArray(events) ? events : [];
  })();

  return setCachedProviderPromise(tennisEventsCache, cacheKey, promise);
}

function scoreTennisEventMatch(event, pick) {
  const { away, home } = parseMatchLabel(pick.partido);
  const exact = matchKey(away, home);
  const candidate = matchKey(event?.away, event?.home);
  if (exact && exact === candidate) return 1;
  return (
    overlapScore(away, event?.away) +
    overlapScore(home, event?.home)
  ) / 2;
}

function tennisSideFromLabel(label, event) {
  const normalized = normalizeText(label);
  const awayName = normalizeText(event?.away);
  const homeName = normalizeText(event?.home);
  if (awayName && normalized.includes(awayName)) return "away";
  if (homeName && normalized.includes(homeName)) return "home";
  return null;
}

function tennisSetWins(periods, side) {
  let wins = 0;
  periods.forEach((set) => {
    if (!Number.isFinite(set.home) || !Number.isFinite(set.away)) return;
    if (side === "home" && set.home > set.away) wins += 1;
    if (side === "away" && set.away > set.home) wins += 1;
  });
  return wins;
}

function settleTennisWinner(pick, event, periods) {
  const side = tennisSideFromLabel(pick.pick_label, event);
  if (!side) return null;
  const winner =
    Number(event?.scores?.home) > Number(event?.scores?.away)
      ? "home"
      : Number(event?.scores?.away) > Number(event?.scores?.home)
        ? "away"
        : periods.length
          ? tennisSetWins(periods, "home") > tennisSetWins(periods, "away")
            ? "home"
            : tennisSetWins(periods, "away") > tennisSetWins(periods, "home")
              ? "away"
              : null
          : null;
  if (!winner) return "void";
  return side === winner ? "ganado" : "perdido";
}

function settleTennisTotalGames(pick, periods) {
  const parsed = parseOverUnderPick(pick.pick_label);
  if (!parsed) return null;
  const totalGames = periods.reduce((sum, set) => sum + (set.home || 0) + (set.away || 0), 0);
  return settleOverUnderValue(parsed, totalGames);
}

function settleTennisSetAny(pick, event, periods) {
  const side = tennisSideFromLabel(pick.pick_label, event);
  if (!side) return null;
  return tennisSetWins(periods, side) >= 1 ? "ganado" : "perdido";
}

function settleTennisSetWinner(pick, event, periods, targetSet = 1) {
  const side = tennisSideFromLabel(pick.pick_label, event);
  const set = periods[targetSet - 1];
  if (!side || !set || !Number.isFinite(set.home) || !Number.isFinite(set.away)) return null;
  if (set.home === set.away) return "void";
  const winner = set.home > set.away ? "home" : "away";
  return winner === side ? "ganado" : "perdido";
}

function settleTennisSetTotals(pick, periods, targetSet = 1) {
  const parsed = parseOverUnderPick(pick.pick_label);
  const set = periods[targetSet - 1];
  if (!parsed || !set || !Number.isFinite(set.home) || !Number.isFinite(set.away)) return null;
  return settleOverUnderValue(parsed, set.home + set.away);
}

function getTennisSettlementOutcome(pick, event) {
  const state = normalizeText(event?.status);
  if (TENNIS_VOID_STATES.has(state)) return "void";
  if (!TENNIS_FINAL_STATES.has(state)) return null;

  const periods = extractTennisPeriods(event?.scores || {});
  const market = normalizeText(pick.mercado);
  const label = normalizeText(pick.pick_label);

  if (market.includes("ganador del partido")) return settleTennisWinner(pick, event, periods);
  if (market.includes("ganara al menos un set") || label.includes("al menos 1 set") || label.includes("al menos un set")) {
    return settleTennisSetAny(pick, event, periods);
  }
  if (market.includes("total juegos 1er set") || label.includes("1er set")) {
    if (label.includes("mas de") || label.includes("menos de") || label.includes("over") || label.includes("under")) {
      return settleTennisSetTotals(pick, periods, 1);
    }
    return settleTennisSetWinner(pick, event, periods, 1);
  }
  if (market.includes("total juegos 2do set") || label.includes("2do set") || label.includes("2nd set")) {
    if (label.includes("mas de") || label.includes("menos de") || label.includes("over") || label.includes("under")) {
      return settleTennisSetTotals(pick, periods, 2);
    }
    return settleTennisSetWinner(pick, event, periods, 2);
  }
  if (market.includes("ganador 1er set")) return settleTennisSetWinner(pick, event, periods, 1);
  if (market.includes("ganador 2do set")) return settleTennisSetWinner(pick, event, periods, 2);
  if (market.includes("total de juegos")) return settleTennisTotalGames(pick, periods);
  return null;
}

async function reconcilePendingTennisPicks(picks) {
  const byDate = new Map();
  picks.forEach((pick) => {
    const dateKey = normalizePickDateKey(pick.pick_date);
    if (!dateKey) return;
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(pick);
  });

  const summary = { checked: 0, resolved: 0, unresolved: 0, resolvedPicks: [] };

  for (const [date, datePicks] of byDate.entries()) {
    let events = [];
    try {
      events = await fetchSettledTennisEvents(date);
    } catch {
      events = [];
    }

    for (const pick of datePicks) {
      summary.checked += 1;
      const event = events
        .map((entry) => ({ entry, score: scoreTennisEventMatch(entry, pick) }))
        .filter((item) => item.score >= 0.58)
        .sort((left, right) => right.score - left.score)[0]?.entry;

      if (!event) {
        if (shouldAutoVoidUnmatchedPick(pick, events, 120)) {
          const resolvedPick = await updatePickResult(Number(pick.id), "void");
          summary.resolvedPicks.push(resolvedPick);
          summary.resolved += 1;
          continue;
        }
        summary.unresolved += 1;
        continue;
      }

      const outcome = getTennisSettlementOutcome(pick, event);
      if (!outcome) {
        summary.unresolved += 1;
        continue;
      }

      const resolvedPick = await updatePickResult(Number(pick.id), outcome);
      summary.resolvedPicks.push(resolvedPick);
      summary.resolved += 1;
    }
  }

  return summary;
}

async function notifyResolvedPicksFromSummary(summary) {
  const resolvedPicks = Array.isArray(summary?.resolvedPicks) ? summary.resolvedPicks : [];
  if (!resolvedPicks.length) return;
  await Promise.allSettled(
    resolvedPicks.map((pick) =>
      notifyResolvedPickTelegram(pick).catch((error) => {
        console.error("[telegram] Error notificando pick resuelto (settlement):", error.message);
      })
    )
  );
}

async function maybeNotifyDailyBalanceForDates(dates = []) {
  const uniqueDates = [...new Set(
    dates
      .map((value) => normalizePickDateKey(value))
      .filter(Boolean)
  )];
  if (!uniqueDates.length) return;

  for (const date of uniqueDates) {
    const dayPicks = await getPicks({ date, limit: 5000 });
    const pendientes = dayPicks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "pendiente").length;
    if (pendientes > 0) continue;

    const ganados = dayPicks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "ganado").length;
    const perdidos = dayPicks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "perdido").length;
    const voids = dayPicks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "void").length;
    const totalResueltos = ganados + perdidos + voids;
    if (totalResueltos <= 0) continue;

    await notifyDailyBalanceTelegram({
      date,
      ganados,
      perdidos,
      voids,
      totalResueltos,
    }).catch((error) => {
      console.error("[telegram] Error notificando balance diario:", error.message);
    });
  }
}

async function runTrackerSettlement() {
  const pending = await getPicks({ resultado: "pendiente", limit: 1000 });
  const duePicks = pending.filter((pick) => getPendingPickTimingMetaLive(pick).started);
  const dueDates = [...new Set(duePicks.map((pick) => normalizePickDateKey(pick.pick_date)).filter(Boolean))];

  const mlbPending = duePicks.filter((pick) => normalizeText(pick.sport) === "mlb");
  const footballPending = duePicks.filter((pick) => normalizeText(pick.sport) === "futbol" || normalizeText(pick.sport) === "football");
  const wnbaPending = duePicks.filter((pick) => normalizeText(pick.sport) === "wnba");
  const tennisPending = duePicks.filter((pick) => normalizeText(pick.sport) === "tennis");

  const mlb = await reconcilePendingMlbPicks(mlbPending);
  const football = await reconcilePendingFootballPicks(footballPending);
  const wnba = await reconcilePendingWnbaPicks(wnbaPending);
  const tennis = await reconcilePendingTennisPicks(tennisPending);

  await notifyResolvedPicksFromSummary(mlb);
  await notifyResolvedPicksFromSummary(football);
  await notifyResolvedPicksFromSummary(wnba);
  await notifyResolvedPicksFromSummary(tennis);
  await maybeNotifyDailyBalanceForDates(dueDates);

  return {
    pending: pending.length,
    due: duePicks.length,
    mlb,
    football,
    wnba,
    tennis,
  };
}

export async function reconcilePendingTrackerPicks({ force = false } = {}) {
  if (syncPromise) return syncPromise;
  if (!force && (Date.now() - lastSyncAt) < TRACKER_SYNC_TTL_MS) {
    return { skipped: true };
  }

  syncPromise = (async () => {
    try {
      return await runTrackerSettlement();
    } finally {
      lastSyncAt = Date.now();
      syncPromise = null;
    }
  })();

  return syncPromise;
}
