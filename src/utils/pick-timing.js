import { getMadridTodayDateString } from "./madrid-date.js";
import { getPickDateKey } from "./pick-identity.js";

export function normalizeHourLabel(value) {
  const text = String(value || "")
    .trim()
    .replace(/\s*Madrid\s*/gi, "")
    .replace(/\s+/g, " ");
  const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function resolvePickStartIso(pick) {
  const candidates = [
    pick?.scheduledAt,
    pick?.startIso,
    pick?.schedule?.iso,
    pick?.date,
    pick?.hora,
    pick?.raw?.scheduledAt,
    pick?.raw?.startIso,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

export function formatHourFromIso(isoValue) {
  if (!isoValue) return null;
  try {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(isoValue));
  } catch {
    return null;
  }
}

export function resolvePickHourLabel(pick) {
  for (const field of [
    pick?.hora_partido,
    pick?.hora,
    pick?.schedule?.timeLabel,
    pick?.fallbackTime,
  ]) {
    const normalized = normalizeHourLabel(field);
    if (normalized) return normalized;
  }
  return formatHourFromIso(resolvePickStartIso(pick));
}

export function normalizeMatchStatus(status) {
  const value = String(status || "").toLowerCase();
  return {
    isLive:
      value.includes("live") ||
      value.includes("inplay") ||
      value.includes("in-play") ||
      value.includes("in progress") ||
      value.includes("in_progress") ||
      value.includes("playing") ||
      value.includes("ongoing") ||
      value.includes("running"),
    isFinal:
      value.includes("final") ||
      value.includes("finished") ||
      value.includes("ended") ||
      value.includes("complete") ||
      value.includes("completed"),
  };
}

export function isPickExplicitlyLive(pick) {
  if (pick?.live === true) return true;
  const status = normalizeMatchStatus(
    pick?.status || pick?.matchStatus || pick?.gameStatus || pick?.statusInfo?.raw
  );
  return status.isLive;
}

function getMadridTimeString(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

/**
 * Solo notificar picks en vivo, próximos a jugar o recién creados (sin hora/fecha pasada).
 */
export function isPickEligibleForTelegram(pick, now = new Date()) {
  const resultado = String(pick?.resultado || "pendiente").toLowerCase();
  if (resultado && resultado !== "pendiente") return false;

  const status = normalizeMatchStatus(
    pick?.status || pick?.matchStatus || pick?.gameStatus || pick?.statusInfo?.raw
  );
  if (status.isFinal) return false;

  if (isPickExplicitlyLive(pick)) return true;

  const startIso = resolvePickStartIso(pick);
  if (startIso) {
    const startMs = new Date(startIso).getTime();
    if (Number.isFinite(startMs) && startMs > now.getTime()) return true;
    const PICK_GRACE_PERIOD_MS = 30 * 60 * 1000;
    if (Number.isFinite(startMs) && startMs <= now.getTime() - PICK_GRACE_PERIOD_MS) {
      return false;
    }
    if (Number.isFinite(startMs)) return true;
  }

  const pickDate = getPickDateKey(pick);
  const hora = resolvePickHourLabel(pick);
  const todayMadrid = getMadridTodayDateString(now);
  const currentTime = getMadridTimeString(now);

  if (pickDate && pickDate < todayMadrid) return false;
  if (pickDate && pickDate > todayMadrid) return true;

  if (pickDate === todayMadrid) {
    if (!hora) return true;
    return hora > currentTime;
  }

  return true;
}

function dateKeyToUtcStamp(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function diffMadridDaysFromDateKey(dateKey, now = new Date()) {
  const todayKey = getMadridTodayDateString(now);
  const targetStamp = dateKeyToUtcStamp(dateKey);
  const todayStamp = dateKeyToUtcStamp(todayKey);
  if (targetStamp == null || todayStamp == null) return null;
  return Math.round((targetStamp - todayStamp) / 86400000);
}

function diffMadridDaysFromInstant(dateLike, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(dateLike));
    const year = parts.find((part) => part.type === "year")?.value || "";
    const month = parts.find((part) => part.type === "month")?.value || "";
    const day = parts.find((part) => part.type === "day")?.value || "";
    const targetKey = year && month && day ? `${year}-${month}-${day}` : "";
    return targetKey ? diffMadridDaysFromDateKey(targetKey, now) : null;
  } catch {
    return null;
  }
}

function fmtShortMadridDate(dateLike) {
  try {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      weekday: "short",
      day: "2-digit",
      month: "short",
    })
      .format(new Date(dateLike))
      .replace(/\./g, "")
      .toUpperCase();
  } catch {
    return "";
  }
}

export function resolvePickScheduleAnchor(pick) {
  const startIso = resolvePickStartIso(pick);
  if (startIso) return startIso;

  const pickDate = getPickDateKey(pick);
  if (!pickDate) return null;

  const hora = resolvePickHourLabel(pick);
  if (hora) return `${pickDate}T${hora}:00`;

  const [year, month, day] = pickDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
}

export function buildRelativeScheduleTag(dateLike, now = new Date()) {
  if (!dateLike) return "";

  const compactDate = fmtShortMadridDate(dateLike);
  if (!compactDate) return "";

  const diff = diffMadridDaysFromInstant(dateLike, now);
  switch (diff) {
    case -1:
      return `AYER EN VIVO · ${compactDate}`;
    case 0:
      return `HOY · ${compactDate}`;
    case 1:
      return `MAÑANA · ${compactDate}`;
    default:
      return compactDate;
  }
}

export function buildRelativeScheduleTagForPick(pick, now = new Date()) {
  const anchor = resolvePickScheduleAnchor(pick);
  if (!anchor) return "";
  return buildRelativeScheduleTag(anchor, now);
}

export function buildPickScheduleStatusLabel(pick, now = new Date()) {
  const dateTag = buildRelativeScheduleTagForPick(pick, now);
  const hora = resolvePickHourLabel(pick);

  if (isPickExplicitlyLive(pick)) {
    return [dateTag ? `🔴 EN VIVO · ${dateTag}` : "🔴 EN VIVO", hora ? `🕒 ${hora}` : null]
      .filter(Boolean)
      .join(" · ");
  }

  const parts = [];
  if (dateTag) parts.push(dateTag);
  if (hora) parts.push(`🕒 ${hora}`);
  if (!parts.length) parts.push("🕒 Hora por confirmar");
  return parts.join(" · ");
}
