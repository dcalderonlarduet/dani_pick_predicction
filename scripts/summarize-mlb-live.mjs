import { readFileSync, writeFileSync } from "node:fs";

function readJsonFile(path) {
  const buf = readFileSync(path);
  const text =
    buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
      ? buf.toString("utf16le")
      : buf.toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

const data = readJsonFile("mlb-live-response.json");
const games = data?.games || [];
const picks = data?.picks || [];
let withOdds = 0;
let withBettableRec = 0;
let recsVerde = 0;
let recsAmarillo = 0;
let recsWithOdds = 0;

for (const g of games) {
  if (g.oddsAvailable) withOdds += 1;
  for (const r of g.recommendations || []) {
    if (r.odds) recsWithOdds += 1;
    if (r.bettable) withBettableRec += 1;
    if (r.color === "verde") recsVerde += 1;
    if (r.color === "amarillo") recsAmarillo += 1;
  }
}

const summary = {
  dataAvailable: data?.dataAvailable,
  coverageOdds: data?.coverage?.odds,
  slate: data?.slateSummary,
  picksBettable: picks.length,
  modelPicks: (data?.modelPicks || []).length,
  gamesTotal: games.length,
  gamesWithOdds: withOdds,
  recsWithOdds,
  recsBettable: withBettableRec,
  recsVerde,
  recsAmarillo,
  samplePicks: picks.slice(0, 5).map((p) => ({
    match: p.matchLabel,
    selection: p.selection,
    color: p.color,
    bettable: p.bettable,
    odds: p.odds,
    ev: p.ev,
    confidence: p.confidence,
    failures: p.value_gates?.failures,
  })),
  sampleGamesOdds: games
    .filter((g) => g.oddsAvailable)
    .slice(0, 5)
    .map((g) => ({
      match: `${g.awayTeam?.name || g.away} @ ${g.homeTeam?.name || g.home}`,
      totalsLine: g.totalsLine,
      bookmakers: Object.keys(g.bookmakers || {}),
    })),
};

writeFileSync("mlb-live-summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
