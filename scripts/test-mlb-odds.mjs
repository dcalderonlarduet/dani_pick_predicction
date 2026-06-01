import "../src/config/load-env.js";
import {
  getOddsApiRateLimitState,
  loadMlbOddsMap,
} from "../src/providers/odds-api-io.js";
import { getMadridTodayDateString } from "../src/utils/madrid-date.js";
import { writeFileSync } from "node:fs";

const date = process.argv[2] || getMadridTodayDateString();
const config = {
  oddsApiIo: {
    apiKey: process.env.ODDS_API_IO_KEY || "",
    baseUrl: process.env.ODDS_API_IO_BASE_URL || "https://api.odds-api.io/v3",
    bookmakers: (process.env.ODDS_API_IO_BOOKMAKERS || "Bet365,Winamax FR")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

async function probeEvents() {
  const url = new URL(`${config.oddsApiIo.baseUrl}/events`);
  url.searchParams.set("sport", "baseball");
  url.searchParams.set("apiKey", config.oddsApiIo.apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 500) };
  }
  const events = Array.isArray(body) ? body : [];
  const mlb = events.filter((e) => {
    const slug = String(e?.league?.slug || "").toLowerCase();
    const name = String(e?.league?.name || "").toLowerCase();
    return slug === "usa-mlb" || name.includes("mlb");
  });
  return {
    httpStatus: res.status,
    totalBaseballEvents: events.length,
    mlbEvents: mlb.length,
    sampleMlb: mlb.slice(0, 5).map((e) => ({
      id: e.id,
      home: e.home,
      away: e.away,
      date: e.date,
      status: e.status,
      league: e.league?.slug || e.league?.name,
    })),
    error: res.ok ? null : body,
  };
}

const rateLimit = getOddsApiRateLimitState();
let eventsProbe = null;
let mapError = null;
let map = new Map();

try {
  eventsProbe = await probeEvents();
} catch (err) {
  eventsProbe = { error: err.message };
}

try {
  map = await loadMlbOddsMap(date, config);
} catch (err) {
  mapError = err.message;
}

const summary = {
  testedAt: new Date().toISOString(),
  date,
  provider: "odds-api-io",
  hasApiKey: Boolean(config.oddsApiIo.apiKey),
  bookmakers: config.oddsApiIo.bookmakers,
  rateLimit,
  eventsProbe,
  mapError,
  gamesWithOdds: map.size,
  games: [...map.entries()].slice(0, 8).map(([key, v]) => ({
    key,
    home: v.home_team,
    away: v.away_team,
    eventId: v.eventId,
    totalsLine: v.totalsLine,
    bookmakers: Object.keys(v.bookmakers || {}),
    hasMl: Boolean(v.bookmakers?.Bet365?.winner || v.bookmakers?.["Bet365"]?.winner),
    hasTotals: Boolean(v.bookmakers?.Bet365?.totals || v.bookmakers?.["Bet365"]?.totals),
  })),
};

writeFileSync("test-mlb-odds-output.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
