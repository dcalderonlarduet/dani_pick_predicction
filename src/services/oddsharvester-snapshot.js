import { readFile } from "node:fs/promises";
import { getRuntimeConfig } from "../config/runtime.js";
import { resolveMatchRow } from "./match-row-resolver.js";
import { lookupPublicSplitMatch } from "./public-splits-store.js";

let snapshotCache = { loadedAt: 0, rows: [] };

async function loadSnapshotRows() {
  const path = getRuntimeConfig().communityStack?.oddsharvesterSnapshotFile;
  if (!path) return [];
  if (snapshotCache.loadedAt && Date.now() - snapshotCache.loadedAt < 5 * 60 * 1000) {
    return snapshotCache.rows;
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    snapshotCache = {
      loadedAt: Date.now(),
      rows: Array.isArray(parsed?.matches) ? parsed.matches : Array.isArray(parsed) ? parsed : [],
    };
    return snapshotCache.rows;
  } catch {
    snapshotCache = { loadedAt: Date.now(), rows: [] };
    return [];
  }
}

export async function getOddsHarvesterMatchContext({
  home,
  away,
  sport,
  marketKey,
  eventId = null,
  scheduleDate = null,
  startTime = null,
}) {
  const rows = await loadSnapshotRows();
  const resolved = resolveMatchRow(rows, { home, away, sport, eventId, scheduleDate, startTime });
  const best = resolved?.row || null;

  if (!best) {
    return lookupPublicSplitMatch({ home, away, sport, marketKey, eventId, scheduleDate, startTime });
  }

  const markets = best.markets || best;
  const market =
    markets?.[marketKey] ||
    markets?.totals ||
    markets?.game_total ||
    markets?.moneyline ||
    null;

  const snapshotContext = {
    pct_tickets_home: Number(market?.pct_tickets_home ?? best.pct_tickets_home ?? 50),
    pct_tickets_away: Number(
      market?.pct_tickets_away ?? best.pct_tickets_away ?? 100 - Number(market?.pct_tickets_home ?? best.pct_tickets_home ?? 50)
    ),
    pct_money_home: Number(market?.pct_money_home ?? best.pct_money_home ?? 50),
    linea_apertura: Number(market?.linea_apertura ?? market?.open_line ?? best.linea_apertura),
    linea_actual: Number(market?.linea_actual ?? market?.current_line ?? best.linea_actual),
    cuota_apertura_home: Number(market?.cuota_apertura_home ?? market?.open_home ?? best.cuota_apertura_home),
    cuota_apertura_away: Number(market?.cuota_apertura_away ?? market?.open_away ?? best.cuota_apertura_away),
    cuota_actual_home: Number(market?.cuota_actual_home ?? market?.current_home ?? best.cuota_actual_home),
    cuota_actual_away: Number(market?.cuota_actual_away ?? market?.current_away ?? best.cuota_actual_away),
    source: "oddsharvester-snapshot",
  };

  const publicSplit = lookupPublicSplitMatch({ home, away, sport, marketKey, eventId, scheduleDate, startTime });
  if (!publicSplit) return snapshotContext;

  return {
    ...snapshotContext,
    pct_tickets_home: publicSplit.pct_tickets_home ?? snapshotContext.pct_tickets_home,
    pct_tickets_away: publicSplit.pct_tickets_away ?? snapshotContext.pct_tickets_away,
    pct_money_home: publicSplit.pct_money_home ?? snapshotContext.pct_money_home,
    source: `${snapshotContext.source}+${publicSplit.source}`,
  };
}
