import { fetchJson } from "./http.js";
import { canonicalName } from "./tennis-normalizers.js";

const CACHE = new Map();
const CACHE_MS = 8 * 60 * 1000;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_MS) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  CACHE.set(key, { at: Date.now(), value });
}

export function espnDateParam(date) {
  return String(date || "").replaceAll("-", "");
}

export function extractCompetitors(event) {
  const competitors = event?.competitions?.[0]?.competitors;
  if (!Array.isArray(competitors) || competitors.length < 2) return null;
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
  const homeName = home?.team?.displayName || home?.displayName;
  const awayName = away?.team?.displayName || away?.displayName;
  if (!homeName || !awayName) return null;
  return {
    eventId: String(event?.id || ""),
    homeName,
    awayName,
    homeId: String(home?.team?.id || home?.id || ""),
    awayId: String(away?.team?.id || away?.id || ""),
    homeRecord: home?.records?.[0]?.summary || null,
    awayRecord: away?.records?.[0]?.summary || null,
    status: event?.status?.type?.description || event?.status?.type?.name || "scheduled",
    startIso: event?.date || event?.competitions?.[0]?.date || null,
    venue: event?.competitions?.[0]?.venue?.fullName || null,
    indoor: Boolean(event?.competitions?.[0]?.indoor),
  };
}

export async function fetchEspnJson(url, cacheKey) {
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }
  const payload = await fetchJson(url, { timeoutMs: 18000, provider: "espn" });
  if (cacheKey) cacheSet(cacheKey, payload);
  return payload;
}

export async function fetchScoreboard(scoreboardUrl, date, cachePrefix) {
  const cacheKey = `${cachePrefix}|sb|${date}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const payload = await fetchEspnJson(`${scoreboardUrl}?dates=${espnDateParam(date)}`, cacheKey);
  const events = Array.isArray(payload?.events) ? payload.events : [];
  cacheSet(cacheKey, events);
  return events;
}

export async function fetchEventSummary(summaryUrlTemplate, eventId) {
  const url = summaryUrlTemplate.replace("{id}", encodeURIComponent(eventId));
  const cacheKey = `summary|${url}`;
  return fetchEspnJson(url, cacheKey);
}

export function matchScoreboardEvent(events, home, away) {
  let best = null;
  let bestScore = 0;
  for (const event of events) {
    const teams = extractCompetitors(event);
    if (!teams) continue;
    const direct =
      canonicalName(teams.homeName) === canonicalName(home) &&
      canonicalName(teams.awayName) === canonicalName(away);
    const score = direct
      ? 1
      : (tokenOverlap(home, teams.homeName) + tokenOverlap(away, teams.awayName)) / 2;
    if (score > bestScore) {
      bestScore = score;
      best = { event, teams };
    }
  }
  return bestScore >= 0.55 ? best : null;
}

function tokenOverlap(left, right) {
  const a = new Set(canonicalName(left).split(" ").filter(Boolean));
  const b = new Set(canonicalName(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.max(a.size, b.size);
}

export function parseInjuryFlags(summary) {
  const items = [];
  const groups = [
    ...(summary?.injuries || []),
    ...(summary?.pickcenter?.injuries || []),
  ];
  for (const group of groups) {
    for (const athlete of group?.injuries || group?.athletes || []) {
      const status = String(athlete?.status || athlete?.type || "").toLowerCase();
      if (/out|doubt|question|injur|suspend/.test(status)) {
        items.push({
          name: athlete?.athlete?.displayName || athlete?.displayName || "Unknown",
          status,
        });
      }
    }
  }
  const hayNoticiaLesion = items.length > 0;
  const starterOut = items.filter((item) => /out/.test(item.status)).length;
  return { injuries: items, hay_noticia_lesion: hayNoticiaLesion, starterOut };
}

export function leagueAverages(sport) {
  if (sport === "nfl") {
    return {
      pace: 62,
      ptsGame: 44,
      pts1h: 21.5,
      offRtg: 22,
      defRtg: 22,
    };
  }
  if (sport === "wnba") {
    return {
      pace: 88,
      ptsGame: 166,
      pts1h: 81,
      offRtg: 100,
      defRtg: 100,
    };
  }
  return {
    pace: 99,
    ptsGame: 228,
    pts1h: 112,
    offRtg: 114,
    defRtg: 114,
  };
}

export function buildFormFromSummary(summary, side, sport) {
  const avg = leagueAverages(sport);
  const lines = summary?.boxscore?.teams || summary?.boxscore?.players || [];
  const teamBlock = Array.isArray(lines)
    ? lines.find((entry) => String(entry?.homeAway || "").toLowerCase() === side)
    : null;
  const stats = teamBlock?.statistics || [];
  const pts = statValue(stats, ["points", "total points", "pts"]) ?? avg.ptsGame;
  const pace = statValue(stats, ["possessions", "pace"]) ?? avg.pace;
  return {
    ptsPerGame: pts,
    pace,
    pts1h: pts * 0.49,
    offRtg1h: (pts / Math.max(pace, 1)) * 100,
    sample: 10,
    source: "espn-summary",
  };
}

function statValue(stats, keys) {
  if (!Array.isArray(stats)) return null;
  for (const row of stats) {
    const label = String(row?.name || row?.label || "").toLowerCase();
    if (keys.some((key) => label.includes(key))) {
      const value = Number(row?.displayValue ?? row?.value);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

export function espnSeasonYear(date, sport = "nba") {
  const d = new Date(`${date}T12:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (sport === "nfl") return month >= 3 && month <= 8 ? year : month >= 9 ? year : year - 1;
  return month >= 10 ? year : year - 1;
}

