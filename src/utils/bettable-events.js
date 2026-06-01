import {
  isFutbolMatchLive,
  isFutbolMatchUpcoming,
  isMlbGameLive,
  isMlbGameUpcoming,
} from "./event-status.js";
import { diffCalendarDaysInTimezone } from "./madrid-date.js";
import { MIN_RECOMMENDATION_CONFIDENCE, passesRecommendationConfidence, getMinRecommendationConfidence } from "../services/pick-calibration.js";

/** Ventana global: ayer solo en vivo; hoy y mañana activos; sin pasado mañana. */
export function isSlateScheduleWindow(isoValue, targetDate, { isLive = false, isActive = false } = {}) {
  const diff = diffCalendarDaysInTimezone(isoValue, targetDate);
  if (diff == null) return false;
  if (diff <= -2 || diff >= 2) return false;
  if (diff === -1) return Boolean(isLive);
  if (diff === 0 || diff === 1) return Boolean(isActive);
  return false;
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

export function isFutbolDateInAnalysisWindow(isoValue, targetDate, status = "") {
  const stub = { date: isoValue, status };
  return isFutbolInSlateWindow(stub, targetDate);
}

export function isMlbDateInAnalysisWindow(isoValue, targetDate, status = "") {
  const stub = { startTime: isoValue, status };
  return isMlbInSlateWindow(stub, targetDate);
}

export function isProGameInSlateWindow(game, targetDate, sport = "nba") {
  if (!game) return false;
  const iso = game.startTime || game.startIso || game.scheduleDate;
  const status = game?.status || "";
  const live = /in progress|halftime|live|q[1-4]|1st|2nd|3rd|4th/.test(String(status).toLowerCase());
  const active = !/final|completed|postpon|cancel/i.test(String(status));
  return isSlateScheduleWindow(iso, targetDate, { isLive: live, isActive: active });
}

export function isGameOnExactTargetDate(isoValue, targetDate) {
  const diff = diffCalendarDaysInTimezone(isoValue, targetDate);
  return diff === 0;
}

export function isProGameOnTargetDate(game, targetDate) {
  if (!game) return false;
  const iso = game.startTime || game.startIso || game.scheduleDate || game.officialDate;
  return isGameOnExactTargetDate(iso, targetDate);
}

export function isProRecommendationBettable(recommendation, sport = null) {
  if (!recommendation) return false;
  const confidence = Number(recommendation.confidence ?? recommendation.confianza);
  const sportKey = sport || recommendation?.sport || recommendation?.sportId || "";
  const minConf = getMinRecommendationConfidence(sportKey);
  if (!passesRecommendationConfidence(confidence, minConf)) return false;
  return recommendation.bettable && (recommendation.color === "verde" || recommendation.color === "amarillo");
}

export function isProGameBettable(game, targetDate, sport = "nba") {
  if (!game || !isProGameInSlateWindow(game, targetDate, sport)) return false;
  return (game.picks || game.recommendations || []).some(isProRecommendationBettable);
}

export function isMlbRecommendationBettable(recommendation) {
  if (!recommendation) return false;
  if (recommendation.discarded) return false;
  if (recommendation.color === "gris") return false;
  const confidence = Number(recommendation.confidence ?? recommendation.confianza);
  if (!passesRecommendationConfidence(confidence, MIN_RECOMMENDATION_CONFIDENCE)) return false;
  const odds = Number(recommendation.odds);
  const ev = Number(recommendation.ev ?? recommendation.ev_model);
  if (!Number.isFinite(odds) || odds <= 1) return false;
  if (!Number.isFinite(ev)) return false;
  if (
    recommendation.proBettable ||
    recommendation.valueBettable ||
    recommendation.valueModeApplied ||
    recommendation.color === "verde" ||
    recommendation.color === "amarillo"
  ) {
    return Boolean(recommendation.bettable);
  }
  return recommendation.verdict === "valid" && recommendation.bettable && recommendation.confidence >= 70;
}

export function isMlbGameBettable(game, targetDate) {
  if (!game || !isMlbInSlateWindow(game, targetDate)) return false;
  return (game.recommendations || []).some(isMlbRecommendationBettable);
}

export function isFutbolMatchBettable(match, targetDate) {
  if (!match || !isFutbolInSlateWindow(match, targetDate)) return false;
  return (match.recommendations || []).some(
    (rec) => rec.readyToBet || rec.bettable || rec.verdict === "valid"
  );
}

export function filterUpcomingDayMatches(matches, sport, targetDate) {
  const list = Array.isArray(matches) ? matches : [];
  if (sport === "mlb") return list.filter((game) => isMlbInSlateWindow(game, targetDate));
  return list.filter((match) => isFutbolInSlateWindow(match, targetDate));
}

export function filterBettableMatches(matches, sport, targetDate) {
  const list = Array.isArray(matches) ? matches : [];
  if (sport === "mlb") return list.filter((game) => isMlbGameBettable(game, targetDate));
  return list.filter((match) => isFutbolMatchBettable(match, targetDate));
}
