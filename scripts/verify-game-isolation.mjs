#!/usr/bin/env node
import { findProOddsEntry } from "../src/services/pro-analyzer-shared.js";
import { resolveMatchRow } from "../src/services/match-row-resolver.js";
import { normalizeCommenceTime } from "../src/services/schedule-match.js";

function assert(label, condition) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`OK: ${label}`);
}

function buildOddsMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const teamKey = `${entry.home_team}::${entry.away_team}`.toLowerCase();
    if (entry.eventId) map.set(`event:${entry.eventId}`, entry);
    const normalized = normalizeCommenceTime(entry.commenceTime);
    if (normalized) {
      map.set(`${teamKey}::${normalized.slice(0, 10)}::${normalized}`, entry);
      if (!map.has(`${teamKey}::${normalized.slice(0, 10)}`)) {
        map.set(`${teamKey}::${normalized.slice(0, 10)}`, entry);
      }
    }
  }
  return map;
}

const map = new Map();
map.set("event:101", {
  eventId: "101",
  home_team: "Oklahoma City Thunder",
  away_team: "San Antonio Spurs",
  commenceTime: "2026-05-30T01:00:00Z",
  bookmakers: { Bet365: {} },
});
map.set("event:102", {
  eventId: "102",
  home_team: "Oklahoma City Thunder",
  away_team: "San Antonio Spurs",
  commenceTime: "2026-06-01T01:00:00Z",
  bookmakers: { Bet365: { other: true } },
});
map.set("oklahoma city thunder::san antonio spurs::2026-05-30", map.get("event:101"));
map.set("oklahoma city thunder::san antonio spurs::2026-06-01", map.get("event:102"));

const g1 = findProOddsEntry(map, "Oklahoma City Thunder", "San Antonio Spurs", "101", "2026-05-30");
const g2 = findProOddsEntry(map, "Oklahoma City Thunder", "San Antonio Spurs", "102", "2026-06-01");
assert("Cuotas Game 7 por eventId", g1?.eventId === "101" && g2?.eventId === "102");
assert("Cuotas distintas por fecha", g1 !== g2);

const g1byDate = findProOddsEntry(map, "Oklahoma City Thunder", "San Antonio Spurs", null, "2026-05-30");
assert("Cuotas por fecha sin eventId", g1byDate?.eventId === "101");

const wrongFuzzy = new Map();
wrongFuzzy.set("new york::los angeles", { eventId: "ny-la" });
wrongFuzzy.set("new york yankees::los angeles angels", { eventId: "nyy-laa" });
const yankees = findProOddsEntry(wrongFuzzy, "New York Yankees", "Los Angeles Angels");
assert("No mezcla substring NY/LA", yankees?.eventId === "nyy-laa");

const doubleHeaderMap = buildOddsMap([
  {
    eventId: "dh1",
    home_team: "new york yankees",
    away_team: "boston red sox",
    commenceTime: "2026-07-04T17:05:00Z",
    bookmakers: { Bet365: { game: 1 } },
  },
  {
    eventId: "dh2",
    home_team: "new york yankees",
    away_team: "boston red sox",
    commenceTime: "2026-07-04T23:10:00Z",
    bookmakers: { Bet365: { game: 2 } },
  },
]);
const game1 = findProOddsEntry(
  doubleHeaderMap,
  "New York Yankees",
  "Boston Red Sox",
  null,
  "2026-07-04",
  "2026-07-04T17:05:00Z"
);
const game2 = findProOddsEntry(
  doubleHeaderMap,
  "New York Yankees",
  "Boston Red Sox",
  null,
  "2026-07-04",
  "2026-07-04T23:10:00Z"
);
assert("Dobleheader MLB por hora de inicio", game1?.eventId === "dh1" && game2?.eventId === "dh2");

const ambiguous = findProOddsEntry(doubleHeaderMap, "New York Yankees", "Boston Red Sox", null, "2026-07-04");
assert("Dobleheader sin hora → null", ambiguous === null);

const snapshotRows = [
  {
    sport: "nba",
    eventId: "201",
    home: "Oklahoma City Thunder",
    away: "San Antonio Spurs",
    commenceTime: "2026-05-30T01:00:00Z",
    markets: { moneyline: { pct_tickets_home: 62 } },
  },
  {
    sport: "nba",
    eventId: "202",
    home: "Oklahoma City Thunder",
    away: "San Antonio Spurs",
    commenceTime: "2026-06-01T01:00:00Z",
    markets: { moneyline: { pct_tickets_home: 41 } },
  },
  {
    sport: "mlb",
    home: "New York Yankees",
    away: "Los Angeles Angels",
    markets: { moneyline: { pct_tickets_home: 55 } },
  },
  {
    sport: "mlb",
    home: "New York Mets",
    away: "Los Angeles Dodgers",
    markets: { moneyline: { pct_tickets_home: 48 } },
  },
];

const lm1 = resolveMatchRow(snapshotRows, {
  home: "Oklahoma City Thunder",
  away: "San Antonio Spurs",
  sport: "nba",
  eventId: "201",
});
const lm2 = resolveMatchRow(snapshotRows, {
  home: "Oklahoma City Thunder",
  away: "San Antonio Spurs",
  sport: "nba",
  eventId: "202",
});
assert("OddsHarvester por eventId", lm1?.row?.eventId === "201" && lm2?.row?.eventId === "202");

const lmByDate = resolveMatchRow(snapshotRows, {
  home: "Oklahoma City Thunder",
  away: "San Antonio Spurs",
  sport: "nba",
  scheduleDate: "2026-06-01",
});
assert("OddsHarvester por fecha", lmByDate?.row?.eventId === "202");

const lmAmbiguous = resolveMatchRow(snapshotRows, {
  home: "Oklahoma City Thunder",
  away: "San Antonio Spurs",
  sport: "nba",
});
assert("OddsHarvester ambiguo sin id/fecha → null", lmAmbiguous === null);

const nyMatch = resolveMatchRow(snapshotRows, {
  home: "New York Yankees",
  away: "Los Angeles Angels",
  sport: "mlb",
});
assert("OddsHarvester no confunde NY Yankees con NY Mets", nyMatch?.row?.home === "New York Yankees");

console.log("\nGame isolation checks OK.");