export async function fetchEspnTeamSeasonStats(statsUrlTemplate, teamId, year) {
  if (!teamId) return null;
  const url = statsUrlTemplate.replace("{yr}", String(year)).replace("{id}", encodeURIComponent(teamId));
  try {
    return await fetchEspnJson(url, `espn-stats|${url}`);
  } catch {
    return null;
  }
}

export function parseEspnSeasonTeamForm(statsPayload, sport) {
  const avg = leagueAverages(sport);
  const categories = statsPayload?.splits?.categories || statsPayload?.statistics?.splits?.categories || [];
  let pts = null;
  let pace = null;
  let offRtg = null;
  let defRtg = null;

  for (const category of categories) {
    const stats = category?.stats || [];
    pts = pts ?? statValue(stats, ["points per game", "avg points", "points"]);
    pace = pace ?? statValue(stats, ["pace", "possessions"]);
    offRtg = offRtg ?? statValue(stats, ["offensive rating", "off rating"]);
    defRtg = defRtg ?? statValue(stats, ["defensive rating", "def rating"]);
  }

  if (!pts && !offRtg) return null;
  const resolvedPace = pace ?? avg.pace;
  const resolvedOff = offRtg ?? (pts && resolvedPace ? (pts / resolvedPace) * 100 : avg.offRtg);
  const resolvedPts = pts ?? (resolvedOff * resolvedPace) / 100;
  return {
    ptsPerGame: resolvedPts,
    pace: resolvedPace,
    offRtg1h: resolvedOff,
    defRtg: defRtg ?? avg.defRtg,
    pts1h: resolvedPts * 0.49,
    sample: 10,
    source: "espn-season-stats",
  };
}

/** Totales de puntos/goles de los últimos partidos finalizados (para sigma dinámico). */
export function parseEspnTeamRecentTotals(schedulePayload, teamId, { limit = 15, sport = "nfl" } = {}) {
  const events = schedulePayload?.events || schedulePayload?.team?.events || [];
  const totals = [];
  for (const event of events) {
    const status = String(event?.competitions?.[0]?.status?.type?.name || event?.status?.type?.name || "").toLowerCase();
    if (!/final|post|completed/.test(status)) continue;

    const competitors = event?.competitions?.[0]?.competitors || [];
    const mine = competitors.find((row) => String(row?.team?.id || row?.id) === String(teamId));
    const rival = competitors.find((row) => String(row?.team?.id || row?.id) !== String(teamId));
    if (!mine || !rival) continue;

    const mineScore = Number(mine?.score ?? mine?.team?.score);
    const rivalScore = Number(rival?.score ?? rival?.team?.score);
    if (!Number.isFinite(mineScore)) continue;

    totals.push(sport === "football" ? mineScore : mineScore + (Number.isFinite(rivalScore) ? rivalScore : 0));
    if (totals.length >= limit) break;
  }
  return totals;
}

