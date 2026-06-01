/**
 * Auditoría de picks MLB/WNBA/NBA: eventos, picks, fuentes faltantes.
 */
const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 500) }; }
  return { status: res.status, data };
}

function summarizeModule(name, data) {
  if (!data || data.dataAvailable === false) {
    return {
      name,
      ok: false,
      reason: data?.message || data?.error || "dataAvailable=false",
      events: 0,
      picks: 0,
      modelPicks: 0,
      bettableGames: 0,
      missing: [],
    };
  }

  const games = data.games || data.matches || [];
  const picks = data.picks || [];
  const modelPicks = data.modelPicks || [];
  const slate = data.slateSummary || {};

  const missing = [];
  const providers = data.providers || [];
  for (const p of providers) {
    if (p.status && !/ok|active|ready|partial/i.test(String(p.status))) {
      missing.push(`${p.id || p.name}: ${p.status}${p.note ? ` — ${p.note}` : ""}`);
    }
  }

  let gamesWithoutOdds = 0;
  let gamesWithoutRecs = 0;
  let recsGris = 0;
  let recsVerde = 0;
  let recsAmarillo = 0;

  for (const g of games) {
    if (!g.odds && !g.bookmakers) gamesWithoutOdds += 1;
    const recs = g.recommendations || [];
    if (!recs.length) gamesWithoutRecs += 1;
    for (const r of recs) {
      if (r.color === "verde") recsVerde += 1;
      else if (r.color === "amarillo") recsAmarillo += 1;
      else recsGris += 1;
    }
  }

  if (gamesWithoutOdds) missing.push(`${gamesWithoutOdds}/${games.length} partidos sin cuotas enlazadas`);
  if (gamesWithoutRecs) missing.push(`${gamesWithoutRecs}/${games.length} partidos sin recomendaciones del modelo`);

  const ctxMissing = [];
  for (const g of games.slice(0, 8)) {
    const flags = g.context?.flags || {};
    const log = g.context?.source_log || {};
    if (!flags.stats_espn_disponibles && !flags.freshness_ok) ctxMissing.push("stats ESPN");
    if (!log.odds && !g.odds) ctxMissing.push("odds-api");
  }

  return {
    name,
    ok: true,
    events: slate.totalGames ?? games.length,
    gamesAnalyzed: slate.gamesAnalyzed,
    bettableGames: slate.bettableGames ?? 0,
    picks: picks.length,
    modelPicks: modelPicks.length,
    picksVerde: picks.filter((p) => p.color === "verde" || p.estado === "verde").length,
    picksAmarillo: picks.filter((p) => p.color === "amarillo" || p.estado === "amarillo").length,
    recsVerde,
    recsAmarillo,
    recsGris,
    cache: data.cacheMeta?.servedFrom || null,
    missing: [...new Set(missing)],
    sampleGames: games.slice(0, 3).map((g) => ({
      match: `${g.away} @ ${g.home}`,
      status: g.status,
      scheduleDate: g.scheduleDate,
      odds: Boolean(g.odds),
      picks: (g.picks || []).length,
      recommendations: (g.recommendations || []).length,
      recColors: (g.recommendations || []).map((r) => r.color).slice(0, 4),
    })),
  };
}

const modules = [
  { name: "mlb", url: "/api/mlb/analyze?refresh=1" },
  { name: "wnba", url: "/api/wnba/analyze?refresh=1" },
  { name: "nba", url: "/api/nba/analyze?refresh=1" },
];

console.log(`\n=== Auditoría picks · ${BASE} ===\n`);

const health = await fetchJson("/api/health");
console.log("Health:", health.status, health.data?.status || health.data);

const results = [];
for (const mod of modules) {
  process.stderr.write(`Fetching ${mod.name}...\n`);
  const { status, data } = await fetchJson(mod.url);
  results.push({ ...summarizeModule(mod.name, data), http: status });
}

console.log(JSON.stringify({ results }, null, 2));

for (const r of results) {
  console.log(`\n--- ${r.name.toUpperCase()} ---`);
  console.log(`HTTP ${r.http} · eventos ventana: ${r.events} · picks bettable: ${r.picks} · modelPicks: ${r.modelPicks ?? 0}`);
  if (r.recsVerde != null) {
    console.log(`Recomendaciones: ${r.recsVerde} verde · ${r.recsAmarillo} amarillo · ${r.recsGris} gris`);
  }
  if (!r.ok) {
    console.log(`Motivo: ${r.reason}`);
  }
  if (r.missing?.length) {
    console.log("Datos no cargados / avisos:");
    r.missing.forEach((m) => console.log(`  - ${m}`));
  }
  if (r.sampleGames?.length) {
    console.log("Muestra partidos:");
    r.sampleGames.forEach((g) => console.log(`  · ${g.match} (${g.scheduleDate}) · odds=${g.odds} · recs=${g.recommendations} ${g.recColors.join(",")}`));
  }
}
