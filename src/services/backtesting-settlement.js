/**
 * Job diario: resuelve picks_history pendientes (ESPN / MLB Stats API).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchScoreboard, fetchEspnJson } from "../providers/shared/espn-pro.js";
import { ESPN_NBA } from "../providers/espn-nba.js";
import { ESPN_NFL } from "../providers/espn-nfl.js";
import { ESPN_WNBA } from "../providers/espn-wnba.js";
import { fetchEspnSoccerScoreboard } from "../providers/espn-soccer.js";
import { fetchJson } from "../providers/shared/http.js";
import { updateResult } from "./backtesting.js";
import { getSharedDbPool, hasDatabaseConfig } from "./picks-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_STORE = path.join(__dirname, "..", "data", "picks-history.json");
const MLB_LINEScore_URL = "https://statsapi.mlb.com/api/v1/game/{id}/linescore";

const SCOREBOARDS = {
  nba: ESPN_NBA.scoreboard,
  nfl: ESPN_NFL.scoreboard,
  wnba: ESPN_WNBA.scoreboard,
};

const FOOTBALL_LEAGUE_SLUGS = [
  "eng.1",
  "esp.1",
  "esp.2",
  "ger.1",
  "ita.1",
  "fra.1",
  "uefa.champions",
  "uefa.europa",
  "uefa.europa.conf",
  "concacaf.champions",
  "eng.fa",
  "esp.copa_del_rey",
];

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return /final|post|completed|closed|full.?time|status_final/.test(s);
}

function totalSideSettle(total, line, side) {
  if (!Number.isFinite(line)) return null;
  if (total === line) return "push";
  if (side === "over") return total > line ? "win" : "loss";
  if (side === "under") return total < line ? "win" : "loss";
  return null;
}

function settlePick(pickRow, homeScore, awayScore) {
  const market = String(pickRow.market || "");
  const side = String(pickRow.pick || "").toLowerCase();
  const line = Number(pickRow.lineTaken ?? pickRow.line_taken);
  const home = Number(homeScore);
  const away = Number(awayScore);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;

  if (market === "moneyline" || market === "ML") {
    if (home === away) {
      if (side === "draw") return "win";
      return "push";
    }
    const winner = home > away ? "home" : "away";
    if (side === "draw") return "loss";
    return winner === side ? "win" : "loss";
  }

  if (market === "Double Chance") {
    if (side === "1x") {
      if (home >= away) return "win";
      return "loss";
    }
    if (side === "x2") {
      if (away >= home) return "win";
      return "loss";
    }
    if (side === "12") {
      if (home === away) return "loss";
      return "win";
    }
  }

  if (market === "runline" || market === "Spread") {
    if (!Number.isFinite(line)) return null;
    const adjusted = side === "home" ? home + line : away + line;
    const rival = side === "home" ? away : home;
    if (adjusted === rival) return "push";
    return adjusted > rival ? "win" : "loss";
  }

  if (market === "team_total_home" || market === "Team Total Home" || market === "teamTotalHome") {
    return totalSideSettle(home, line, side);
  }

  if (market === "team_total_away" || market === "Team Total Away" || market === "teamTotalAway") {
    return totalSideSettle(away, line, side);
  }

  if (
    market === "game_total" ||
    market === "first_half_total" ||
    market === "Totals" ||
    market === "totals"
  ) {
    return totalSideSettle(home + away, line, side);
  }

  return null;
}

async function loadPendingPicks() {
  if (hasDatabaseConfig()) {
    try {
      const { rows } = await getSharedDbPool().query(
        `SELECT * FROM picks_history WHERE result = 'pending' ORDER BY created_at ASC`
      );
      return rows.map((row) => ({
        sport: row.sport,
        gameId: row.game_id,
        market: row.market,
        pick: row.pick,
        lineTaken: row.line_taken,
        gameDate: row.game_date,
        league: row.league,
        factors_used: row.factors_used,
        closingLine: row.closing_line,
        closingOdds: row.closing_odds,
        oddsTaken: row.odds_taken,
      }));
    } catch {
      /* JSON fallback */
    }
  }
  try {
    const raw = await readFile(JSON_STORE, "utf8");
    return (JSON.parse(raw) || [])
      .filter((r) => r.result === "pending")
      .map((r) => ({
        sport: r.sport,
        gameId: r.gameId,
        market: r.market,
        pick: r.pick,
        lineTaken: r.lineTaken,
        gameDate: r.gameDate,
        league: r.league,
        factors_used: r.factors_used,
        closingLine: r.closingLine,
        closingOdds: r.closingOdds,
        oddsTaken: r.oddsTaken,
      }));
  } catch {
    return [];
  }
}