export function parseEspnTeamRecentScoring(schedulePayload, teamId, { limit = 8 } = {}) {
  const events = schedulePayload?.events || schedulePayload?.team?.events || [];
  const pointsFor = [];
  const pointsAgainst = [];
  const totals = [];

  for (const event of events) {
    const status = String(event?.competitions?.[0]?.status?.type?.name || event?.status?.type?.name || "").toLowerCase();
    if (!/final|post|completed/.test(status)) continue;

    const competitors = event?.competitions?.[0]?.competitors || [];
    const mine = competitors.find((row) => String(row?.team?.id || row?.id) === String(teamId));
    const rival = competitors.find((row) => String(row?.team?.id || row?.id) !== String(teamId));
    if (!mine || !rival) continue;

    const mineScore = Number(mine?.score ?? mine?.team?.score);
    const rivalScore = Number(rival?.score ?? rival?.team?.score);
    if (!Number.isFinite(mineScore) || !Number.isFinite(rivalScore)) continue;

    pointsFor.push(mineScore);
    pointsAgainst.push(rivalScore);
    totals.push(mineScore + rivalScore);
    if (pointsFor.length >= limit) break;
  }

  const average = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    pointsFor,
    pointsAgainst,
    totals,
    avgFor: average(pointsFor),
    avgAgainst: average(pointsAgainst),
    avgTotal: average(totals),
    sample: pointsFor.length,
  };
}

function espnH2hRows(summary) {
  const meetings =
    summary?.header?.lastFiveMeetings ||
    summary?.pickcenter?.previousGames ||
    summary?.againstTheSpread?.meetings ||
    [];
  return Array.isArray(meetings) ? meetings : [];
}

export function parseEspnH2hFullTotal(summary) {
  const rows = espnH2hRows(summary);
  if (rows.length < 2) return null;

  let sum = 0;
  let count = 0;
  for (const row of rows.slice(0, 5)) {
    const homeScore = Number(row?.homeScore ?? row?.score?.home ?? row?.home?.score);
    const awayScore = Number(row?.awayScore ?? row?.score?.away ?? row?.away?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    sum += homeScore + awayScore;
    count += 1;
  }
  return count >= 2 ? sum / count : null;
}

export function parseEspnH2h1h(summary, sport) {
  const rows = espnH2hRows(summary);
  if (rows.length < 2) return null;

  let sum = 0;
  let count = 0;
  for (const row of rows.slice(0, 5)) {
    const homeScore = Number(row?.homeScore ?? row?.score?.home ?? row?.home?.score);
    const awayScore = Number(row?.awayScore ?? row?.score?.away ?? row?.away?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const total = homeScore + awayScore;
    sum += sport === "nfl" ? total * 0.48 : total * 0.49;
    count += 1;
  }
  return count ? sum / count : null;
}

export function parseEspnRecentForm(summary, side, sport) {
  const lines = summary?.boxscore?.teams || [];
  const teamBlock = Array.isArray(lines)
    ? lines.find((entry) => String(entry?.homeAway || "").toLowerCase() === side)
    : null;
  const form = buildFormFromSummary(summary, side, sport);
  if (!teamBlock) return form;
  const linescores = teamBlock?.linescores || [];
  const firstHalf = linescores
    .slice(0, 2)
    .reduce((acc, row) => acc + Number(row?.displayValue ?? row?.value ?? 0), 0);
  if (Number.isFinite(firstHalf) && firstHalf > 0) {
    form.pts1h = firstHalf;
    form.offRtg1h = (firstHalf / Math.max(form.pace, 1)) * 100;
  }
  return form;
}

export function computeScheduleFatigue(events, teamId, gameIso) {
  if (!teamId || !gameIso) return { factor: 1, tag: "normal" };
  const gameTime = new Date(gameIso).getTime();
  if (!Number.isFinite(gameTime)) return { factor: 1, tag: "normal" };

  let lastGameTime = null;
  for (const event of events || []) {
    const teams = extractCompetitors(event);
    if (!teams) continue;
    if (teams.homeId !== teamId && teams.awayId !== teamId) continue;
    const start = new Date(teams.startIso || 0).getTime();
    if (!Number.isFinite(start) || start >= gameTime) continue;
    if (!lastGameTime || start > lastGameTime) lastGameTime = start;
  }

  if (!lastGameTime) return { factor: 1, tag: "normal" };
  const days = (gameTime - lastGameTime) / 86400000;
  if (days <= 1.1) return { factor: 0.96, tag: "back2back" };
  if (days <= 2.2) return { factor: 0.97, tag: "3in4" };
  if (days >= 3.5) return { factor: 1.02, tag: "rest" };
  return { factor: 1, tag: "normal" };
}
