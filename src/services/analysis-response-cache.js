import { getOddsApiRateLimitState } from "../providers/odds-api-io.js";

const analysisCache = new Map();
export const ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;
export const ANALYSIS_CACHE_STALE_MS = 6 * 60 * 60 * 1000;

export const RATE_LIMIT_UNAVAILABLE_REASON =
  "Odds-API.io limitó las consultas. Mostrando el último snapshot disponible.";

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
    unavailableReason:
      spreadablePayload.unavailableReason ||
      RATE_LIMIT_UNAVAILABLE_REASON,
  };
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

  analysisCache.set(cacheKey, {
    payload: basePayload,
    createdAt: fresh ? now : previousEntry?.createdAt || now,
    expiresAt: fresh ? now + ttlMs : previousEntry?.expiresAt || 0,
    staleUntil: fresh
      ? now + ttlMs + staleMs
      : Math.max(previousEntry?.staleUntil || 0, now + staleMs),
    storedAt: now,
  });
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

/** Devuelve análisis en memoria sin disparar builder (fresh o stale usable). */
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
