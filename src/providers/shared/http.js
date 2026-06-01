import { buildRateLimitInfo } from "../../utils/api-rate-limit.js";

export class HttpRequestError extends Error {
  constructor(message, { status = null, body = "", headers = {}, provider = "http", rateLimit = null } = {}) {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.provider = provider;
    this.rateLimit = rateLimit;
  }
}

function normalizeHeaderMap(headers) {
  const normalized = {};
  if (!headers || typeof headers !== "object") return normalized;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      normalized[String(key).toLowerCase()] = value;
    });
    return normalized;
  }
  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

export async function fetchJson(url, { headers = {}, timeoutMs = 15000, provider = "http" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal: controller.signal,
    });

    const text = await response.text();
    const responseHeaders = normalizeHeaderMap(response.headers);

    if (!response.ok) {
      let parsedBody = text;
      try {
        parsedBody = text ? JSON.parse(text) : "";
      } catch {
        parsedBody = text;
      }

      const errorMessage =
        typeof parsedBody === "object" && parsedBody?.error
          ? String(parsedBody.error)
          : `${provider} ${response.status}: ${text.slice(0, 220)}`;

      const rateLimit = buildRateLimitInfo({
        message: errorMessage,
        status: response.status,
        headers: responseHeaders,
      });

      throw new HttpRequestError(errorMessage, {
        status: response.status,
        body: parsedBody,
        headers: responseHeaders,
        provider,
        rateLimit,
      });
    }

    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new HttpRequestError(`${provider} request failed: ${message}`, {
      provider,
      body: message,
    });
  } finally {
    clearTimeout(timer);
  }
}
