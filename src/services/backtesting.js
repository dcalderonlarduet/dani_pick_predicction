import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateStatsByMarketType,
  getMinRecommendationConfidence,
  passesRecommendationConfidence,
} from "./pick-calibration.js";
import { getSharedDbPool, hasDatabaseConfig } from "./picks-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_STORE = path.join(__dirname, "..", "data", "picks-history.json");

const VALID_SPORTS = new Set(["nba", "nfl", "wnba", "mlb", "football", "futbol"]);
const VALID_RESULTS = new Set(["win", "loss", "push", "pending"]);

let jsonWriteQueue = Promise.resolve();

function normalizeSport(sport) {
  const s = String(sport || "").trim().toLowerCase();
  return s === "futbol" ? "football" : s;
}

function round4(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

function isNearOrPastKickoff(gameDateIso) {
  if (!gameDateIso) return false;
  const kick = new Date(gameDateIso).getTime();
  if (!Number.isFinite(kick)) return false;
  const now = Date.now();
  const windowMs = 2 * 60 * 60 * 1000;
  return now >= kick - windowMs;
}

function buildPickRecord(input = {}) {
  const sport = normalizeSport(input.sport);
  const modelProbability = Number(input.modelProbability);
  const impliedProbability = Number(input.impliedProbability);
  const edge =
    input.edge != null
      ? Number(input.edge)
      : Number.isFinite(modelProbability) && Number.isFinite(impliedProbability)
        ? modelProbability - impliedProbability
        : null;

  return {
    id: input.id || randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
    sport,
    league: input.league ? String(input.league) : sport.toUpperCase(),
    gameId: String(input.gameId || ""),
    gameDate: input.gameDate || null,
    market: String(input.market || ""),
    pick: String(input.pick || ""),
    lineTaken: input.lineTaken != null ? Number(input.lineTaken) : null,
    oddsTaken: input.oddsTaken != null ? Number(input.oddsTaken) : null,
    modelProbability: Number.isFinite(modelProbability) ? modelProbability : null,
    impliedProbability: Number.isFinite(impliedProbability) ? impliedProbability : null,
    edge: round4(edge),
    ev: input.ev != null ? round4(input.ev) : null,
    confidence: input.confidence != null ? Number.parseInt(input.confidence, 10) : null,
    score: input.score != null ? Number.parseInt(input.score, 10) : null,
    dataQuality: input.dataQuality != null ? round4(input.dataQuality) : null,
    color: input.color === "verde" || input.color === "amarillo" ? input.color : "gris",
    factors_used: input.factors_used ?? {},
    line_movement: input.line_movement ?? null,
    market_anchor_applied: Boolean(input.market_anchor_applied),
    closingLine: input.closingLine ?? null,
    closingOdds: input.closingOdds ?? null,
    result: VALID_RESULTS.has(input.result) ? input.result : "pending",
    profitLoss: input.profitLoss ?? null,
    clv: input.clv ?? null,
  };
}

async function readJsonStore() {
  try {
    const raw = await readFile(JSON_STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJsonStore(rows) {
  await mkdir(path.dirname(JSON_STORE), { recursive: true });
  await writeFile(JSON_STORE, JSON.stringify(rows, null, 2), "utf8");
}

async function enqueueJsonWrite(fn) {
  jsonWriteQueue = jsonWriteQueue.then(fn).catch(fn);
  return jsonWriteQueue;
}

async function savePickPostgres(record) {
  const pool = getSharedDbPool();
  const day = String(record.createdAt).slice(0, 10);
  const existing = await pool.query(
    `
      SELECT id FROM picks_history
      WHERE sport = $1 AND game_id = $2 AND market = $3 AND pick = $4
        AND COALESCE(line_taken, -99999) = COALESCE($5::numeric, -99999)
        AND DATE(created_at AT TIME ZONE 'UTC') = $6::date
      LIMIT 1
    `,
    [record.sport, record.gameId, record.market, record.pick, record.lineTaken, day]
  );

  if (existing.rows.length) {
    const captureClosing = isNearOrPastKickoff(record.gameDate);
    const { rows } = await pool.query(
      `
        UPDATE picks_history SET
          odds_taken = $1,
          model_probability = $2,
          implied_probability = $3,
          edge = $4,
          ev = $5,
          confidence = $6,
          score = $7,
          data_quality = $8,
          color = $9,
          factors_used = $10,
          line_movement = $11,
          market_anchor_applied = $12,
          closing_line = CASE WHEN $14 THEN COALESCE($15, closing_line) ELSE closing_line END,
          closing_odds = CASE WHEN $14 THEN COALESCE($16, closing_odds) ELSE closing_odds END,
          updated_at = NOW()
        WHERE id = $13
        RETURNING *
      `,
      [
        record.oddsTaken,
        record.modelProbability,
        record.impliedProbability,
        record.edge,
        record.ev,
        record.confidence,
        record.score,
        record.dataQuality,
        record.color,
        JSON.stringify(record.factors_used || {}),
        record.line_movement ? JSON.stringify(record.line_movement) : null,
        record.market_anchor_applied,
        existing.rows[0].id,
        captureClosing,
        record.lineTaken,
        record.oddsTaken,
      ]
    );
    return mapDbRow(rows[0]);
  }

  const { rows } = await pool.query(
    `
      INSERT INTO picks_history (
        id, created_at, sport, league, game_id, game_date, market, pick,
        line_taken, odds_taken, model_probability, implied_probability, edge, ev,
        confidence, score, data_quality, color, factors_used, line_movement,
        market_anchor_applied, closing_line, closing_odds, result, profit_loss, clv
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
      )
      RETURNING *
    `,
    [
      record.id,
      record.createdAt,
      record.sport,
      record.league,
      record.gameId,
      record.gameDate,
      record.market,
      record.pick,
      record.lineTaken,
      record.oddsTaken,
      record.modelProbability,
      record.impliedProbability,
      record.edge,
      record.ev,
      record.confidence,
      record.score,
      record.dataQuality,
      record.color,
      JSON.stringify(record.factors_used || {}),
      record.line_movement ? JSON.stringify(record.line_movement) : null,
      record.market_anchor_applied,
      record.closingLine,
      record.closingOdds,
      record.result,
      record.profitLoss,
      record.clv,
    ]
  );
  return mapDbRow(rows[0]);
}

function mapDbRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    sport: row.sport,
    league: row.league,
    gameId: row.game_id,
    gameDate: row.game_date,
    market: row.market,
    pick: row.pick,
    lineTaken: row.line_taken != null ? Number(row.line_taken) : null,
    oddsTaken: row.odds_taken != null ? Number(row.odds_taken) : null,
    modelProbability: row.model_probability != null ? Number(row.model_probability) : null,
    impliedProbability: row.implied_probability != null ? Number(row.implied_probability) : null,
    edge: row.edge != null ? Number(row.edge) : null,
    ev: row.ev != null ? Number(row.ev) : null,
    confidence: row.confidence,
    score: row.score,
    dataQuality: row.data_quality != null ? Number(row.data_quality) : null,
    color: row.color,
    factors_used: row.factors_used,
    line_movement: row.line_movement,
    market_anchor_applied: row.market_anchor_applied,
    closingLine: row.closing_line != null ? Number(row.closing_line) : null,
    closingOdds: row.closing_odds != null ? Number(row.closing_odds) : null,
    result: row.result,
    profitLoss: row.profit_loss != null ? Number(row.profit_loss) : null,
    clv: row.clv != null ? Number(row.clv) : null,
  };
}

async function savePickJson(record) {
  return enqueueJsonWrite(async () => {
    const rows = await readJsonStore();
    const day = record.createdAt.slice(0, 10);
    const idx = rows.findIndex(
      (row) =>
        row.sport === record.sport &&
        row.gameId === record.gameId &&
        row.market === record.market &&
        row.pick === record.pick &&
        (row.lineTaken ?? null) === (record.lineTaken ?? null) &&
        String(row.createdAt || "").slice(0, 10) === day
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...record, id: rows[idx].id };
    else rows.push(record);
    await writeJsonStore(rows);
    return record;
  });
}

export async function savePick(input) {
  const record = buildPickRecord(input);
  if (!record.gameId || !record.market || !record.pick) {
    throw new Error("savePick: gameId, market y pick son obligatorios");
  }
  if (!VALID_SPORTS.has(record.sport)) {
    throw new Error(`savePick: sport invalido (${record.sport})`);
  }

  if (hasDatabaseConfig()) {
    try {
      return await savePickPostgres(record);
    } catch (error) {
      if (!String(error.message).includes("picks_history")) throw error;
      console.warn("[backtesting] PG picks_history no existe, usando JSON:", error.message);
    }
  }
  return savePickJson(record);
}

export function mapProPickToBacktestRecord(pick, game, sport, league = null) {
  const oddsTaken = pick.odds ?? pick.cuota ?? pick.mejor_cuota ?? pick.bestOdds ?? null;
  const gameDate = game.startTime || game.startIso || game.scheduleDate || game.date || game.hora || null;
  const homeName = game.homeName || game.home || game.homeTeam?.name || game.context?.homeName || "";
  const awayName = game.awayName || game.away || game.awayTeam?.name || game.context?.awayName || "";
  const fallbackGameId = [sport, gameDate, awayName, homeName].filter(Boolean).join("|");
  const probMarket =
    pick.prob_market ??
    pick.probMarket ??
    pick.impliedProbability ??
    (oddsTaken && oddsTaken > 1 ? 1 / oddsTaken : null);
  return {
    sport,
    league: league || game.league || sport.toUpperCase(),
    gameId: String(
      game.id ||
      game.eventId ||
      game.matchId ||
      game.oddsApiIoEventId ||
      game.context?.eventId ||
      pick.gameId ||
      pick.matchId ||
      fallbackGameId ||
      ""
    ),
    gameDate,
    market: pick.market || pick.marketKey || pick.type || pick.mercado || "unknown",
    pick: pick.side || pick.betSide || pick.pickSide || pick.pick_side || pick.selection || pick.seleccion || pick.pick_label,
    lineTaken: pick.line ?? pick.linea ?? null,
    oddsTaken,
    modelProbability: pick.prob_model ?? pick.modelProbability ?? null,
    impliedProbability: probMarket,
    edge: pick.edge ?? null,
    ev: pick.ev_model ?? pick.ev ?? pick.modelEv ?? null,
    confidence: pick.confidence ?? pick.confianza ?? null,
    score: pick.score ?? pick.score_final ?? null,
    dataQuality: pick.data_quality ?? null,
    color: pick.color ?? pick.estado ?? "gris",
    factors_used: pick.factors_used || [],
    line_movement: pick.line_movement ?? null,
    market_anchor_applied: Boolean(pick.market_anchor_applied ?? pick.anchor?.applied),
  };
}

export async function persistAnalyzerPicksFromMatches(matches, sport, mapFn) {
  let saved = 0;
  for (const match of matches || []) {
    const recs = (match.recommendations || match.picks || []).filter((p) => p?.bettable);
    for (const pick of recs) {
      try {
        await savePick(mapFn(pick, match, sport));
        saved += 1;
      } catch (error) {
        console.warn(`[backtesting] ${sport} savePick:`, error.message);
      }
    }
  }
  return saved;
}

export function mapFootballPickToBacktestRecord(pick, match, sport = "football") {
  const odds = Number(pick.cuota ?? pick.odds ?? pick.bookOdds);
  const implied = odds > 1 ? 1 / odds : null;
  const modelProb = pick.modelProbability ?? pick.prob_model ?? null;
  const espnEventId = match.espnEventId || match.insight?.eventId || null;
  return {
    sport: sport === "futbol" ? "football" : sport,
    league: match.leagueSlug || match.league || match.liga || "football",
    gameId: String(espnEventId || match.id || match.eventId || match.matchId || ""),
    gameDate: match.startTime || match.hora || match.date || null,
    market: pick.marketKey || pick.mercado || pick.market || "unknown",
    pick: pick.betSide || pick.side || pick.selection,
    lineTaken: pick.line ?? pick.linea ?? null,
    oddsTaken: odds,
    modelProbability: modelProb,
    impliedProbability: implied,
    edge: pick.edge ?? (modelProb != null && implied != null ? modelProb - implied : null),
    ev: pick.ev ?? pick.evRaw ?? pick.modelEv ?? null,
    confidence: pick.confianza ?? pick.confidence ?? null,
    score: pick.score ?? pick.score_total ?? null,
    dataQuality: pick.dataQuality ?? null,
    color: pick.estado === "verde" || pick.estado === "amarillo" ? pick.estado : pick.color,
    factors_used: {
      ...(pick.factors_used || pick.ctx || {}),
      home: match.home || match.homeTeam?.name,
      away: match.away || match.awayTeam?.name,
      leagueSlug: match.leagueSlug || null,
      espnEventId,
    },
    line_movement: pick.line_movement ?? pick.oddsDrop ?? null,
    market_anchor_applied: Boolean(pick.anchor?.applied),
  };
}

export function mapMlbPickToBacktestRecord(pick, game, sport = "mlb") {
  const odds = Number(pick.bookOdds ?? pick.odds ?? pick.cuota);
  return {
    sport,
    league: "MLB",
    gameId: String(game.id || pick.matchId || ""),
    gameDate: game.startTime || game.date || null,
    market: pick.marketKey || pick.type || pick.market,
    pick: pick.side || (pick.selection?.includes("Over") ? "over" : pick.selection?.includes("Under") ? "under" : "home"),
    lineTaken: pick.line ?? null,
    oddsTaken: odds,
    modelProbability: pick.modelProbability ?? null,
    impliedProbability: pick.impliedProbability ?? (odds > 1 ? 1 / odds : null),
    edge:
      pick.edge ??
      pick.edgePercent != null
        ? pick.edgePercent / 100
        : (pick.modelProbability != null && odds > 1 ? pick.modelProbability - 1 / odds : null),
    ev: pick.ev_model ?? pick.modelEv ?? pick.ev ?? null,
    confidence: pick.confidence ?? null,
    score: pick.score_final ?? pick.score?.total ?? pick.score ?? null,
    dataQuality: pick.data_quality ?? pick.dataQuality ?? null,
    color: pick.color ?? (pick.bettable ? "verde" : "gris"),
    factors_used: pick.factors_used || {},
    line_movement: pick.line_movement ?? null,
    market_anchor_applied: Boolean(pick.anchor?.applied),
  };
}

export async function persistPolicyPicks(game, picks, sport, league = null) {
  const minConfidence = getMinRecommendationConfidence(sport);
  const bettable = (picks || []).filter(
    (p) => p?.bettable && p.color !== "gris" && passesRecommendationConfidence(p.confidence ?? p.confianza, minConfidence)
  );
  const saved = [];
  for (const pick of bettable) {
    try {
      const row = await savePick(mapProPickToBacktestRecord(pick, game, sport, league));
      saved.push(row);
    } catch (error) {
      console.warn("[backtesting] savePick error:", error.message);
    }
  }
  return saved;
}

function profitLossFromResult(result, oddsTaken) {
  const odds = Number(oddsTaken);
  if (result === "win") return Number.isFinite(odds) ? odds - 1 : 1;
  if (result === "loss") return -1;
  return 0;
}

function clvFromOdds(oddsTaken, closingOdds) {
  const taken = Number(oddsTaken);
  const close = Number(closingOdds);
  if (!Number.isFinite(taken) || !Number.isFinite(close)) return null;
  return round4(close - taken);
}

function clvFromLines({ side, lineTaken, closingLine, oddsTaken, closingOdds }) {
  const takenLine = Number(lineTaken);
  const closeLine = Number(closingLine);
  if (Number.isFinite(takenLine) && Number.isFinite(closeLine) && side) {
    if (side === "over") return round4(closeLine - takenLine);
    if (side === "under") return round4(takenLine - closeLine);
  }
  return clvFromOdds(oddsTaken, closingOdds);
}

export async function updateResult(gameId, market, result, closingLine = null, closingOdds = null) {
  const normalizedResult = String(result).toLowerCase();
  if (!["win", "loss", "push"].includes(normalizedResult)) {
    throw new Error(`updateResult: result invalido (${result})`);
  }

  if (hasDatabaseConfig()) {
    try {
      const pool = getSharedDbPool();
      const pending = await pool.query(
        `SELECT * FROM picks_history WHERE game_id = $1 AND market = $2 AND result = 'pending'`,
        [String(gameId), String(market)]
      );
      const updated = [];
      for (const row of pending.rows) {
        const pl = profitLossFromResult(normalizedResult, row.odds_taken);
        const clv = clvFromLines({
          side: row.pick,
          lineTaken: row.line_taken,
          closingLine: closingLine ?? row.closing_line,
          oddsTaken: row.odds_taken,
          closingOdds,
        });
        const { rows } = await pool.query(
          `
            UPDATE picks_history
            SET result = $1,
                profit_loss = $2,
                clv = $3,
                closing_line = COALESCE($4, closing_line),
                closing_odds = COALESCE($5, closing_odds),
                updated_at = NOW()
            WHERE id = $6
            RETURNING *
          `,
          [normalizedResult, pl, clv, closingLine, closingOdds, row.id]
        );
        updated.push(mapDbRow(rows[0]));
      }
      return updated;
    } catch (error) {
      if (!String(error.message).includes("picks_history")) throw error;
    }
  }

  return enqueueJsonWrite(async () => {
    const rows = await readJsonStore();
    const updated = [];
    for (const row of rows) {
      if (row.gameId !== String(gameId) || row.market !== String(market) || row.result !== "pending") {
        continue;
      }
      row.result = normalizedResult;
      row.profitLoss = profitLossFromResult(normalizedResult, row.oddsTaken);
      row.clv = clvFromLines({
        side: row.pick,
        lineTaken: row.lineTaken,
        closingLine: closingLine ?? row.closingLine,
        oddsTaken: row.oddsTaken,
        closingOdds,
      });
      if (closingLine != null) row.closingLine = closingLine;
      if (closingOdds != null) row.closingOdds = closingOdds;
      updated.push(row);
    }
    await writeJsonStore(rows);
    return updated;
  });
}

function filterPicks(all, filters = {}) {
  let rows = [...all];
  if (filters.sport) rows = rows.filter((r) => normalizeSport(r.sport) === normalizeSport(filters.sport));
  if (filters.league) rows = rows.filter((r) => String(r.league).toLowerCase() === String(filters.league).toLowerCase());
  if (filters.market) rows = rows.filter((r) => r.market === filters.market);
  if (filters.color) rows = rows.filter((r) => r.color === filters.color);
  if (filters.minConfidence != null) {
    rows = rows.filter((r) => (r.confidence ?? 0) >= Number(filters.minConfidence));
  }
  if (filters.dateFrom) {
    rows = rows.filter((r) => String(r.createdAt || "").slice(0, 10) >= String(filters.dateFrom).slice(0, 10));
  }
  if (filters.dateTo) {
    rows = rows.filter((r) => String(r.createdAt || "").slice(0, 10) <= String(filters.dateTo).slice(0, 10));
  }
  if (filters.result) rows = rows.filter((r) => r.result === filters.result);
  return rows;
}

function computeStatsBundle(picks) {
  const resolved = picks.filter((p) => ["win", "loss", "push"].includes(p.result));
  const wins = resolved.filter((p) => p.result === "win").length;
  const losses = resolved.filter((p) => p.result === "loss").length;
  const pushes = resolved.filter((p) => p.result === "push").length;
  const profitTotal = resolved.reduce((sum, p) => sum + (Number(p.profitLoss) || 0), 0);
  const stakes = resolved.length;
  const clvValues = resolved.map((p) => p.clv).filter((v) => v != null);
  const evValues = picks.map((p) => p.ev).filter((v) => v != null);

  return {
    totalPicks: picks.length,
    wins,
    losses,
    pushes,
    hitRate: wins + losses > 0 ? round4(wins / (wins + losses)) : null,
    roi: stakes > 0 ? round4((profitTotal / stakes) * 100) : null,
    yield: stakes > 0 ? round4((profitTotal / stakes) * 100) : null,
    profitLoss_total: round4(profitTotal),
    clv_medio: clvValues.length ? round4(clvValues.reduce((a, b) => a + b, 0) / clvValues.length) : null,
    ev_medio: evValues.length ? round4(evValues.reduce((a, b) => a + b, 0) / evValues.length) : null,
    ev_realizado: stakes > 0 ? round4(profitTotal / stakes) : null,
  };
}

function calibrationBuckets(picks) {
  const buckets = [
    [0.5, 0.55],
    [0.55, 0.6],
    [0.6, 0.65],
    [0.65, 0.7],
    [0.7, 0.75],
    [0.75, 1.01],
  ];
  return buckets.map(([lo, hi]) => {
    const bucket = picks.filter((p) => {
      const prob = Number(p.modelProbability);
      return Number.isFinite(prob) && prob >= lo && prob < hi && p.result !== "pending";
    });
    const wins = bucket.filter((p) => p.result === "win").length;
    const total = bucket.filter((p) => p.result === "win" || p.result === "loss").length;
    return {
      range: `${lo.toFixed(2)}-${hi === 1.01 ? "1.00" : hi.toFixed(2)}`,
      n: total,
      predicted_avg: bucket.length
        ? round4(bucket.reduce((s, p) => s + Number(p.modelProbability), 0) / bucket.length)
        : null,
      hitRate: total > 0 ? round4(wins / total) : null,
    };
  });
}

async function loadAllPicks() {
  if (hasDatabaseConfig()) {
    try {
      const { rows } = await getSharedDbPool().query(`SELECT * FROM picks_history ORDER BY created_at DESC`);
      return rows.map(mapDbRow);
    } catch (error) {
      if (!String(error.message).includes("picks_history")) throw error;
    }
  }
  return readJsonStore();
}

export async function getStats(filters = {}) {
  const all = await loadAllPicks();
  const picks = filterPicks(all, filters);
  const base = computeStatsBundle(picks);

  const byMarket = {};
  for (const market of [...new Set(picks.map((p) => p.market))]) {
    byMarket[market] = computeStatsBundle(picks.filter((p) => p.market === market));
  }

  const bySport = {};
  for (const sport of [...new Set(picks.map((p) => p.sport))]) {
    bySport[sport] = computeStatsBundle(picks.filter((p) => normalizeSport(p.sport) === sport));
  }

  return {
    ...base,
    verde: computeStatsBundle(picks.filter((p) => p.color === "verde")),
    amarillo: computeStatsBundle(picks.filter((p) => p.color === "amarillo")),
    by_market: byMarket,
    by_market_type: aggregateStatsByMarketType(byMarket),
    by_sport: bySport,
    calibration: calibrationBuckets(picks),
    filters,
    storage: hasDatabaseConfig() ? "postgresql" : "json",
  };
}

export async function getCalibrationReport(filters = {}) {
  const picks = filterPicks(await loadAllPicks(), filters);
  const resolved = picks.filter((pick) => pick.result === "win" || pick.result === "loss");
  const evRanges = [
    { label: "3-5%", min: 0.03, max: 0.05 },
    { label: "5-8%", min: 0.05, max: 0.08 },
    { label: "8%+", min: 0.08, max: Infinity },
  ];

  const byEvRange = evRanges.map((range) => {
    const bucket = resolved.filter((pick) => {
      const ev = Number(pick.ev);
      return Number.isFinite(ev) && ev >= range.min && ev < range.max;
    });
    const wins = bucket.filter((pick) => pick.result === "win").length;
    const profit = bucket.reduce((sum, pick) => sum + (Number(pick.profitLoss) || 0), 0);
    return {
      evRange: range.label,
      picks: bucket.length,
      hitRate: bucket.length ? round4(wins / bucket.length) : null,
      roi: bucket.length ? round4(profit / bucket.length) : null,
    };
  });

  const clvValues = resolved.map((pick) => pick.clv).filter((value) => value != null);
  const profitTotal = resolved.reduce((sum, pick) => sum + (Number(pick.profitLoss) || 0), 0);

  return {
    byEvRange,
    clvMedio: clvValues.length
      ? round4(clvValues.reduce((sum, value) => sum + Number(value), 0) / clvValues.length)
      : null,
    roi: resolved.length ? round4(profitTotal / resolved.length) : null,
    roiPct: resolved.length ? round4((profitTotal / resolved.length) * 100) : null,
    picks: resolved.length,
    filters,
  };
}

export async function getCLVReport(filters = {}) {
  const all = filterPicks(await loadAllPicks(), filters);
  const withClv = all.filter((p) => p.clv != null);
  const positive = withClv.filter((p) => Number(p.clv) > 0);

  const bySport = {};
  for (const sport of [...new Set(withClv.map((p) => p.sport))]) {
    const subset = withClv.filter((p) => p.sport === sport);
    bySport[sport] = {
      clv_medio: subset.length ? round4(subset.reduce((s, p) => s + p.clv, 0) / subset.length) : null,
      pct_positivo: subset.length ? round4(positive.filter((p) => p.sport === sport).length / subset.length) : null,
      n: subset.length,
    };
  }

  const byMarket = {};
  for (const market of [...new Set(withClv.map((p) => p.market))]) {
    const subset = withClv.filter((p) => p.market === market);
    byMarket[market] = {
      clv_medio: subset.length ? round4(subset.reduce((s, p) => s + p.clv, 0) / subset.length) : null,
      n: subset.length,
    };
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const last30 = withClv.filter((p) => new Date(p.createdAt) >= cutoff);
  const trend30 = {};
  for (const row of last30) {
    const day = String(row.createdAt).slice(0, 10);
    if (!trend30[day]) trend30[day] = [];
    trend30[day].push(row.clv);
  }
  const clvTrend30Days = Object.entries(trend30)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      clv_medio: round4(values.reduce((a, b) => a + b, 0) / values.length),
      n: values.length,
    }));

  return {
    clv_medio_global: withClv.length ? round4(withClv.reduce((s, p) => s + p.clv, 0) / withClv.length) : null,
    pct_clv_positivo: withClv.length ? round4(positive.length / withClv.length) : null,
    by_sport: bySport,
    by_market: byMarket,
    clv_trend_30d: clvTrend30Days,
    n: withClv.length,
  };
}
