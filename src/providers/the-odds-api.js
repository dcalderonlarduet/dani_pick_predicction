import {
  canonicalName,
  normalizeBookmakersFromTheOdds,
} from "./shared/tennis-normalizers.js";
import { fetchJson } from "./shared/http.js";

function buildTheOddsUrl(config, pathname, params = {}) {
  const url = new URL(`${config.theOddsApi.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  url.searchParams.set("apiKey", config.theOddsApi.apiKey);
  return url.toString();
}

async function callTheOdds(config, pathname, params) {
  return fetchJson(buildTheOddsUrl(config, pathname, params), {
    provider: `the-odds-api:${pathname}`,
  });
}

function createMatchLookupKey(nameA, nameB) {
  return [canonicalName(nameA), canonicalName(nameB)].sort().join("::");
}

function mergeBookmakers(match, normalizedOdds) {
  for (const [bookmaker, markets] of Object.entries(normalizedOdds.bookmakers)) {
    if (!match.bookmakers[bookmaker]) {
      match.bookmakers[bookmaker] = {};
    }
    if (markets.winner) {
      match.bookmakers[bookmaker].winner = markets.winner;
    }
    if (markets.totals) {
      match.bookmakers[bookmaker].totals = {
        ...(match.bookmakers[bookmaker].totals || {}),
        ...markets.totals,
      };
    }
  }
}

export async function attachTheOddsApiOdds(slate, config) {
  if (!config.theOddsApi.apiKey) {
    return slate;
  }

  const sports = await callTheOdds(config, "/sports/");
  const tennisSports = (sports || []).filter((sport) => String(sport.key || "").startsWith("tennis_"));
  const events = [];

  for (const sport of tennisSports) {
    const sportOdds = await callTheOdds(config, `/sports/${sport.key}/odds/`, {
      regions: config.theOddsApi.regions,
      markets: config.theOddsApi.markets,
      oddsFormat: "decimal",
    }).catch(() => []);
    for (const event of sportOdds || []) {
      events.push(event);
    }
  }

  const oddsMap = new Map();
  for (const event of events) {
    oddsMap.set(createMatchLookupKey(event.home_team, event.away_team), event);
  }

  let matched = 0;
  for (const match of slate.matches) {
    const key = createMatchLookupKey(match.participants[0].name, match.participants[1].name);
    const event = oddsMap.get(key);
    if (!event) continue;

    const normalized = normalizeBookmakersFromTheOdds(event, match.totalsLine);
    mergeBookmakers(match, normalized);
    match.totalsLine = normalized.totalsLine;
    match.providerContext.theOddsEvent = {
      id: event.id,
      sportKey: event.sport_key,
      sportTitle: event.sport_title,
    };
    matched += 1;
  }

  slate.coverage.odds = slate.matches.length ? matched / slate.matches.length : 0;
  slate.stalenessMinutes.odds = matched ? 6 : 999;

  const provider = slate.providerManifest.providers.find((item) => item.id === "odds");
  if (provider) {
    provider.name = "The Odds API";
    provider.status = matched ? "configured" : "partial";
    provider.docs = "https://the-odds-api.com/liveapi/guides/v4/index.html";
    provider.notes = matched
      ? "Odds enlazadas por nombres de competidores y deportes de tenis en temporada."
      : "No se pudo enlazar ninguna cuota al slate actual.";
  }

  return slate;
}
