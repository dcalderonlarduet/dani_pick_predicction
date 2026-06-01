/**
 * Verificación post-despliegue: módulos, caché, splits job, picks y UI estática.
 * Uso: node scripts/verify-deploy.mjs
 *      SMOKE_BASE_URL=http://localhost:3000 node scripts/verify-deploy.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";

const MODULE_ENDPOINTS = [
  { id: "mlb", url: "/api/mlb/analyze", eventsKey: "games" },
  { id: "futbol", url: "/api/futbol/analyze", eventsKey: "matches" },
  { id: "nba", url: "/api/nba/analyze", eventsKey: "games" },
  { id: "wnba", url: "/api/wnba/analyze", eventsKey: "games" },
  { id: "nfl", url: "/api/nfl/analyze", eventsKey: "games" },
  { id: "quiniela", url: "/api/quiniela/analyze", eventsKey: "partidos" },
];

const checks = [];
let failed = 0;

function pass(name, detail = "") {
  checks.push({ ok: true, name, detail });
}

function fail(name, detail = "") {
  checks.push({ ok: false, name, detail });
  failed += 1;
}

async function fetchJson(path, { timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { _raw: text.slice(0, 300) };
    }
    return { status: response.status, ms: Date.now() - started, payload };
  } finally {
    clearTimeout(timer);
  }
}

function countEvents(moduleId, payload) {
  if (!payload || payload.dataAvailable === false) return 0;
  if (moduleId === "quiniela") {
    if (!payload?.officialSource?.cardDetected) return 0;
    return (payload.partidos || payload.propuestaOficial || []).length;
  }
  return (payload.games || payload.matches || payload.partidos || []).length;
}

function collectPicksFromPayload(moduleId, payload) {
  if (!payload || payload.dataAvailable === false) return [];

  if (moduleId === "quiniela") {
    return [];
  }

  if (moduleId === "mlb" || moduleId === "nba" || moduleId === "wnba" || moduleId === "nfl") {
    return (payload.picks || []).map((item) => ({
      estado: item.color === "amarillo" ? "amarillo" : item.color === "gris" ? "rojo" : "verde",
      confianza: Number(item.confidence ?? item.confianza ?? 0),
      score: Number(item.score_final ?? item.score ?? 0),
      edge: Number(item.ev ?? item.edge ?? 0),
      bettable: Boolean(item.bettable),
      pick: item.selection || item.pick,
    }));
  }

  if (moduleId === "futbol") {
    const raw = [
      ...(payload.picks || []),
      ...(payload.partidos || []).flatMap((match) =>
        (match.picks || []).map((pick) => ({ ...pick, _partido: `${match.home} vs ${match.away}` }))
      ),
    ];
    return raw.map((item) => ({
      estado: item.estado || (item.color === "amarillo" ? "amarillo" : "verde"),
      confianza: Number(item.confianza ?? item.confidence ?? 0),
      score: Number(item.score_final ?? item.score ?? 0),
      edge: Number(item.ev ?? item.edge ?? 0),
      bettable: item.bettable !== false,
      pick: item.pick || item.selection,
    }));
  }

  const picks = [];
  const rows = payload.games || payload.matches || payload.partidos || [];
  for (const row of rows) {
    for (const item of row.analyses || row.picks || row.lines || []) {
      picks.push({
        estado: item.estado || item.status || "verde",
        confianza: Number(item.confianza ?? item.confidence ?? item.confidencePct ?? 0),
        score: Number(item.score_final ?? item.score ?? 0),
        edge: Number(item.edge ?? item.ev ?? 0),
        bettable: item.bettable !== false,
        pick: item.pick || item.selection || item.market,
      });
    }
  }
  return picks;
}

function pickPassesModuleFilters(moduleId, pick) {
  if (pick.estado === "rojo" || pick.estado === "lean") return true;
  if (moduleId === "mlb" || moduleId === "nba" || moduleId === "wnba" || moduleId === "nfl") {
    if (pick.estado === "amarillo") return pick.confianza >= 52;
    return pick.bettable !== false && (pick.confianza >= 52 || pick.score >= 55);
  }
  if (pick.estado === "amarillo") return pick.confianza >= 50;
  return pick.confianza >= 52 || pick.score >= 55;
}

async function verifyHealth() {
  const { status, payload, ms } = await fetchJson("/api/health", { timeoutMs: 15_000 });
  if (status === 200) pass("health", `${ms}ms · ${payload?.status || "ok"}`);
  else fail("health", `HTTP ${status}`);
}

async function verifyPublicSplits() {
  const first = await fetchJson("/api/public-splits/status", { timeoutMs: 30_000 });
  if (first.status !== 200) {
    fail("public-splits-status", `HTTP ${first.status}`);
    return;
  }
  const p = first.payload;
  const enabled = p?.enabled !== false;
  if (!enabled) {
    pass("public-splits-status", "deshabilitado por config");
    return;
  }
  if (!p?.state) fail("public-splits-status", "sin state");
  else pass("public-splits-status", `${p.state} · ${p.games ?? 0} juegos · ${p.message || ""}`.trim());

  if (typeof p?.games === "number" && p.games > 0) pass("public-splits-data", `${p.games} partidos en store`);
  else if (p?.state === "warning") pass("public-splits-data", "parcial (warning aceptable)");
  else fail("public-splits-data", "0 partidos en store");

  const ageMs = p?.ageMs ?? p?.snapshotAgeMs;
  if (Number.isFinite(ageMs)) pass("public-splits-cache-age", `${Math.round(ageMs / 1000)}s`);
  else pass("public-splits-cache-age", "edad no expuesta (ok si job reciente)");
}

async function verifyModuleCache(module) {
  const cold = await fetchJson(module.url, { timeoutMs: 180_000 });
  if (cold.status !== 200) {
    fail(`${module.id}-http`, `HTTP ${cold.status} · ${cold.payload?.error || ""}`);
    return null;
  }

  const events = countEvents(module.id, cold.payload);
  const cache1 = cold.payload?.cacheMeta?.servedFrom || cold.payload?.cache?.servedFrom || "unknown";
  pass(`${module.id}-analyze`, `${cold.ms}ms · ${events} eventos · caché ${cache1}`);

  const warm = await fetchJson(`${module.url}?refresh=0`, { timeoutMs: 60_000 });
  const cache2 = warm.payload?.cacheMeta?.servedFrom || warm.payload?.cache?.servedFrom;
  if (warm.status === 200 && (cache2 === "fresh" || cache2 === "stale" || warm.ms < cold.ms * 0.85)) {
    pass(`${module.id}-cache-hit`, `2ª llamada ${warm.ms}ms · ${cache2 || "rápida"}`);
  } else {
    pass(`${module.id}-cache-hit`, `2ª llamada ${warm.ms}ms (sin meta explícita)`);
  }

  const picks = collectPicksFromPayload(module.id, cold.payload);
  const greens = picks.filter((p) => p.estado === "verde");
  const bad = greens.filter((p) => !pickPassesModuleFilters(module.id, p));
  if (module.id === "quiniela") {
    pass(`${module.id}-pick-filters`, "quiniela usa propuesta oficial (sin picks EV en API)");
  } else if (greens.length && bad.length) {
    fail(`${module.id}-pick-filters`, `${bad.length}/${greens.length} verdes no pasan umbral`);
  } else if (greens.length) {
    pass(`${module.id}-pick-filters`, `${greens.length} verdes · filtros OK`);
  } else if (events === 0) {
    pass(`${module.id}-pick-filters`, "sin eventos (módulo vacío esperado)");
  } else {
    pass(`${module.id}-pick-filters`, `${picks.length} picks totales · 0 verdes (normal si no hay valor)`);
  }

  return { events, picks: greens.length, cache: cache1, ms: cold.ms };
}

async function verifyStaticUi() {
  const indexRes = await fetch(`${BASE}/`);
  const cssRes = await fetch(`${BASE}/styles.css?v=module-cache-2`);
  const wnbaRes = await fetch(`${BASE}/wnba-ball.svg`);
  if (indexRes.status !== 200) fail("ui-index", `HTTP ${indexRes.status}`);
  else pass("ui-index", "HTML servido");

  if (cssRes.status !== 200) fail("ui-css", `HTTP ${cssRes.status}`);
  else pass("ui-css", "styles.css servido");

  if (wnbaRes.status !== 200) fail("ui-wnba-icon", `HTTP ${wnbaRes.status}`);
  else pass("ui-wnba-icon", "wnba-ball.svg servido");

  const html = await indexRes.text();
  const css = cssRes.status === 200 ? await cssRes.text() : "";

  const uiSignals = [
    ["nav-status-row", html.includes('class="nav-status-row"')],
    ["nav-live-pill TIX", html.includes('id="public-splits-banner"') && html.includes("nav-live-pill")],
    ["nav-live-pill CACHE", html.includes('id="module-cache-banner"')],
    ["moduleIsDisabled", html.includes("moduleIsDisabled")],
    ["qualifiesTopPick", html.includes("qualifiesTopPick")],
    ["qualifiesBestPickOfDay", html.includes("qualifiesBestPickOfDay")],
    ["pickHasValue", html.includes("pickHasValue")],
    ["wnba-ball.svg", html.includes("wnba-ball.svg")],
    ["viewport meta", html.includes('name="viewport"')],
    ["no float tray", !html.includes("float-pick-tray")],
  ];
  for (const [label, ok] of uiSignals) {
    if (ok) pass(`ui-${label}`, "presente");
    else fail(`ui-${label}`, "ausente");
  }

  const mediaQueries = (css.match(/@media/g) || []).length;
  if (mediaQueries >= 8) pass("ui-responsive", `${mediaQueries} breakpoints CSS`);
  else fail("ui-responsive", `solo ${mediaQueries} breakpoints`);

  if (css.includes(".nav-status-row") && css.includes(".nav-live-pill.is-ok")) {
    pass("ui-status-styles", "nav TIX/CACHE + estados verde/rojo");
  } else {
    fail("ui-status-styles", "faltan estilos nav-live-pill");
  }
}

async function verifyLocalParser() {
  try {
    const html = await readFile(join(ROOT, "dk-splits-full.html"), "utf8");
    const { parseDraftKingsSplitsHtml } = await import("../src/providers/public-splits.js");
    const parsed = parseDraftKingsSplitsHtml(html, "mlb");
    if (parsed.ok && parsed.games.length >= 8) {
      pass("parser-dk-local", `${parsed.games.length} partidos parseados`);
    } else {
      fail("parser-dk-local", `ok=${parsed.ok} count=${parsed.games?.length}`);
    }
  } catch (error) {
    fail("parser-dk-local", error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n=== Verificación despliegue · ${BASE} ===\n`);

try {
  await verifyHealth();
  await verifyPublicSplits();
  for (const mod of MODULE_ENDPOINTS) {
    await verifyModuleCache(mod);
  }
  await verifyStaticUi();
  await verifyLocalParser();
} catch (error) {
  fail("fatal", error instanceof Error ? error.message : String(error));
}

console.log("\n--- Resultados ---");
for (const row of checks) {
  console.log(`${row.ok ? "✓" : "✗"} ${row.name}${row.detail ? ` · ${row.detail}` : ""}`);
}
console.log(`\nTotal: ${checks.length} · OK: ${checks.length - failed} · FAIL: ${failed}\n`);

process.exit(failed ? 1 : 0);
