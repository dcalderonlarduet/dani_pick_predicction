const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const TIMEOUT_MS = Number(process.env.MLB_AUDIT_TIMEOUT_MS || 300000);

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = await res.json();
  return { status: res.status, data };
}

const { status, data } = await fetchJson("/api/mlb/analyze?refresh=1");
const picks = data?.picks || [];
const modelPicks = data?.modelPicks || [];
const games = data?.games || [];
const slate = data?.slateSummary || {};

let bettableRecs = 0;
let verde = 0;
let amarillo = 0;
let gris = 0;
for (const g of games) {
  for (const r of g.recommendations || []) {
    if (r.bettable) bettableRecs += 1;
    if (r.color === "verde") verde += 1;
    else if (r.color === "amarillo") amarillo += 1;
    else gris += 1;
  }
}

const summary = {
  http: status,
  events: slate.totalGames ?? games.length,
  bettableGames: slate.bettableGames ?? 0,
  picksBettable: picks.length,
  modelPicks: modelPicks.length,
  picksVerde: picks.filter((p) => p.color === "verde").length,
  picksAmarillo: picks.filter((p) => p.color === "amarillo").length,
  recsBettable: bettableRecs,
  recsVerde: verde,
  recsAmarillo: amarillo,
  recsGris: gris,
  samplePicks: picks.slice(0, 6).map((p) => ({
    match: `${p.awayTeam || p.away} @ ${p.homeTeam || p.home}`,
    type: p.type,
    selection: p.selection,
    color: p.color,
    bettable: p.bettable,
    confidence: p.confidence,
    ev: p.ev ?? p.evPercent,
    score: p.score,
    failures: p.value_gates?.failures,
  })),
};

console.log(JSON.stringify(summary, null, 2));
