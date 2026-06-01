import {
  isFutbolMatchLive,
  isFutbolMatchUpcoming,
  isMlbGameLive,
  isMlbGameUpcoming,
  isTennisMatchLive,
  isTennisMatchUpcoming,
  filterUpcomingMatches,
} from "./event-status.js";
import { diffCalendarDaysInTimezone } from "./madrid-date.js";

export function isSlateScheduleWindow(isoValue, targetDate, { isLive = false, isActive = false } = {}) {
  const diff = diffCalendarDaysInTimezone(isoValue, targetDate);
  if (diff == null) return false;
  if (diff <= -2 || diff >= 2) return false;
  if (diff === -1) return Boolean(isLive);
  if (diff === 0 || diff === 1) return Boolean(isActive);
  return false;
}

export function isTennisInSlateWindow(match, targetDate) {
  if (!match) return false;
  const iso = match.scheduledAt || match.startTime || match.date;
  return isSlateScheduleWindow(iso, targetDate, {
    isLive: isTennisMatchLive(match),
    isActive: isTennisMatchUpcoming(match),
  });
}

export function isMlbInSlateWindow(game, targetDate) {
  if (!game) return false;
  const iso = game.startTime || game.officialDate || game.scheduleDate;
  return isSlateScheduleWindow(iso, targetDate, {
    isLive: isMlbGameLive(game),
    isActive: isMlbGameUpcoming(game),
  });
}

export function isFutbolInSlateWindow(match, targetDate) {
  if (!match) return false;
  const iso = match.scheduledAt || match.startTime || match.date;
  return isSlateScheduleWindow(iso, targetDate, {
    isLive: isFutbolMatchLive(match),
    isActive: isFutbolMatchUpcoming(match),
  });
}

export function isTennisDateInAnalysisWindow(isoValue, targetDate, status = "") {
  return isTennisInSlateWindow({ scheduledAt: isoValue, status }, targetDate);
}

export function isFutbolDateInAnalysisWindow(isoValue, targetDate, status = "") {
  return isFutbolInSlateWindow({ date: isoValue, status }, targetDate);
}

export function isMlbDateInAnalysisWindow(isoValue, targetDate, status = "") {
  return isMlbInSlateWindow({ startTime: isoValue, status }, targetDate);
}

export function isTennisMatchBettable(match, targetDate) {
  if (!match) return false;
  if (!filterUpcomingMatches([match], "tennis").length) return false;
  if (!isTennisInSlateWindow(match, targetDate)) return false;
  return (match.recommendations || []).some(
    (rec) => rec.readyToBet || rec.safeForSingle || rec.safeForComboLeg || rec.verdict === "valid"
  );
}

export function isMlbGameBettable(game, targetDate) {
  if (!game) return false;
  if (!filterUpcomingMatches([game], "mlb").length) return false;
  if (!isMlbInSlateWindow(game, targetDate)) return false;
  return (game.recommendations || []).some(
    (rec) => {
      const odds = Number(rec?.odds);
      const ev = Number(rec?.ev ?? rec?.ev_model);
      return (
        rec.bettable &&
        Number.isFinite(odds) &&
        odds > 1 &&
        Number.isFinite(ev) &&
        rec.discarded !== true &&
        rec.color !== "gris" &&
        (rec.valueModeApplied || rec.valueBettable || rec.proBettable || rec.verdict === "valid" || rec.verdict === "lean")
      );
    }
  );
}

export function isMlbRecommendationGreen(rec) {
  const odds = Number(rec?.odds);
  const ev = Number(rec?.ev ?? rec?.ev_model);
  return Boolean(
    rec?.bettable &&
      Number.isFinite(odds) &&
      odds > 1 &&
      Number.isFinite(ev) &&
      rec?.discarded !== true &&
      rec?.color !== "gris" &&
      (rec?.valueModeApplied || rec?.valueBettable || rec?.proBettable || rec?.verdict === "valid" || rec?.verdict === "lean")
  );
}

export function isFutbolMatchBettable(match, targetDate) {
  if (!match) return false;
  if (!filterUpcomingMatches([match], "futbol").length) return false;
  if (!isFutbolInSlateWindow(match, targetDate)) return false;
  return (match.recommendations || []).some(
    (rec) => rec.readyToBet || rec.bettable || rec.verdict === "valid"
  );
}

export function filterUpcomingDayMatches(matches, sport, targetDate) {
  const list = Array.isArray(matches) ? matches : [];
  if (sport === "mlb") return list.filter((game) => isMlbInSlateWindow(game, targetDate));
  if (sport === "futbol") return list.filter((match) => isFutbolInSlateWindow(match, targetDate));
  return list.filter((match) => isTennisInSlateWindow(match, targetDate));
}

export function filterBettableMatches(matches, sport, targetDate) {
  const list = Array.isArray(matches) ? matches : [];
  if (sport === "mlb") return list.filter((game) => isMlbGameBettable(game, targetDate));
  if (sport === "futbol") return list.filter((match) => isFutbolMatchBettable(match, targetDate));
  return list.filter((match) => isTennisMatchBettable(match, targetDate));
}
