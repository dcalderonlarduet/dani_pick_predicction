import { getRuntimeConfig } from "../config/runtime.js";
import { getOddsApiIoProviderEntry } from "../providers/odds-api-io.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import { normalizeCommenceTime } from "./schedule-match.js";
import { normalizeWnbaTeamName, wnbaTeamNamesMatch } from "../utils/wnba-team-names.js";

export { normalizeCommenceTime };

function scheduleDateFromEntry(entry) {
  return normalizeCommenceTime(entry?.commenceTime || entry?.startTime || entry?.date).slice(0, 10);
}

function scheduleTimeFromEntry(entry) {
  return normalizeCommenceTime(entry?.commenceTime || entry?.startTime || entry?.date);
}

function matchesSchedule(entry, scheduleDate, startTime) {
  const target = String(scheduleDate || startTime || "").slice(0, 10);
  if (!target) return true;
  const entryDate = scheduleDateFromEntry(entry);
  return !entryDate || entryDate === target;
}

function matchesScheduleTime(entry, scheduleDate, startTime) {
  const target = normalizeCommenceTime(startTime || scheduleDate);
  const entryTime = scheduleTimeFromEntry(entry);
  if (!target) return matchesSchedule(entry, scheduleDate, startTime);
  if (!entryTime) return matchesSchedule(entry, scheduleDate, startTime);
  const targetMs = Date.parse(target);
  const entryMs = Date.parse(entryTime);
  if (!Number.isFinite(targetMs) || !Number.isFinite(entryMs)) {
    return target.slice(0, 10) === entryTime.slice(0, 10);
  }
  return Math.abs(targetMs - entryMs) <= 3 * 60 * 60 * 1000;
}

function teamPairKey(homeName, awayName, sport = "") {
  const normalizeTeam = sport === "wnba" ? normalizeWnbaTeamName : canonicalName;
  return [normalizeTeam(homeName), normalizeTeam(awayName)].join("::");
}

function collectFuzzyOddsCandidates(oddsMap, homeName, awayName, sport = "") {
  const homeKey = canonicalName(homeName);
  const awayKey = canonicalName(awayName);
  const candidates = [];
  const seen = new Set();

  for (const [key, entry] of oddsMap.entries()) {
    if (key.startsWith("event:")) continue;

    const parts = key.split("::");
    const keyHome = parts[0] || "";
    const keyAway = parts[1] || "";
    const entryHome = entry?.home_team || keyHome;
    const entryAway = entry?.away_team || keyAway;

    let matched = false;
    if (sport === "wnba") {
      matched = wnbaTeamNamesMatch(homeName, entryHome) && wnbaTeamNamesMatch(awayName, entryAway);
    } else {
      matched =
        (keyHome === homeKey && keyAway === awayKey) ||
        (key.includes(homeKey) && key.includes(awayKey));
    }

    if (!matched) continue;
    const token = String(entry?.eventId || key);
    if (seen.has(token)) continue;
    seen.add(token);
    candidates.push(entry);
  }

  return candidates;
}

