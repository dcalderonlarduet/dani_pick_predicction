import { loadWithCache, peekCacheEntry } from "../providers/shared/resource-cache.js";

let rowsCache = { at: 0, rows: [] };

const ROWS_TTL_MS = 15 * 60 * 1000;
const OFFICIAL_CARD_NAMESPACE = "quiniela-official-card";
const OFFICIAL_CARD_KEY = "en-venta";
const OFFICIAL_CARD_TTL_MS = 15 * 60 * 1000;
const OFFICIAL_CARD_STALE_MS = 2 * 60 * 60 * 1000;

export function cacheOfficialQuinielaRows(rows = []) {
  rowsCache = {
    at: Date.now(),
    rows: Array.isArray(rows) ? rows : [],
  };
}

export function getCachedOfficialQuinielaRows() {
  if (!rowsCache.rows.length) return [];
  if (Date.now() - rowsCache.at > ROWS_TTL_MS) return [];
  return rowsCache.rows;
}

export function peekOfficialQuinielaCardCached() {
  return peekCacheEntry(OFFICIAL_CARD_NAMESPACE, OFFICIAL_CARD_KEY);
}

export function officialCardHasEnVentaComposition(card) {
  return Array.isArray(card?.enVenta?.rows) && card.enVenta.rows.length >= 14;
}

/**
 * Extrae la hora de cierre del plazo del boleto oficial.
 */
export function extractClosingTimeFromCard(card) {
  return (
    card?.enVenta?.closingTime ||
    card?.meta?.closingTime ||
    card?.meta?.saleEnd ||
    card?.meta?.deadlineIso ||
    card?.closingTime ||
    null
  );
}

/**
 * Devuelve si el plazo de la quiniela ya cerró.
 * Si no hay hora de cierre disponible → asumir que está abierto.
 */
export function isQuinielaPlazoCerrado(card) {
  const closingIso = extractClosingTimeFromCard(card);
  if (!closingIso) return false;

  try {
    return new Date(closingIso).getTime() <= Date.now();
  } catch {
    return false;
  }
}

export async function loadOfficialQuinielaCardCached(loader) {
  const peek = peekOfficialQuinielaCardCached();
  if ((peek?.isFresh || peek?.isStaleUsable) && officialCardHasEnVentaComposition(peek.value)) {
    return peek.value;
  }
  return loadWithCache(
    OFFICIAL_CARD_NAMESPACE,
    OFFICIAL_CARD_KEY,
    {
      ttlMs: OFFICIAL_CARD_TTL_MS,
      staleMs: OFFICIAL_CARD_STALE_MS,
    },
    loader
  );
}