function extractScores(event) {
  const competitors = event?.competitions?.[0]?.competitors;
  if (!Array.isArray(competitors)) return null;
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
  const homeScore = Number(home?.score ?? home?.team?.score);
  const awayScore = Number(away?.score ?? away?.team?.score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  return { homeScore, awayScore };
}

async function fetchMlbScores(gameId) {
  const url = MLB_LINEScore_URL.replace("{id}", encodeURIComponent(gameId));
  const payload = await fetchJson(url, { provider: "mlb-linescore", timeoutMs: 15000 }).catch(() => null);
  const teams = payload?.teams;
  if (!teams) return null;
  const home = Number(teams?.home?.runs);
  const away = Number(teams?.away?.runs);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const abstract = String(payload?.status?.abstractGameState || "").toLowerCase();
  if (!/final|completed|game over/.test(abstract)) return null;
  return { homeScore: home, awayScore: away };
}

async function fetchEspnSoccerScores(gameId, leagueHint) {
  const slugs = leagueHint && String(leagueHint).includes(".") ? [leagueHint] : FOOTBALL_LEAGUE_SLUGS;
  for (const slug of slugs) {
    try {
      const summary = await fetchEspnJson(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(gameId)}`,
        `espn-soccer-summary|${slug}|${gameId}`
      );
      const comp = summary?.header?.competitions?.[0];
      const status = comp?.status?.type?.description || comp?.status?.type?.name;
      if (!isFinalStatus(status)) continue;
      const scores = extractScores({ competitions: [comp] });
      if (scores) return scores;
    } catch {
      /* next slug */
    }
  }
  return null;
}

async function buildEventIndex(dateKeys) {
  const eventIndex = new Map();

  for (const day of dateKeys) {
    for (const [sport, url] of Object.entries(SCOREBOARDS)) {
      const events = await fetchScoreboard(url, day, sport).catch(() => []);
      for (const event of events) {
        if (!isFinalStatus(event?.status?.type?.description || event?.status?.type?.name)) continue;
        eventIndex.set(`${sport}|${event.id}`, event);
      }
    }

    for (const slug of FOOTBALL_LEAGUE_SLUGS) {
      const scoreboard = await fetchEspnSoccerScoreboard(slug, day).catch(() => null);
      const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
      for (const event of events) {
        if (!isFinalStatus(event?.status?.type?.description || event?.status?.type?.name)) continue;
        eventIndex.set(`football|${event.id}`, event);
      }
    }
  }

  return eventIndex;
}

export async function reconcileBacktestingResults({ date } = {}) {
  const pending = await loadPendingPicks();
  if (!pending.length) return { checked: 0, resolved: 0 };

  const dateKeys = new Set();
  if (date) dateKeys.add(String(date).slice(0, 10));
  for (const row of pending) {
    if (row.gameDate) dateKeys.add(String(row.gameDate).slice(0, 10));
  }
  if (!dateKeys.size) dateKeys.add(new Date().toISOString().slice(0, 10));
  const expandedDateKeys = new Set();
  for (const dateKey of dateKeys) {
    expandedDateKeys.add(dateKey);
    const stamp = Date.parse(`${dateKey}T00:00:00Z`);
    if (!Number.isNaN(stamp)) {
      expandedDateKeys.add(new Date(stamp - 86400000).toISOString().slice(0, 10));
      expandedDateKeys.add(new Date(stamp + 86400000).toISOString().slice(0, 10));
    }
  }

  const eventIndex = await buildEventIndex(expandedDateKeys);

  let resolved = 0;
  for (const row of pending) {
    const sport = String(row.sport || "").toLowerCase();
    if (sport === "tennis") continue;

    let scores = null;

    if (sport === "mlb") {
      scores = await fetchMlbScores(row.gameId);
    } else if (sport === "football" || sport === "futbol") {
      const leagueSlug = row.factors_used?.leagueSlug || row.league;
      scores =
        extractScores(eventIndex.get(`football|${row.gameId}`)) ||
        (await fetchEspnSoccerScores(row.gameId, leagueSlug));
    } else {
      const event = eventIndex.get(`${sport}|${row.gameId}`);
      if (event) scores = extractScores(event);
    }

    const outcome = scores ? settlePick(row, scores.homeScore, scores.awayScore) : null;

    if (!outcome) continue;
    await updateResult(row.gameId, row.market, outcome, row.closingLine ?? null, row.closingOdds ?? null);
    resolved += 1;
  }

  return { checked: pending.length, resolved };
}
