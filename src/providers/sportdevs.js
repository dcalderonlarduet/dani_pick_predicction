import { canonicalName } from "./shared/tennis-normalizers.js";
import { fetchJson } from "./shared/http.js";

function createMatchLookupKey(nameA, nameB) {
  return [canonicalName(nameA), canonicalName(nameB)].sort().join("::");
}

function toSportDevsDate(date) {
  return String(date || "");
}

function buildUrl(config, pathname, params = {}) {
  const url = new URL(`${config.sportDevs.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildHeaders(config) {
  if (config.sportDevs.apiKey) {
    return {
      Authorization: `Bearer ${config.sportDevs.apiKey}`,
    };
  }

  if (config.sportDevs.rapidApiKey && config.sportDevs.rapidApiHost) {
    return {
      "X-RapidAPI-Key": config.sportDevs.rapidApiKey,
      "X-RapidAPI-Host": config.sportDevs.rapidApiHost,
    };
  }

  return {};
}

async function callSportDevs(config, pathname, params = {}) {
  return fetchJson(buildUrl(config, pathname, params), {
    provider: `sportdevs:${pathname}`,
    headers: buildHeaders(config),
    timeoutMs: 12000,
  });
}

async function loadRankingMap(config, type) {
  const rows = await callSportDevs(config, "/rankings", {
    type: `eq.${type}`,
    class: "eq.official",
    limit: config.sportDevs.rankingsLimit,
    offset: 0,
    lang: config.sportDevs.language,
  }).catch(() => []);

  const map = new Map();
  for (const row of rows || []) {
    if (!row?.team_name || !Number.isFinite(Number(row?.rank))) continue;
    map.set(canonicalName(row.team_name), Number(row.rank));
  }
  return map;
}

function parseSportDevsStatus(match) {
  const statusType = String(match?.status_type || match?.status || "").toLowerCase();
  if (!statusType) return "scheduled";
  return statusType;
}

function parseSportDevsNames(match) {
  const home =
    match?.home_team_name ||
    match?.home_name ||
    match?.team1_name ||
    null;
  const away =
    match?.away_team_name ||
    match?.away_name ||
    match?.team2_name ||
    null;

  if (home && away) {
    return [String(home).trim(), String(away).trim()];
  }

  const label = String(match?.name || "");
  if (label.includes(" vs ")) {
    return label.split(/\s+vs\s+/i).map((value) => value.trim()).slice(0, 2);
  }

  return [null, null];
}

function buildLiveState(match) {
  return {
    provider: "sportdevs",
    matchId: match?.id || null,
    status: parseSportDevsStatus(match),
    detail: match?.status_description || null,
    scores: {
      current: match?.current || null,
      display: match?.display || null,
      point: match?.point || null,
      period1: match?.period1 || null,
      period2: match?.period2 || null,
      period3: match?.period3 || null,
      period4: match?.period4 || null,
      period5: match?.period5 || null,
    },
  };
}

async function loadMatchesByDate(config, date) {
  const rows = await callSportDevs(config, "/matches-by-date", {
    date: `eq.${toSportDevsDate(date)}`,
    limit: config.sportDevs.matchesLimit,
    offset: 0,
    lang: config.sportDevs.language,
  }).catch(() => []);

  return rows.flatMap((row) => (Array.isArray(row?.matches) ? row.matches : []));
}

export async function enrichSlateWithSportDevs(slate, config, date) {
  if (!config.sportDevs.enabled || (!config.sportDevs.apiKey && !(config.sportDevs.rapidApiKey && config.sportDevs.rapidApiHost))) {
    return slate;
  }

  const [atpRankingMap, wtaRankingMap, matches] = await Promise.all([
    loadRankingMap(config, "atp"),
    loadRankingMap(config, "wta"),
    loadMatchesByDate(config, date),
  ]);

  const liveMap = new Map();
  for (const match of matches) {
    const [homeName, awayName] = parseSportDevsNames(match);
    if (!homeName || !awayName) continue;
    liveMap.set(createMatchLookupKey(homeName, awayName), buildLiveState(match));
  }

  let matched = 0;
  for (const match of slate.matches) {
    const rankingMap = match.category.includes("WTA") ? wtaRankingMap : atpRankingMap;
    for (const participant of match.participants) {
      if ((!participant.ranking || participant.ranking === 999) && rankingMap.has(canonicalName(participant.name))) {
        participant.ranking = rankingMap.get(canonicalName(participant.name));
      }
    }

    const lookupKey = createMatchLookupKey(match.participants[0].name, match.participants[1].name);
    const liveState = liveMap.get(lookupKey);
    if (liveState) {
      match.liveState = match.liveState || liveState;
      match.providerContext = {
        ...(match.providerContext || {}),
        sportDevsMatchId: liveState.matchId,
      };
      matched += 1;
    }
  }

  slate.diagnostics = {
    ...(slate.diagnostics || {}),
    sportDevsMatched: matched,
  };

  const backupProvider = slate.providerManifest.providers.find((provider) => provider.id === "backup-stats");
  if (backupProvider) {
    backupProvider.status = "configured";
    backupProvider.notes = matched
      ? "SportDevs aporto ranking fallback y estado complementario para partidos enlazados."
      : "SportDevs quedo disponible como respaldo, pero no encontro enlace por nombres en este slate.";
  }

  return slate;
}
