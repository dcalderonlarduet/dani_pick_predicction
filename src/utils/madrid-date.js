const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getAppTimezone() {
  return process.env.APP_TIMEZONE || process.env.TENNIS_TIMEZONE || "Europe/Madrid";
}

export function getDateStringInTimezone(date = new Date(), timeZone = getAppTimezone()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

export function getMadridTodayDateString(now = new Date()) {
  return getDateStringInTimezone(now, getAppTimezone());
}

export function getMadridYesterdayDateString(now = new Date()) {
  return shiftDateString(getMadridTodayDateString(now), -1);
}

export function shiftDateString(dateStr, days = 0) {
  if (!DATE_RE.test(String(dateStr || ""))) {
    return getMadridTodayDateString();
  }
  const [year, month, day] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function resolveAnalysisDate(queryDate) {
  if (queryDate && DATE_RE.test(queryDate)) {
    return queryDate;
  }
  return getMadridTodayDateString();
}

export function isSameCalendarDayInTimezone(isoValue, targetDate, timeZone = getAppTimezone()) {
  if (!targetDate) return true;
  if (!isoValue) return false;

  const instant = new Date(isoValue);
  if (Number.isNaN(instant.getTime())) return false;

  return getDateStringInTimezone(instant, timeZone) === targetDate;
}

export function diffCalendarDaysInTimezone(isoValue, targetDate, timeZone = getAppTimezone()) {
  if (!isoValue || !DATE_RE.test(String(targetDate || ""))) return null;

  const instant = new Date(isoValue);
  if (Number.isNaN(instant.getTime())) return null;

  const eventDate = getDateStringInTimezone(instant, timeZone);
  if (!DATE_RE.test(String(eventDate || ""))) return null;

  const [targetYear, targetMonth, targetDay] = targetDate.split("-").map(Number);
  const [eventYear, eventMonth, eventDay] = eventDate.split("-").map(Number);
  const targetStamp = Date.UTC(targetYear, targetMonth - 1, targetDay);
  const eventStamp = Date.UTC(eventYear, eventMonth - 1, eventDay);
  return Math.round((eventStamp - targetStamp) / 86400000);
}

export function isDateWithinCalendarWindow(
  isoValue,
  targetDate,
  { pastDays = 0, futureDays = 0, timeZone = getAppTimezone() } = {}
) {
  const diff = diffCalendarDaysInTimezone(isoValue, targetDate, timeZone);
  if (diff == null) return false;
  return diff >= -Math.max(0, pastDays) && diff <= Math.max(0, futureDays);
}

export function isMatchInAnalysisWindow(isoValue, targetDate, timeZone = getAppTimezone()) {
  return isDateWithinCalendarWindow(isoValue, targetDate, {
    pastDays: 1,
    futureDays: 0,
    timeZone,
  });
}

