import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE_FILE = path.join(process.cwd(), "src", "data", "quiniela-state.json");
const STATE_FILE = process.env.QUINIELA_STATE_FILE || DEFAULT_STATE_FILE;
const STORE_VERSION = 1;

function emptyStore() {
  return {
    version: STORE_VERSION,
    activeJornada: null,
    snapshots: {},
  };
}

function resolveJornada(payload) {
  const value =
    payload?.officialSource?.jornadaAnalizada ??
    payload?.officialSource?.officialJornada ??
    payload?.slateSummary?.officialJornada ??
    payload?.jornada ??
    null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isCompleteForecast(payload) {
  return Boolean(
    payload &&
      payload.dataAvailable !== false &&
      Array.isArray(payload.propuestaOficial) &&
      payload.propuestaOficial.length >= 14
  );
}

function isCompletedResult(payload) {
  const pending = Number(payload?.evaluacionResultados?.pendientes);
  return Number.isFinite(pending) && pending === 0;
}

async function readStore() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyStore();
    return {
      ...emptyStore(),
      ...parsed,
      snapshots: parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {},
    };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmp = `${STATE_FILE}.${nonce}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, STATE_FILE);
}

export async function loadQuinielaState() {
  return readStore();
}

export async function getStoredQuinielaForecast(jornada = null) {
  const store = await readStore();
  const key = jornada ? String(jornada) : String(store.activeJornada || "");
  if (!key) return null;
  return store.snapshots[key]?.payload || null;
}

export async function saveQuinielaForecastSnapshot(payload, { reason = "analysis" } = {}) {
  if (!isCompleteForecast(payload)) return null;
  const jornada = resolveJornada(payload);
  if (!jornada) return null;

  const store = await readStore();
  const key = String(jornada);
  const previous = store.snapshots[key] || {};
  const now = new Date().toISOString();
  const status = payload?.officialSource?.plazoCerrado
    ? isCompletedResult(payload)
      ? "completed"
      : "closed"
    : "open";

  store.activeJornada = jornada;
  store.snapshots[key] = {
    ...previous,
    jornada,
    status,
    savedAt: previous.savedAt || now,
    updatedAt: now,
    closedAt: status === "closed" || status === "completed" ? previous.closedAt || now : previous.closedAt || null,
    completedAt: status === "completed" ? previous.completedAt || now : previous.completedAt || null,
    reason,
    payload,
  };

  await writeStore(store);
  return store.snapshots[key].payload;
}

export function quinielaForecastIsComplete(payload) {
  return isCompleteForecast(payload);
}

export function quinielaResultsAreComplete(payload) {
  return isCompletedResult(payload);
}
