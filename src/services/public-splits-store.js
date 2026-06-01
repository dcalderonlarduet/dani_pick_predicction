import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getRuntimeConfig } from "../config/runtime.js";
import { resolveMatchRow } from "./match-row-resolver.js";
import {
  SUPPORTED_PUBLIC_SPLIT_SPORTS,
  scrapeAllPublicSplits,
} from "../providers/public-splits.js";

const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let store = {
  loadedAt: 0,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastReason: null,
  source: null,
  bySport: {},
  games: [],
  partialCoverage: false,
};

let refreshPromise = null;
let jobTimer = null;
let staleWarnedAt = 0;

function getSnapshotPath() {
  return getRuntimeConfig().publicSplits?.snapshotFile || null;
}

function isEnabled() {
  return getRuntimeConfig().publicSplits?.enabled !== false;
}

function maxAgeMs() {
  return getRuntimeConfig().publicSplits?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
}

function parseSnapshotTime(value) {
  const ts = value ? Date.parse(value) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

export function isPublicSplitsFresh() {
  const successAt = parseSnapshotTime(store.lastSuccessAt);
  if (!successAt) return false;
  return Date.now() - successAt < maxAgeMs();
}

function marketSlice(game, marketKey) {
  const markets = game?.markets || {};
  if (marketKey === "moneyline") return markets.moneyline || null;
  if (marketKey === "spread" || marketKey === "spreads") return markets.spread || null;
  if (
    marketKey === "game_total" ||
    marketKey === "first_half_total" ||
    marketKey === "totals" ||
    marketKey === "total"
  ) {
    return markets.total || null;
  }
  return markets.moneyline || null;
}

async function loadSnapshotFromDisk() {
  const candidates = [
    getSnapshotPath(),
    getRuntimeConfig().publicSplits?.seedFile,
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.games) || !parsed.games.length) continue;
      const timestamp = parsed.updatedAt || parsed.lastSuccessAt || parsed.timestamp || null;
      store = {
        ...store,
        loadedAt: Date.now(),
        lastSuccessAt: timestamp,
        lastAttemptAt: timestamp,
        lastError: null,
        lastReason: "snapshot_file",
        source: parsed.source || "snapshot_file",
        bySport: parsed.bySport || {},
        games: parsed.games,
      };
      return;
    } catch {
      // try next candidate
    }
  }
}

async function persistSnapshot(payload) {
  const filePath = getSnapshotPath();
  if (!filePath) return;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.warn("[public-splits] No se pudo guardar snapshot:", error?.message || error);
  }
}

function formatAgeLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `hace ${hours} h`;
  return `hace ${hours} h ${rem} min`;
}

export function lookupPublicSplitMatch({
  home,
  away,
  sport,
  marketKey = "moneyline",
  eventId = null,
  scheduleDate = null,
  startTime = null,
}) {
  if (!isPublicSplitsFresh()) {
    if (store.games.length && Date.now() - staleWarnedAt > 60_000) {
      staleWarnedAt = Date.now();
      console.warn("[public-splits] Snapshot stale; usando LM neutral hasta refrescar datos.");
    }
    return null;
  }

  const resolved = resolveMatchRow(store.games, { home, away, sport, eventId, scheduleDate, startTime });
  const best = resolved?.row || null;
  if (!best) return null;

  const market = marketSlice(best, marketKey) || best.markets?.moneyline || null;
  if (!market) return null;

  if (marketKey === "game_total" || marketKey === "first_half_total" || marketKey === "totals") {
    const overTickets = Number(market.pct_tickets_over);
    const overMoney = Number(market.pct_money_over);
    if (!Number.isFinite(overTickets) && !Number.isFinite(overMoney)) return null;
    return {
      pct_tickets_home: Number.isFinite(overTickets) ? overTickets : 50,
      pct_tickets_away: Number.isFinite(overTickets) ? 100 - overTickets : 50,
      pct_money_home: Number.isFinite(overMoney) ? overMoney : 50,
      pct_money_away: Number.isFinite(overMoney) ? 100 - overMoney : 50,
      source: best.source || store.source || "public-splits",
      marketKey,
    };
  }

  const ticketsHome = Number(market.pct_tickets_home);
  const moneyHome = Number(market.pct_money_home);
  if (!Number.isFinite(ticketsHome) && !Number.isFinite(moneyHome)) return null;

  return {
    pct_tickets_home: Number.isFinite(ticketsHome) ? ticketsHome : 50,
    pct_tickets_away: Number.isFinite(Number(market.pct_tickets_away))
      ? Number(market.pct_tickets_away)
      : Number.isFinite(ticketsHome)
        ? 100 - ticketsHome
        : 50,
    pct_money_home: Number.isFinite(moneyHome) ? moneyHome : 50,
    pct_money_away: Number.isFinite(Number(market.pct_money_away))
      ? Number(market.pct_money_away)
      : Number.isFinite(moneyHome)
        ? 100 - moneyHome
        : 50,
    source: best.source || store.source || "public-splits",
    marketKey,
  };
}

