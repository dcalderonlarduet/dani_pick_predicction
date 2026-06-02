import { getOddsApiRateLimitState } from "../providers/odds-api-io.js";
import { getSharedDbPool, hasDatabaseConfig } from "./picks-db.js";

const analysisCache = new Map();
export const ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;
export const ANALYSIS_CACHE_STALE_MS = 6 * 60 * 60 * 1000;

export const RATE_LIMIT_UNAVAILABLE_REASON =
  "Odds-API.io limitÇü las consultas. Mostrando el Ç§ltimo snapshot disponible.";

function getMadridMinuteOfDay() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
}

export function getAnalysisCacheTtlMs() {
  const minute = getMadridMinuteOfDay();
  const nightStart = 3 * 60 + 30;
  const nightEnd = 7 * 60;
  if (minute >= nightStart && minute < nightEnd) return 30 * 60 * 1000;
  return ANALYSIS_CACHE_TTL_MS;
}

export function sanitizeAnalysisPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const normalized = { ...payload };
  delete normalized.rateLimit;
  delete normalized.staleBecauseRateLimit;
  delete normalized.dataStaleUntil;
  if (normalized.unavailableReason === RATE_LIMIT_UNAVAILABLE_REASON) {
    delete normalized.unavailableReason;
  }
  return normalized;
}

function enrichAnalysisWithRateLimit(payload) {
  const rateLimit = getOddsApiRateLimitState();
  const basePayload = sanitizeAnalysisPayload(payload);
  if (!rateLimit) return basePayload;
  const spreadablePayload = basePayload && typeof basePayload === "object" ? basePayload : {};

  return {
    ...spreadablePayload,
    rateLimit,
    staleBecauseRateLimit: true,
    dataStaleUntil: rateLimit.staleUntil || rateLimit.retryAt || null,
    unavailableReason: spreadablePayload.unavailableReason || RATE_LIMIT_UNAVAILABLE_REASON,
  };
}

async function persistSnapshotToDb(cacheKey, entry) {
  if (!hasDatabaseConfig()) return;
  try {
    const pool = getSharedDbPool();
    await pool.query(
      `INSERT INTO analysis_cache_snapshots
         (cache_key, payload, created_at, expires_at, stale_until, stored_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         stale_until = EXCLUDED.stale_until,
         stored_at = EXCLUDED.stored_at`,
      [
        cacheKey,
        JSON.stringify(entry.payload),
        new Date(entry.createdAt),
        new Date(entry.expiresAt),
        new Date(entry.staleUntil),
        new Date(entry.storedAt),
      ]
    );
  } catch (err) {
    console.warn(`[analysis-cache] No se pudo persistir snapshot '${cacheKey}' en BD:`, err.message);
  }
}