function pickClosestByTime(candidates, startTime) {
  const target = Date.parse(normalizeCommenceTime(startTime));
  if (!Number.isFinite(target) || candidates.length <= 1) return candidates[0] || null;
  let best = null;
  let bestDelta = Infinity;
  for (const entry of candidates) {
    const entryMs = Date.parse(scheduleTimeFromEntry(entry));
    if (!Number.isFinite(entryMs)) continue;
    const delta = Math.abs(entryMs - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best;
}

function resolveScheduleMatchedEntry(candidates, scheduleDate, startTime) {
  const normalizedStart = normalizeCommenceTime(startTime);
  const uniqueCandidates = [];
  const seen = new Set();
  for (const entry of candidates) {
    const token = String(entry?.eventId || entry);
    if (seen.has(token)) continue;
    seen.add(token);
    uniqueCandidates.push(entry);
  }

  if (uniqueCandidates.length === 1) {
    return matchesScheduleTime(uniqueCandidates[0], scheduleDate, startTime) ? uniqueCandidates[0] : null;
  }

  if (uniqueCandidates.length > 1) {
    const filtered = uniqueCandidates.filter((entry) => matchesScheduleTime(entry, scheduleDate, startTime));
    if (filtered.length === 1) return filtered[0];
    if (filtered.length > 1 && normalizedStart) {
      return pickClosestByTime(filtered, startTime) || null;
    }
    return null;
  }

  return null;
}

/**
 * Resuelve cuotas de un partido sin mezclar con otro juego del mismo par de equipos.
 * Prioridad: eventId → par+fecha+hora → par+fecha → candidato único filtrado por hora.
 */
export function findProOddsEntry(
  oddsMap,
  homeName,
  awayName,
  eventId = null,
  scheduleDate = null,
  startTime = null,
  sport = ""
) {
  if (!oddsMap?.size) return null;

  if (eventId != null && eventId !== "") {
    const byEvent = oddsMap.get(`event:${eventId}`) || oddsMap.get(String(eventId));
    if (byEvent) return byEvent;
  }

  const exactKey = teamPairKey(homeName, awayName, sport);
  const normalizedStart = normalizeCommenceTime(startTime);
  const dateKey = String(scheduleDate || startTime || "").slice(0, 10);

  const candidates = [];
  for (const [key, entry] of oddsMap.entries()) {
    if (key.startsWith("event:")) continue;
    if (key === exactKey || key.startsWith(`${exactKey}::`)) {
      candidates.push(entry);
    }
  }

  if (normalizedStart) {
    const dateTimeKey = `${exactKey}::${normalizedStart.slice(0, 10)}::${normalizedStart}`;
    const byDateTime = oddsMap.get(dateTimeKey);
    if (byDateTime) return byDateTime;
  }

  if (dateKey) {
    const sameDateEntries = candidates.filter((entry) => matchesSchedule(entry, scheduleDate, startTime));
    if (sameDateEntries.length === 1) {
      return sameDateEntries[0];
    }
    if (sameDateEntries.length <= 1) {
      const dated = oddsMap.get(`${exactKey}::${dateKey}`);
      if (dated && (!normalizedStart || matchesScheduleTime(dated, scheduleDate, startTime))) {
        return dated;
      }
    }
  }

  const exactResolved = resolveScheduleMatchedEntry(candidates, scheduleDate, startTime);
  if (exactResolved) return exactResolved;

  const fuzzyCandidates = collectFuzzyOddsCandidates(oddsMap, homeName, awayName, sport);
  if (!fuzzyCandidates.length) return null;

  if (dateKey) {
    const sameDateFuzzy = fuzzyCandidates.filter((entry) => matchesSchedule(entry, scheduleDate, startTime));
    if (sameDateFuzzy.length === 1) return sameDateFuzzy[0];
    if (sameDateFuzzy.length > 1) {
      return resolveScheduleMatchedEntry(sameDateFuzzy, scheduleDate, startTime);
    }
  }

  return resolveScheduleMatchedEntry(fuzzyCandidates, scheduleDate, startTime);
}

export async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function buildProProvidersManifest({ sport, hasOddsKey, apiSportsEnabled }) {
  return [
  {
    id: "espn",
    name: "ESPN",
    status: "configured",
    purpose: `Datos ${sport.toUpperCase()} (scoreboard, summary, lesiones).`,
  },
  getOddsApiIoProviderEntry(hasOddsKey ? process.env.ODDS_API_IO_KEY : ""),
  {
    id: "api-sports",
    name: "API-Sports",
    status: apiSportsEnabled ? "configured" : "missing-credentials",
    purpose: `Fallback silencioso si ESPN no completa stats/H2H (${sport}).`,
  },
  {
    id: "oddsharvester",
    name: "OddsHarvester",
    status: getRuntimeConfig().communityStack?.oddsharvesterSnapshotFile ? "configured" : "optional",
    purpose: "Line movement (tickets vs handle).",
  },
  ];
}

export function buildProUnavailableAnalysis(sport, date, reason, { hasOddsKey, apiSportsEnabled, week, season }) {
  return {
    sport,
    date,
    week: week ?? null,
    season: season ?? null,
    dataAvailable: false,
    reason,
    games: [],
    picks: [],
    modelPicks: [],
    providers: buildProProvidersManifest({ sport, hasOddsKey, apiSportsEnabled }),
    slateSummary: { totalGames: 0, bettableGames: 0, topPicks: 0 },
  };
}
