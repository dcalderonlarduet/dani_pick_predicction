import { fetchJson } from "./http.js";
import { loadWithCache } from "./resource-cache.js";
import { canonicalName } from "./tennis-normalizers.js";

const DEFAULT_TTL_MS = 12 * 60 * 1000;
const DEFAULT_STALE_MS = 45 * 60 * 1000;

export function apiSportsSeasonLabel(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (month >= 8) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

export function apiSportsSeasonYear(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month >= 8 ? year : year - 1;
}

function overlapScore(left, right) {
  const a = canonicalName(left);
  const b = canonicalName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const at = new Set(a.split(" "));
  const bt = new Set(b.split(" "));
  let shared = 0;
  for (const token of at) {
    if (bt.has(token)) shared += 1;
  }
  return shared / Math.max(at.size, bt.size);
}

export function matchApiSportsGame(games, home, away) {
  let best = null;
  let bestScore = 0;
  for (const game of games || []) {
    const score =
      (overlapScore(home, game?.teams?.home?.name) + overlapScore(away, game?.teams?.away?.name)) / 2;
    if (score > bestScore) {
      bestScore = score;
      best = game;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

async function callApiSports(config, pathname, params, namespace) {
  if (!config?.enabled || !config?.apiKey) return null;
  const url = new URL(pathname, config.baseUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  try {
    return await loadWithCache(
      namespace,
      url.toString(),
      { ttlMs: DEFAULT_TTL_MS, staleMs: DEFAULT_STALE_MS },
      () =>
        fetchJson(url.toString(), {
          provider: namespace,
          headers: { "x-apisports-key": config.apiKey },
          timeoutMs: 20000,
        })
    );
  } catch {
    return null;
  }
}

export async function fetchApiSportsGames(config, { date, league, season }) {
  const payload = await callApiSports(
    config,
    "/games",
    { date, league, season },
    `${config.namespace}:games`
  );
  return Array.isArray(payload?.response) ? payload.response : [];
}

export async function fetchApiSportsGameStatistics(config, gameId) {
  const payload = await callApiSports(
    config,
    "/games/statistics",
    { id: gameId },
    `${config.namespace}:stats:${gameId}`
  );
  return Array.isArray(payload?.response) ? payload.response : [];
}

export async function fetchApiSportsTeamStatistics(config, { teamId, league, season }) {
  const payload = await callApiSports(
    config,
    "/statistics",
    { team: teamId, league, season },
    `${config.namespace}:team-stats:${teamId}:${season}`
  );
  return payload?.response || null;
}

function statFromGroups(groups, keys) {
  const list = Array.isArray(groups) ? groups : [];
  for (const group of list) {
    for (const row of group?.statistics || []) {
      const label = String(row?.type || row?.name || "").toLowerCase();
      if (keys.some((key) => label.includes(key))) {
        const value = Number(row?.value ?? row?.displayValue);
        if (Number.isFinite(value)) return value;
      }
    }
  }
  return null;
}

export function parseBasketballTeamStats(response) {
  const groups = response?.statistics || response?.response?.[0]?.statistics || [];
  const pts = statFromGroups(groups, ["points", "points per game", "pts"]);
  const pace = statFromGroups(groups, ["pace", "possessions"]);
  const offRtg = statFromGroups(groups, ["offensive rating", "off rating", "offrtg"]);
  const defRtg = statFromGroups(groups, ["defensive rating", "def rating", "defrtg"]);
  if (!pts && !offRtg) return null;
  return {
    ptsPerGame: pts ?? (offRtg && pace ? (offRtg * pace) / 100 : null),
    pace: pace ?? 99,
    offRtg1h: offRtg ?? 114,
    defRtg: defRtg ?? 114,
    source: "api-sports-basketball",
  };
}

export function parseAmericanFootballTeamStats(response) {
  const groups = response?.statistics || response?.response?.[0]?.statistics || [];
  const pts = statFromGroups(groups, ["points", "points per game", "scoring"]);
  const ptsAllowed = statFromGroups(groups, [
    "points allowed",
    "points against",
    "opponent points",
    "opp points",
    "points conceded",
  ]);
  const yards = statFromGroups(groups, ["yards", "total yards"]);
  const yardsAllowed = statFromGroups(groups, [
    "yards allowed",
    "yards against",
    "opponent yards",
    "opp yards",
    "yards conceded",
  ]);
  if (!pts && !yards) return null;
  return {
    ptsPerGame: pts ?? 22,
    ptsAllowedPerGame: ptsAllowed ?? null,
    yardsPerGame: yards ?? 330,
    yardsAllowedPerGame: yardsAllowed ?? null,
    source: "api-sports-american-football",
  };
}

export function parseApiSportsH2hTotals(games, sport) {
  const rows = Array.isArray(games) ? games : [];
  if (rows.length < 2) return null;
  let sum = 0;
  let count = 0;
  for (const game of rows.slice(0, 5)) {
    const home = Number(game?.scores?.home?.total ?? game?.score?.home);
    const away = Number(game?.scores?.away?.total ?? game?.score?.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
    const total = home + away;
    if (sport === "nba") {
      const h1 = Number(game?.scores?.home?.quarter_1) + Number(game?.scores?.home?.quarter_2);
      const a1 = Number(game?.scores?.away?.quarter_1) + Number(game?.scores?.away?.quarter_2);
      if (Number.isFinite(h1) && Number.isFinite(a1)) {
        sum += h1 + a1;
        count += 1;
        continue;
      }
    }
    sum += sport === "nba" ? total * 0.49 : total * 0.48;
    count += 1;
  }
  if (!count) return null;
  return sum / count;
}

export function parseApiSportsH2hFullTotal(games) {
  const rows = Array.isArray(games) ? games : [];
  if (rows.length < 2) return null;
  let sum = 0;
  let count = 0;
  for (const game of rows.slice(0, 5)) {
    const home = Number(game?.scores?.home?.total ?? game?.score?.home);
    const away = Number(game?.scores?.away?.total ?? game?.score?.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
    sum += home + away;
    count += 1;
  }
  return count >= 2 ? sum / count : null;
}