export function getPublicSplitsStatus() {
  const now = Date.now();
  const successAt = store.lastSuccessAt ? Date.parse(store.lastSuccessAt) : null;
  const ageMs = successAt ? now - successAt : null;
  const hasData = store.games.length > 0;
  const isStale = hasData && successAt && ageMs >= maxAgeMs();
  const lastAttemptFailed = store.lastAttemptAt && store.lastError;

  let state = "error";
  let message = "No hay datos de % tickets / % handle disponibles.";

  if (hasData && successAt) {
    if (isStale) {
      state = "warning";
      message = `Splits publicos stale (${formatAgeLabel(ageMs)}). LM usa NEUTRO hasta refrescar datos.`;
    } else if (lastAttemptFailed) {
      state = "warning";
      message = `No es posible actualizar los % tickets/handle (${store.lastError}). Se usan datos ${formatAgeLabel(ageMs)} (${store.source || "cache"}).`;
    } else if (store.partialCoverage) {
      state = "warning";
      message = `Splits leídos ${formatAgeLabel(ageMs)} (${store.source || "DraftKings"}) · cobertura parcial en algunos deportes.`;
    } else {
      state = "ok";
      message = `Splits públicos leídos correctamente ${formatAgeLabel(ageMs)} (${store.source || "DraftKings"} · ${store.games.length} partidos).`;
    }
  } else if (hasData) {
    state = "warning";
    message = `Datos de tickets en caché (${store.games.length} partidos) sin marca temporal de actualización.`;
  } else if (lastAttemptFailed) {
    state = "warning";
    message = `No es posible actualizar los % tickets/handle: ${store.lastError}.`;
  }

  return {
    enabled: isEnabled(),
    state,
    message,
    lastSuccessAt: store.lastSuccessAt,
    lastAttemptAt: store.lastAttemptAt,
    ageMs,
    ageLabel: formatAgeLabel(ageMs),
    source: store.source,
    games: store.games.length,
    sports: store.bySport,
    supportedSports: SUPPORTED_PUBLIC_SPLIT_SPORTS,
    usingStaleData: Boolean(hasData && (lastAttemptFailed || isStale)),
    splitsStale: Boolean(isStale),
    maxAgeMs: maxAgeMs(),
    lastError: store.lastError,
    lastReason: store.lastReason,
  };
}

export async function refreshPublicSplits({ reason = "manual" } = {}) {
  if (!isEnabled()) {
    return getPublicSplitsStatus();
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    store.lastAttemptAt = new Date().toISOString();
    const previousGames = store.games;
    const previousSuccessAt = store.lastSuccessAt;
    try {
      const result = await scrapeAllPublicSplits();
      if (!result.ok || !result.games.length) {
        const detail = Object.entries(result.bySport || {})
          .map(([sport, row]) => `${sport}:${row.ok ? "ok" : row.reason}`)
          .join(", ");
        if (previousGames.length) {
          store.lastError = `parse_failed:${detail || "no_games"}`;
          store.lastReason = reason;
          return getPublicSplitsStatus();
        }
        throw new Error(`parse_failed:${detail || "no_games"}`);
      }

      const updatedAt = new Date().toISOString();
      store = {
        loadedAt: Date.now(),
        lastSuccessAt: updatedAt,
        lastAttemptAt: updatedAt,
        lastError: null,
        lastReason: reason,
        source: result.source || "draftkings",
        bySport: result.bySport || {},
        games: result.games,
        partialCoverage: Boolean(result.partial),
      };

      await persistSnapshot({
        updatedAt,
        source: store.source,
        bySport: store.bySport,
        games: store.games,
      });

      console.log(
        `[public-splits] Actualizado (${reason}): ${store.games.length} partidos · fuente ${store.source}${result.partial ? " · parcial" : ""}`
      );
      return getPublicSplitsStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.lastError = message;
      store.lastReason = reason;
      if (previousGames.length) {
        store.games = previousGames;
        store.lastSuccessAt = previousSuccessAt;
      }
      console.warn(`[public-splits] Falló actualización (${reason}):`, message);
      return getPublicSplitsStatus();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function startPublicSplitsJob(options = {}) {
  if (!isEnabled()) return;
  const intervalMs = options.intervalMs ?? getRuntimeConfig().publicSplits?.intervalMs ?? DEFAULT_INTERVAL_MS;

  if (jobTimer) clearInterval(jobTimer);

  loadSnapshotFromDisk()
    .then(() => refreshPublicSplits({ reason: "boot" }))
    .catch((error) => console.warn("[public-splits] boot:", error?.message));

  jobTimer = setInterval(() => {
    refreshPublicSplits({ reason: "interval" }).catch((error) => {
      console.warn("[public-splits] interval:", error?.message);
    });
  }, intervalMs);
}

export async function initPublicSplitsStore() {
  await loadSnapshotFromDisk();
}
