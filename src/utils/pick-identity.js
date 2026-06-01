import { getMadridTodayDateString } from "./madrid-date.js";

function normalizeField(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatchKey(value) {
  return normalizeField(value).replace(/@/g, "vs");
}

function normalizeMarketKey(value) {
  const text = normalizeField(value);
  if (/ganador|moneyline|\bml\b/.test(text)) return "ml";
  if (/total|goles|carreras|juegos|over|under/.test(text)) return "totals";
  if (/handicap|spread|runline|run line/.test(text)) return "spread";
  if (/corner/.test(text)) return "corners";
  if (/booking|tarjeta|card/.test(text)) return "bookings";
  if (/double chance|doble oportunidad/.test(text)) return "doublechance";
  return text;
}

function extractLineToken(pick) {
  const raw = pick?.raw || {};
  const direct = raw?.linea ?? raw?.line ?? raw?.totalsLine ?? null;
  if (direct != null && String(direct).trim()) {
    return String(direct).trim().replace(",", ".");
  }
  const text = `${pick?.pick_label || pick?.pick || ""} ${pick?.mercado || ""}`;
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  return match ? match[1].replace(",", ".") : "";
}

function normalizeIsoDateFragment(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "");
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function formatMadridDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getPickDateKey(pick) {
  for (const field of [pick?.pick_date, pick?.fecha, pick?.date, pick?.matchDate]) {
    const iso = normalizeIsoDateFragment(field);
    if (iso) return iso;
  }

  const rawDate = String(pick?.pick_date || pick?.fecha || "").trim();
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      return formatMadridDateKey(parsed);
    }
  }

  const iso = pick?.scheduledAt || pick?.startIso;
  if (iso) {
    try {
      return formatMadridDateKey(new Date(iso));
    } catch {
      return getMadridTodayDateString();
    }
  }
  return getMadridTodayDateString();
}

export function buildPickIdentityKey(pick) {
  const sport = normalizeField(pick?.sport || pick?.sportId);
  const match = normalizeMatchKey(pick?.partido);
  const label = normalizeField(pick?.pick_label || pick?.pick || pick?.selection || pick?.seleccion || pick?.label);
  const market = normalizeMarketKey(pick?.mercado || pick?.market || pick?.type || pick?.category);
  const line = extractLineToken(pick);
  return `${sport}|${match}|${label}|${market}|${line}`;
}
