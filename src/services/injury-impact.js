/**
 * Impacto real de lesiones vía ESPN (minutes × usage × on/off).
 * NBA / WNBA / NFL (+ fallback MLB/fútbol).
 */

import { fetchEspnJson } from "../providers/shared/espn-pro.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";

export const LEAGUE_AVG_IMPACT = { nba: 18, wnba: 22, nfl: 14, mlb: 12, football: 10 };
export const IMPACT_CAP = { nba: 10, wnba: 12, nfl: 8, mlb: 6, football: 5 };

const TEAM_MINUTES = { nba: 240, wnba: 200, nfl: 60 };

const NFL_POSITION_WEIGHT = {
  QB: 1,
  WR: 0.55,
  RB: 0.5,
  TE: 0.35,
};

function normalizeUsage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
}

function statFromList(stats, keys) {
  if (!Array.isArray(stats)) return null;
  for (const row of stats) {
    const label = String(row?.name || row?.label || row?.abbreviation || "").toLowerCase();
    if (keys.some((key) => label.includes(key))) {
      const value = Number(row?.value ?? row?.displayValue);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function extractAthleteStats(athlete) {
  const categories =
    athlete?.statistics?.splits?.categories ||
    athlete?.stats?.splits?.categories ||
    athlete?.statistics?.categories ||
    [];
  let mpg = null;
  let usage = null;
  let onOff = null;

  for (const category of categories) {
    const stats = category?.stats || [];
    mpg = mpg ?? statFromList(stats, ["minutespergame", "avgminutes", "minutes"]);
    usage = usage ?? statFromList(stats, ["usagerate", "usage"]);
    onOff =
      onOff ??
      statFromList(stats, ["onoffnetrating", "on-off net", "net rating on-off", "onoff"]);
  }

  return { minutesPerGame: mpg, usageRate: usage, onOffNetRating: onOff };
}

export async function fetchEspnTeamRoster(rosterUrlTemplate, teamId) {
  if (!teamId || !rosterUrlTemplate) return [];
  const url = rosterUrlTemplate.replace("{id}", encodeURIComponent(teamId));
  try {
    const payload = await fetchEspnJson(url, `espn-roster|${url}`);
    const athletes = payload?.athletes || payload?.team?.athletes || [];
    return Array.isArray(athletes) ? athletes : [];
  } catch {
    return [];
  }
}

export function parseTeamInjuries(summary, teamId) {
  const items = [];
  const groups = [...(summary?.injuries || []), ...(summary?.pickcenter?.injuries || [])];
  for (const group of groups) {
    const groupTeamId = String(group?.team?.id || group?.teamId || "");
    const athletes = group?.injuries || group?.athletes || [];
    for (const athlete of athletes) {
      const status = String(athlete?.status || athlete?.type || "").toLowerCase();
      if (!/out|doubtful|injur|suspend/.test(status)) continue;
      const athleteTeamId = String(
        athlete?.team?.id || athlete?.athlete?.team?.id || groupTeamId || ""
      );
      if (teamId && athleteTeamId && athleteTeamId !== String(teamId)) continue;
      items.push({
        name: athlete?.athlete?.displayName || athlete?.displayName || "Unknown",
        status,
        position:
          athlete?.athlete?.position?.abbreviation ||
          athlete?.position?.abbreviation ||
          athlete?.position ||
          "",
        teamId: athleteTeamId || groupTeamId,
      });
    }
  }
  return items.filter((row) => /out/.test(row.status));
}

function nameMatchScore(injuryName, rosterName) {
  const a = canonicalName(injuryName);
  const b = canonicalName(rosterName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aParts = a.split(" ").filter(Boolean);
  const bParts = b.split(" ").filter(Boolean);
  if (aParts[aParts.length - 1] === bParts[bParts.length - 1]) return 0.85;
  let shared = 0;
  for (const token of aParts) {
    if (bParts.includes(token)) shared += 1;
  }
  return shared / Math.max(aParts.length, bParts.length);
}

function findRosterAthlete(injuryName, roster) {
  let best = null;
  let bestScore = 0;
  for (const athlete of roster) {
    const fullName =
      athlete?.fullName ||
      athlete?.displayName ||
      athlete?.athlete?.displayName ||
      [athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ");
    const score = nameMatchScore(injuryName, fullName);
    if (score > bestScore) {
      bestScore = score;
      best = athlete;
    }
  }
  return bestScore >= 0.55 ? best : null;
}

export function computePlayerImpactPts({ sport, minutesPerGame, usageRate, onOffNetRating }) {
  const teamMinutes = TEAM_MINUTES[sport] || 240;
  const mpg = Number(minutesPerGame);
  const usage = normalizeUsage(usageRate);
  const minutesShare = Number.isFinite(mpg) && mpg > 0 ? Math.min(0.45, mpg / teamMinutes) : 0.22;
  const usageNorm = usage ?? 0.22;
  const onOff = Number(onOffNetRating);

  if (Number.isFinite(onOff) && onOff !== 0) {
    return Math.max(0, minutesShare * usageNorm * Math.abs(onOff));
  }
  return Math.max(0, minutesShare * usageNorm * (LEAGUE_AVG_IMPACT[sport] || 18));
}

function nflPositionImpact(position) {
  const pos = String(position || "").toUpperCase();
  const key = Object.keys(NFL_POSITION_WEIGHT).find((k) => pos.includes(k)) || "WR";
  return (LEAGUE_AVG_IMPACT.nfl * (NFL_POSITION_WEIGHT[key] || 0.25)) / 2;
}

function computeNflPlayerImpact(injury, roster) {
  const athlete = findRosterAthlete(injury.name, roster);
  const position =
    injury.position ||
    athlete?.position?.abbreviation ||
    athlete?.athlete?.position?.abbreviation ||
    "";
  const pos = String(position).toUpperCase();
  if (!/QB|WR|RB|TE/.test(pos) && !/quarterback|receiver|running back|tight end/i.test(injury.name)) {
    return { impactPts: 0, skipped: true };
  }
  const stats = athlete ? extractAthleteStats(athlete) : {};
  let impact = computePlayerImpactPts({
    sport: "nfl",
    minutesPerGame: stats.minutesPerGame ?? (pos.includes("QB") ? 60 : 35),
    usageRate: stats.usageRate ?? (pos.includes("QB") ? 0.35 : 0.22),
    onOffNetRating: stats.onOffNetRating,
  });
  if (impact <= 0) impact = nflPositionImpact(pos);
  return { impactPts: impact, position: pos, source: athlete ? "roster" : "position_fallback" };
}

export async function computeTeamInjuryImpact({ sport, teamId, rosterUrlTemplate, summary }) {
  const cap = IMPACT_CAP[sport] ?? 10;
  const outInjuries = parseTeamInjuries(summary, teamId);
  if (!outInjuries.length) {
    return { injuryPenalty: 0, injuryDetails: [], qb_factor: 1 };
  }

  const roster = await fetchEspnTeamRoster(rosterUrlTemplate, teamId);
  const details = [];
  let total = 0;
  let qbFactor = 1;

  for (const injury of outInjuries) {
    let impactPts = 0;
    let meta = {};

    if (sport === "nfl") {
      const nfl = computeNflPlayerImpact(injury, roster);
      if (nfl.skipped) continue;
      impactPts = nfl.impactPts;
      meta = nfl;
      if (String(nfl.position).includes("QB")) {
        qbFactor = Math.min(qbFactor, Math.max(0.55, 1 - impactPts / IMPACT_CAP.nfl));
      }
    } else {
      const athlete = findRosterAthlete(injury.name, roster);
      const stats = athlete ? extractAthleteStats(athlete) : {};
      const starterFallbackMpg = sport === "wnba" ? 30 : 32;
      impactPts = computePlayerImpactPts({
        sport,
        minutesPerGame: stats.minutesPerGame ?? starterFallbackMpg,
        usageRate: stats.usageRate ?? (sport === "wnba" ? 0.26 : 0.24),
        onOffNetRating: stats.onOffNetRating,
      });
      meta = {
        source: athlete ? "espn-roster" : "starter_fallback",
        minutesPerGame: stats.minutesPerGame ?? starterFallbackMpg,
        usageRate: stats.usageRate,
        onOffNetRating: stats.onOffNetRating,
      };
    }

    total += impactPts;
    details.push({ name: injury.name, impactPts: round2(impactPts), ...meta });
  }

  return {
    injuryPenalty: round2(Math.min(cap, total)),
    injuryDetails: details,
    qb_factor: sport === "nfl" ? round3(qbFactor) : 1,
  };
}

export function computeMlbPitcherInjuryImpact({ starterStatus, pitcherName }) {
  const status = String(starterStatus || "").toLowerCase();
  if (!/out|scratch|injur|doubt|il|disabled/.test(status)) {
    return { injuryPenalty: 0, injuryDetails: [] };
  }
  const impact = Math.min(IMPACT_CAP.mlb, LEAGUE_AVG_IMPACT.mlb * 0.45);
  return {
    injuryPenalty: round2(impact),
    injuryDetails: [{ name: pitcherName || "SP", impactPts: impact, source: "pitcher_status" }],
  };
}

export function computeFootballInjuryImpact({ injuries = [] }) {
  const outs = injuries.filter((row) => /out|injur|suspend/.test(String(row?.status || "").toLowerCase()));
  if (!outs.length) return { injuryPenalty: 0, injuryDetails: [] };
  const perPlayer = Math.min(1.2, (LEAGUE_AVG_IMPACT.football || 10) / 8);
  const total = Math.min(IMPACT_CAP.football, outs.length * perPlayer);
  return {
    injuryPenalty: round2(total),
    injuryDetails: outs.map((row) => ({
      name: row.name || row.player || "Unknown",
      impactPts: round2(perPlayer),
      source: "football_heuristic",
    })),
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}