export async function loadSnapshotsFromDb() {
  if (!hasDatabaseConfig()) return 0;
  try {
    const pool = getSharedDbPool();
    const now = new Date();
    const { rows } = await pool.query(
      `SELECT cache_key, payload, created_at, expires_at, stale_until, stored_at
       FROM analysis_cache_snapshots
       WHERE stale_until > $1
       ORDER BY stored_at DESC`,
      [now]
    );
    let loaded = 0;
    for (const row of rows) {
      if (analysisCache.has(row.cache_key)) continue;
      analysisCache.set(row.cache_key, {
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        createdAt: new Date(row.created_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
        staleUntil: new Date(row.stale_until).getTime(),
        storedAt: new Date(row.stored_at).getTime(),
      });
      loaded += 1;
    }
    if (loaded > 0) {
      console.log(`[analysis-cache] ${loaded} snapshots restaurados desde BD al arrancar.`);
    }
    return loaded;
  } catch (err) {
    console.warn("[analysis-cache] No se pudo cargar snapshots desde BD:", err.message);
    return 0;
  }
}

export async function pruneExpiredDbSnapshots() {
  if (!hasDatabaseConfig()) return 0;
  try {
    const pool = getSharedDbPool();
    const { rowCount } = await pool.query(
      `DELETE FROM analysis_cache_snapshots WHERE stale_until < NOW()`
    );
    return rowCount || 0;
  } catch (err) {
    console.warn("[analysis-cache] Error al limpiar snapshots expirados:", err.message);
    return 0;
  }
}

function getReusableAnalysisEntry(cacheKey) {
  const entry = analysisCache.get(cacheKey);
  if (!entry) return null;

  if (Number.isFinite(entry.staleUntil) && entry.staleUntil <= Date.now()) {
    analysisCache.delete(cacheKey);
    return null;
  }

  return entry;
}

function isFreshAnalysisEntry(entry, now = Date.now()) {
  return Boolean(entry?.payload) && Number.isFinite(entry?.expiresAt) && entry.expiresAt > now;
}

function isStaleAnalysisEntryUsable(entry, now = Date.now()) {
  return Boolean(entry?.payload) && Number.isFinite(entry?.staleUntil) && entry.staleUntil > now;
}

function storeAnalysisPayload(cacheKey, payload, {
  ttlMs = ANALYSIS_CACHE_TTL_MS,
  staleMs = ANALYSIS_CACHE_STALE_MS,
  fresh = true,
  previousEntry = null,
} = {}) {
  const now = Date.now();
  const basePayload = sanitizeAnalysisPayload(payload);

  const entry = {
    payload: basePayload,
    createdAt: fresh ? now : previousEntry?.createdAt || now,
    expiresAt: fresh ? now + ttlMs : previousEntry?.expiresAt || 0,
    staleUntil: fresh
      ? now + ttlMs + staleMs
      : Math.max(previousEntry?.staleUntil || 0, now + staleMs),
    storedAt: now,
  };
  analysisCache.set(cacheKey, entry);
  persistSnapshotToDb(cacheKey, entry).catch(() => {});
  return basePayload;
}

export async function getCachedAnalysis(cacheKey, builder, {
  ttlMs = ANALYSIS_CACHE_TTL_MS,
  staleMs = ANALYSIS_CACHE_STALE_MS,
  enrichRateLimit = true,
  isUsable = null,
} = {}) {
  const now = Date.now();
  const existing = getReusableAnalysisEntry(cacheKey);
  const payloadUsable = (payload) => (typeof isUsable === "function" ? isUsable(payload) : true);

  if (existing?.payload && !payloadUsable(existing.payload)) {
    analysisCache.delete(cacheKey);
  }

  const reusable = getReusableAnalysisEntry(cacheKey);

  if (isFreshAnalysisEntry(reusable, now) && payloadUsable(reusable.payload)) {
    return enrichRateLimit ? enrichAnalysisWithRateLimit(reusable.payload) : reusable.payload;
  }

  const activeRateLimit = getOddsApiRateLimitState();
  if (activeRateLimit && isStaleAnalysisEntryUsable(reusable, now) && payloadUsable(reusable.payload)) {
    return enrichRateLimit ? enrichAnalysisWithRateLimit(reusable.payload) : reusable.payload;
  }

  try {
    const builtPayload = await builder();
    const rateLimitAfterBuild = getOddsApiRateLimitState();
    const basePayload = storeAnalysisPayload(cacheKey, builtPayload, {
      ttlMs,
      staleMs,
      fresh: !rateLimitAfterBuild,
      previousEntry: reusable,
    });
    return enrichRateLimit ? enrichAnalysisWithRateLimit(basePayload) : basePayload;
  } catch (error) {
    const rateLimit = error?.rateLimit || getOddsApiRateLimitState();

    if (rateLimit && isStaleAnalysisEntryUsable(reusable, now) && payloadUsable(reusable?.payload)) {
      return enrichRateLimit ? enrichAnalysisWithRateLimit(reusable.payload) : reusable.payload;
    }

    if (rateLimit) {
      const unavailable = {
        dataAvailable: false,
        unavailableReason: RATE_LIMIT_UNAVAILABLE_REASON,
      };
      return enrichRateLimit ? enrichAnalysisWithRateLimit(unavailable) : unavailable;
    }

    throw error;
  }
}

export function invalidateAnalysisCache(cacheKey) {
  analysisCache.delete(cacheKey);
}

export function peekCachedAnalysis(cacheKey) {
  const entry = getReusableAnalysisEntry(cacheKey);
  if (!entry?.payload) return null;
  return {
    payload: entry.payload,
    isFresh: isFreshAnalysisEntry(entry),
    isStaleUsable: isStaleAnalysisEntryUsable(entry),
    expiresAt: entry.expiresAt,
    staleUntil: entry.staleUntil,
    storedAt: entry.storedAt,
  };
}

export function getCachedAnalysisIfAvailable(cacheKey, { enrichRateLimit = true, isUsable = null } = {}) {
  const entry = getReusableAnalysisEntry(cacheKey);
  const now = Date.now();
  if (!entry?.payload) return null;
  if (typeof isUsable === "function" && !isUsable(entry.payload)) return null;
  if (!isFreshAnalysisEntry(entry, now) && !isStaleAnalysisEntryUsable(entry, now)) return null;

  const payload = enrichRateLimit ? enrichAnalysisWithRateLimit(entry.payload) : entry.payload;
  return {
    payload,
    isFresh: isFreshAnalysisEntry(entry, now),
    isStaleUsable: isStaleAnalysisEntryUsable(entry, now),
    storedAt: entry.storedAt,
    expiresAt: entry.expiresAt,
    staleUntil: entry.staleUntil,
  };
}
