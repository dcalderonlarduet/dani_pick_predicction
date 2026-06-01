function parseRetryAfterSeconds(value) {
  if (value == null || value === "") return null;
  const trimmed = String(value).trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber);

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, Math.ceil((parsedDate - Date.now()) / 1000));
  }

  return null;
}

function parseRetryWindowFromMessage(message) {
  const value = String(message || "").toLowerCase();
  if (!value) return null;

  let total = 0;
  const hourMatch = value.match(/(\d+)\s*hour/);
  const minuteMatch = value.match(/(\d+)\s*minute/);
  const secondMatch = value.match(/(\d+)\s*second/);
  if (hourMatch) total += Number(hourMatch[1]) * 3600;
  if (minuteMatch) total += Number(minuteMatch[1]) * 60;
  if (secondMatch) total += Number(secondMatch[1]);
  if (total > 0) return total;

  const retryAfter = value.match(/retry-?after[:\s]+(\d+)/);
  if (retryAfter) return Number(retryAfter[1]);

  return null;
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

export function isRateLimitMessage(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("exceeded your rate limit") ||
    normalized.includes("429")
  );
}

export function buildRateLimitInfo({
  message = "",
  status = null,
  headers = {},
  retryAfterHeader = "",
  resetHeader = "",
} = {}) {
  const headerMap = normalizeHeaders(headers);
  const retryAfter =
    retryAfterHeader ||
    headerMap["retry-after"] ||
    headerMap["x-ratelimit-retry-after"] ||
    "";
  const resetAt =
    resetHeader ||
    headerMap["x-ratelimit-reset"] ||
    headerMap["x-rate-limit-reset"] ||
    "";

  const fromRetryAfter = parseRetryAfterSeconds(retryAfter);
  const fromReset = parseRetryAfterSeconds(resetAt);
  const fromMessage = parseRetryWindowFromMessage(message);
  const seconds =
    fromRetryAfter != null
      ? fromRetryAfter
      : fromReset != null
        ? fromReset
        : fromMessage != null
          ? fromMessage
          : status === 429
            ? 60
            : null;

  const looksLimited = status === 429 || isRateLimitMessage(message);
  if (!looksLimited) return null;

  const retryAt = seconds != null ? Date.now() + Math.max(0, seconds) * 1000 : null;

  return {
    code: status === 429 ? "RATE_LIMIT_EXCEEDED" : "RATE_LIMIT",
    status: status || 429,
    message: String(message || "Rate limit exceeded. Please try again later.").slice(0, 280),
    seconds: seconds != null ? Math.max(0, Math.round(seconds)) : null,
    retryAt,
    staleUntil: retryAt,
    provider: "odds-api-io",
  };
}

export function extractRateLimitFromError(error) {
  if (!error) return null;

  if (error.rateLimit) return error.rateLimit;

  const status = Number(error.status || error.statusCode || 0) || null;
  const message = String(error.message || error.body || "");
  const bodyMessage =
    typeof error.body === "string"
      ? error.body
      : typeof error.body?.error === "string"
        ? error.body.error
        : message;

  return buildRateLimitInfo({
    message: bodyMessage || message,
    status,
    headers: error.headers || {},
  });
}
