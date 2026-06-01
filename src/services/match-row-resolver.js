import { canonicalName } from "../providers/shared/tennis-normalizers.js";

export function rowHomeName(row) {
  return row?.home || row?.home_team || row?.homeName || "";
}

export function rowAwayName(row) {
  return row?.away || row?.away_team || row?.awayName || "";
}

export function rowEventId(row) {
  const id = row?.eventId ?? row?.event_id ?? row?.id;
  if (id == null || id === "") return null;
  return String(id);
}

export function scheduleDateFromRow(row) {
  const iso = row?.commenceTime || row?.startIso || row?.scheduleDate || row?.date;
  if (iso) {
    const text = String(iso);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  }
  const startTime = String(row?.startTime || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(startTime)) return startTime.slice(0, 10);
  return "";
}

export function exactTeamPairMatch(row, home, away) {
  return (
    canonicalName(rowHomeName(row)) === canonicalName(home) &&
    canonicalName(rowAwayName(row)) === canonicalName(away)
  );
}

function tokenOverlapScore(left, right) {
  const a = canonicalName(left);
  const b = canonicalName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at = new Set(a.split(" ").filter(Boolean));
  const bt = new Set(b.split(" ").filter(Boolean));
  if (!at.size || !bt.size) return 0;
  let shared = 0;
  for (const token of at) {
    if (bt.has(token)) shared += 1;
  }
  return shared / Math.max(at.size, bt.size);
}

function fuzzyPairScore(row, home, away) {
  return (tokenOverlapScore(home, rowHomeName(row)) + tokenOverlapScore(away, rowAwayName(row))) / 2;
}

export function matchesScheduleRow(row, scheduleDate, startTime) {
  const target = String(scheduleDate || startTime || "").slice(0, 10);
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return true;
  const rowDate = scheduleDateFromRow(row);
  return !rowDate || rowDate === target;
}

/**
 * Resuelve una fila de snapshot/splits sin mezclar partidos del mismo par.
 * Prioridad: eventId → par exacto + fecha → par exacto único → fuzzy solo si hay un candidato.
 */
export function resolveMatchRow(rows, options = {}) {
  const {
    home,
    away,
    sport = null,
    eventId = null,
    scheduleDate = null,
    startTime = null,
    minFuzzyScore = 0.55,
  } = options;

  const sportKey = String(sport || "").toLowerCase();
  const list = Array.isArray(rows) ? rows : [];
  const sportFiltered = list.filter((row) => {
    if (!sportKey) return true;
    const rowSport = String(row?.sport || "").toLowerCase();
    return !rowSport || rowSport === sportKey;
  });

  if (eventId != null && eventId !== "") {
    const idStr = String(eventId);
    const byId = sportFiltered.find((row) => rowEventId(row) === idStr);
    if (byId) return { row: byId, matchType: "eventId" };
  }

  const targetDate = String(scheduleDate || startTime || "").slice(0, 10);
  const hasTargetDate = /^\d{4}-\d{2}-\d{2}$/.test(targetDate);
  const exactCandidates = sportFiltered.filter((row) => exactTeamPairMatch(row, home, away));

  if (hasTargetDate) {
    const dated = exactCandidates.filter((row) => matchesScheduleRow(row, scheduleDate, startTime));
    if (dated.length === 1) return { row: dated[0], matchType: "exact+date" };
    if (dated.length > 1) return null;
    if (exactCandidates.length > 0) return null;
  }

  if (exactCandidates.length === 1) {
    return { row: exactCandidates[0], matchType: "exact" };
  }

  if (exactCandidates.length > 1) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  let tieCount = 0;

  for (const row of sportFiltered) {
    if (hasTargetDate && !matchesScheduleRow(row, scheduleDate, startTime)) continue;
    const score = fuzzyPairScore(row, home, away);
    if (score >= minFuzzyScore) {
      if (score > bestScore + 0.001) {
        bestScore = score;
        best = row;
        tieCount = 1;
      } else if (Math.abs(score - bestScore) <= 0.001) {
        tieCount += 1;
      }
    }
  }

  if (best && tieCount === 1) {
    return { row: best, matchType: "fuzzy", score: bestScore };
  }

  return null;
}
