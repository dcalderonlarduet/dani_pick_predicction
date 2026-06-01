import { existsSync } from "node:fs";
import pg from "pg";
import { getMadridTodayDateString } from "../utils/madrid-date.js";
import { isPickExplicitlyLive, normalizeHourLabel } from "../utils/pick-timing.js";

const { Pool } = pg;

let pool = null;

function isRunningInDocker() {
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

function normalizeDatabaseHost(value) {
  const text = String(value || "").trim();
  if (!text || !isRunningInDocker()) return text;
  if (text === "localhost" || text === "127.0.0.1") return "postgres";
  return text.replace(/@(localhost|127\.0\.0\.1)(?=[:/])/g, "@postgres");
}

function normalizeConnectionString(connectionString) {
  return normalizeDatabaseHost(connectionString);
}

export function hasDatabaseConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER
  );
}

function getSslConfig() {
  return process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false;
}

function buildPoolConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: normalizeConnectionString(process.env.DATABASE_URL),
      ssl: getSslConfig(),
      max: 6,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    };
  }

  if (!hasDatabaseConfig()) {
    return null;
  }

  return {
    host: normalizeDatabaseHost(process.env.PGHOST || "localhost"),
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "danypicks",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    ssl: getSslConfig(),
    max: 6,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

export function getSharedDbPool() {
  return getPool();
}

function getPool() {
  if (pool) return pool;

  const config = buildPoolConfig();
  if (!config) {
    throw new Error("PostgreSQL no configurado. Define DATABASE_URL o variables PG*.");
  }

  pool = new Pool(config);
  pool.on("error", (error) => {
    console.error("[picks-db] Pool error:", error.message);
  });
  return pool;
}

function coerceMoney(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : fallback;
}

function coerceInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePickDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "");
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function getMadridTimeString(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function isValidHourLabel(value) {
  return Boolean(normalizeHourLabel(value));
}

export function getPendingPickTimingMeta(pick, now = new Date()) {
  const pickDateRaw = normalizePickDateKey(pick?.pick_date);
  const horaPartido = normalizeHourLabel(pick?.hora_partido) || "";
  const todayMadrid = getMadridTodayDateString(now);
  const currentTimeMadrid = getMadridTimeString(now);

  let started = false;
  if (pickDateRaw) {
    if (pickDateRaw < todayMadrid) {
      started = true;
    } else if (pickDateRaw === todayMadrid) {
      started = horaPartido ? horaPartido <= currentTimeMadrid : false;
    }
  }

  return {
    started,
    can_remove: !started,
    lock_reason: started ? "El partido ya empezó o está en juego." : null,
  };
}

export function getPendingPickTimingMetaLive(pick, now = new Date()) {
  const base = getPendingPickTimingMeta(pick, now);
  const live = isPickExplicitlyLive(pick);

  return {
    ...base,
    live,
    lock_reason: live ? "El partido esta en vivo." : base.lock_reason,
  };
}

function requirePickFields(payload) {
  const missing = [];
  if (!payload.pick_date) missing.push("pick_date");
  if (!payload.sport) missing.push("sport");
  if (!payload.partido) missing.push("partido");
  if (!payload.pick_label) missing.push("pick_label");

  if (missing.length) {
    throw new Error(`Faltan campos requeridos: ${missing.join(", ")}`);
  }
}

export async function waitForDatabase(maxAttempts = 12, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const health = await dbHealthCheck({ resetPoolOnFailure: attempt < maxAttempts });
    if (health.ok) return health;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return dbHealthCheck();
}

export async function dbHealthCheck({ resetPoolOnFailure = false } = {}) {
  if (!hasDatabaseConfig()) {
    return {
      ok: false,
      configured: false,
      error: "PostgreSQL no configurado",
    };
  }

  try {
    const { rows } = await getPool().query("SELECT NOW() AS now");
    return {
      ok: true,
      configured: true,
      timestamp: rows[0]?.now ?? new Date().toISOString(),
    };
  } catch (error) {
    if (resetPoolOnFailure && pool) {
      try {
        await pool.end();
      } catch {
        // ignore pool shutdown errors during retry
      }
      pool = null;
    }
    return {
      ok: false,
      configured: true,
      error: error?.message || String(error) || "connection_failed",
    };
  }
}

export async function savePick(payload) {
  requirePickFields(payload);

  const pickDate = String(payload.pick_date).trim();
  const sport = String(payload.sport).trim().toLowerCase();
  const partido = String(payload.partido).trim();
  const pickLabel = String(payload.pick_label).trim();
  const mercado = payload.mercado ? String(payload.mercado).trim() : null;

  const duplicateQuery = `
    SELECT *
    FROM picks
    WHERE pick_date = $1
      AND sport = $2
      AND lower(trim(partido)) = lower(trim($3))
      AND lower(trim(pick_label)) = lower(trim($4))
      AND coalesce(lower(trim(mercado)), '') = coalesce(lower(trim($5)), '')
      AND resultado = 'pendiente'
    ORDER BY id DESC
    LIMIT 1
  `;

  const duplicateResult = await getPool().query(duplicateQuery, [
    pickDate,
    sport,
    partido,
    pickLabel,
    mercado,
  ]);

  if (duplicateResult.rows.length) {
    const existing = duplicateResult.rows[0];
    const newTier = String(payload.estado_color || "verde").trim().toLowerCase();
    const oldTier = String(existing.estado_color || "").trim().toLowerCase();
    const tierUpgraded = oldTier === "amarillo" && newTier === "verde";
    const tierDowngraded = oldTier === "verde" && newTier === "amarillo";
    const tierChange = tierUpgraded
      ? "amarillo_to_verde"
      : tierDowngraded
        ? "verde_to_amarillo"
        : null;

    const shouldUpdate =
      tierUpgraded ||
      tierDowngraded ||
      (payload.hora_partido && String(payload.hora_partido).trim() !== String(existing.hora_partido || "").trim()) ||
      (payload.cuota != null && Number(payload.cuota) !== Number(existing.cuota)) ||
      (payload.confianza != null && Number(payload.confianza) !== Number(existing.confianza)) ||
      (payload.ev_pct != null && Number(payload.ev_pct) !== Number(existing.ev_pct)) ||
      (payload.casa && String(payload.casa).trim() !== String(existing.casa || "").trim());

    if (!shouldUpdate) {
      return {
        created: false,
        tierUpgraded: false,
        dataEnriched: false,
        pick: existing,
      };
    }

    const { rows } = await getPool().query(
      `
        UPDATE picks
        SET estado_color = $1,
            cuota = COALESCE($2, cuota),
            casa = COALESCE($3, casa),
            ev_pct = COALESCE($4, ev_pct),
            confianza = COALESCE($5, confianza),
            hora_partido = COALESCE($6, hora_partido),
            notas = COALESCE($7, notas),
            updated_at = NOW()
        WHERE id = $8
        RETURNING *
      `,
      [
        newTier,
        payload.cuota != null ? coerceMoney(payload.cuota, null) : null,
        payload.casa ? String(payload.casa).trim() : null,
        payload.ev_pct != null ? coerceMoney(payload.ev_pct, null) : null,
        coerceInt(payload.confianza, null),
        payload.hora_partido ? String(payload.hora_partido).trim() : null,
        payload.notas ? String(payload.notas).trim() : null,
        existing.id,
      ]
    );

    const updated = rows[0];
    const { getPickCompletenessScore, normalizePickForTelegram } = await import("./telegram-notifier.js");
    const oldScore = getPickCompletenessScore(normalizePickForTelegram(existing));
    const newScore = getPickCompletenessScore(normalizePickForTelegram(updated));
    const dataEnriched = !tierUpgraded && !tierDowngraded && newScore > oldScore;

    return {
      created: false,
      tierUpgraded,
      tierDowngraded,
      tierChange,
      previousPick: tierChange ? existing : null,
      dataEnriched,
      pick: updated,
    };
  }

  const values = [
    pickDate,
    sport,
    partido,
    pickLabel,
    mercado,
    payload.cuota != null ? coerceMoney(payload.cuota, null) : null,
    payload.casa ? String(payload.casa).trim() : null,
    payload.ev_pct != null ? coerceMoney(payload.ev_pct, null) : null,
    coerceInt(payload.confianza, null),
    payload.estado_color ? String(payload.estado_color).trim().toLowerCase() : "verde",
    Boolean(payload.senal_doble),
    coerceMoney(payload.stake, 10),
    payload.hora_partido ? String(payload.hora_partido).trim() : null,
    payload.liga ? String(payload.liga).trim() : null,
    payload.notas ? String(payload.notas).trim() : null,
    payload.prob_model != null ? Number(payload.prob_model) : null,
    payload.linea_apuesta != null ? coerceMoney(payload.linea_apuesta, null) : null,
    payload.edge_pct != null ? Number(payload.edge_pct) : null,
    payload.data_quality != null ? Number(payload.data_quality) : null,
    payload.pick_side ? String(payload.pick_side).trim() : null,
    payload.market_key ? String(payload.market_key).trim() : null,
    payload.ev_model != null ? Number(payload.ev_model) : null,
  ];

  const insertQueryExtended = `
    INSERT INTO picks (
      pick_date, sport, partido, pick_label, mercado, cuota, casa, ev_pct, confianza,
      estado_color, senal_doble, stake, resultado, hora_partido, liga, notas,
      prob_model, linea_apuesta, edge_pct, data_quality, pick_side, market_key, ev_model
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
    )
    RETURNING *
  `;

  const insertQueryLegacy = `
    INSERT INTO picks (
      pick_date,
      sport,
      partido,
      pick_label,
      mercado,
      cuota,
      casa,
      ev_pct,
      confianza,
      estado_color,
      senal_doble,
      stake,
      resultado,
      hora_partido,
      liga,
      notas
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente',$13,$14,$15
    )
    RETURNING *
  `;

  let rows;
  try {
    ({ rows } = await getPool().query(insertQueryExtended, values));
  } catch (error) {
    if (!String(error.message || "").includes("column")) throw error;
    ({ rows } = await getPool().query(insertQueryLegacy, values.slice(0, 15)));
  }
  return {
    created: true,
    tierUpgraded: false,
    dataEnriched: false,
    pick: rows[0],
  };
}

export async function updatePickResult(id, resultado, cuotaReal) {
  if (!["ganado", "perdido", "void"].includes(resultado)) {
    throw new Error(`Resultado invalido: ${resultado}`);
  }

  const existing = await getPool().query(
    "SELECT id, stake, cuota, resultado FROM picks WHERE id = $1",
    [id]
  );

  if (!existing.rows.length) {
    throw new Error(`Pick ${id} no encontrado`);
  }

  const current = existing.rows[0];
  if (current.resultado && current.resultado !== "pendiente") {
    throw new Error(`El pick ${id} ya fue resuelto como ${current.resultado}`);
  }

  const stake = coerceMoney(current.stake, 0);
  const finalOdds = coerceMoney(cuotaReal ?? current.cuota, 1);
  const gananciaNeta =
    resultado === "ganado"
      ? coerceMoney(stake * (finalOdds - 1), 0)
      : resultado === "perdido"
        ? coerceMoney(-stake, 0)
        : 0;

  const updateResult = await getPool().query(
    `
      UPDATE picks
      SET resultado = $1,
          ganancia_neta = $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `,
    [resultado, gananciaNeta, id]
  );

  if (resultado !== "void") {
    await getPool().query(
      `
        UPDATE bankroll
        SET bankroll_actual = bankroll_actual + $1,
            updated_at = NOW()
        WHERE id = (SELECT id FROM bankroll ORDER BY id LIMIT 1)
      `,
      [gananciaNeta]
    );
  }

  const resolvedPick = updateResult.rows[0];
  const { clearTelegramFlagsForPick } = await import("./pick-telegram-flags.js");
  await clearTelegramFlagsForPick(resolvedPick.id);

  return resolvedPick;
}

export async function correctPickResult(id, resultado, cuotaReal) {
  if (!["ganado", "perdido", "void"].includes(resultado)) {
    throw new Error(`Resultado invalido: ${resultado}`);
  }

  const existing = await getPool().query(
    "SELECT id, stake, cuota, resultado, ganancia_neta FROM picks WHERE id = $1",
    [id]
  );

  if (!existing.rows.length) {
    throw new Error(`Pick ${id} no encontrado`);
  }

  const current = existing.rows[0];
  if (!current.resultado || current.resultado === "pendiente") {
    throw new Error(`Pick ${id} aun no ha sido resuelto — usa el endpoint normal`);
  }

  const prevGanancia = coerceMoney(current.ganancia_neta, 0);
  const stake = coerceMoney(current.stake, 0);
  const finalOdds = coerceMoney(cuotaReal ?? current.cuota, 1);
  const newGanancia =
    resultado === "ganado"
      ? coerceMoney(stake * (finalOdds - 1), 0)
      : resultado === "perdido"
        ? coerceMoney(-stake, 0)
        : 0;

  const updateResult = await getPool().query(
    `UPDATE picks SET resultado = $1, ganancia_neta = $2, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [resultado, newGanancia, id]
  );

  const bankrollDelta = newGanancia - prevGanancia;
  if (bankrollDelta !== 0) {
    await getPool().query(
      `UPDATE bankroll SET bankroll_actual = bankroll_actual + $1, updated_at = NOW()
       WHERE id = (SELECT id FROM bankroll ORDER BY id LIMIT 1)`,
      [bankrollDelta]
    );
  }

  return updateResult.rows[0];
}

export async function getPicks({ date, sport, resultado, limit = 100 } = {}) {
  const conditions = [];
  const values = [];

  if (date) {
    conditions.push(`pick_date = $${values.length + 1}`);
    values.push(date);
  }

  if (sport) {
    conditions.push(`sport = $${values.length + 1}`);
    values.push(sport);
  }

  if (resultado) {
    conditions.push(`resultado = $${values.length + 1}`);
    values.push(resultado);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(Number(limit) || 100);

  const { rows } = await getPool().query(
    `
      SELECT *
      FROM picks
      ${where}
      ORDER BY pick_date DESC, created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return rows;
}

export async function getPendingToday(madridDate) {
  const query = madridDate
    ? `
      SELECT *
      FROM picks
      WHERE pick_date = $1
        AND resultado = 'pendiente'
      ORDER BY pick_date DESC, hora_partido NULLS LAST, created_at DESC
    `
    : `
      SELECT *
      FROM picks
      WHERE resultado = 'pendiente'
      ORDER BY pick_date DESC, hora_partido NULLS LAST, created_at DESC
    `;
  const values = madridDate ? [madridDate] : [];
  const { rows } = await getPool().query(query, values);

  return rows;
}

export async function getStats() {
  const todayDate = getMadridTodayDateString();
  const [globalResult, sportResult, dailyResult, bankrollResult, resolvedTodayResult] = await Promise.all([
    getPool().query(`
      SELECT
        COUNT(*) AS total_picks,
        COUNT(*) FILTER (WHERE resultado = 'ganado') AS ganados,
        COUNT(*) FILTER (WHERE resultado = 'perdido') AS perdidos,
        COUNT(*) FILTER (WHERE resultado = 'pendiente') AS pendientes,
        COUNT(*) FILTER (WHERE resultado = 'void') AS voids,
        ROUND(
          COUNT(*) FILTER (WHERE resultado = 'ganado')::NUMERIC /
          NULLIF(COUNT(*) FILTER (WHERE resultado IN ('ganado', 'perdido')), 0) * 100,
          1
        ) AS pct_acierto,
        COALESCE(SUM(ganancia_neta), 0) AS ganancia_neta_total,
        COALESCE(
          SUM(stake) FILTER (WHERE resultado NOT IN ('void', 'pendiente')),
          0
        ) AS total_apostado,
        ROUND(
          COALESCE(SUM(ganancia_neta), 0) /
          NULLIF(COALESCE(SUM(stake) FILTER (WHERE resultado NOT IN ('void', 'pendiente')), 0), 0) * 100,
          2
        ) AS roi_pct,
        MIN(pick_date) AS primera_fecha,
        MAX(pick_date) AS ultima_fecha
      FROM picks
    `),
    getPool().query(`
      SELECT
        sport,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE resultado = 'ganado') AS ganados,
        COUNT(*) FILTER (WHERE resultado = 'perdido') AS perdidos,
        ROUND(
          COUNT(*) FILTER (WHERE resultado = 'ganado')::NUMERIC /
          NULLIF(COUNT(*) FILTER (WHERE resultado IN ('ganado', 'perdido')), 0) * 100,
          1
        ) AS pct_acierto,
        COALESCE(SUM(ganancia_neta), 0) AS ganancia_neta,
        ROUND(
          COALESCE(SUM(ganancia_neta), 0) /
          NULLIF(COALESCE(SUM(stake) FILTER (WHERE resultado NOT IN ('void', 'pendiente')), 0), 0) * 100,
          2
        ) AS roi_pct
      FROM picks
      WHERE resultado != 'pendiente'
      GROUP BY sport
      ORDER BY ganancia_neta DESC, total DESC
    `),
    getPool().query(`
      SELECT *
      FROM resumen_diario
      WHERE pick_date >= ($1::date - INTERVAL '6 days')
        AND pick_date <= $1::date
      ORDER BY pick_date DESC
    `,
      [todayDate]
    ),
    getPool().query("SELECT * FROM bankroll ORDER BY id LIMIT 1"),
    getPool().query(
      `
      SELECT id, sport, partido, pick_label, cuota, casa, resultado, ganancia_neta, pick_date, hora_partido, liga
      FROM picks
      WHERE pick_date = $1
        AND resultado IN ('ganado', 'perdido')
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 40
    `,
      [todayDate]
    ),
  ]);

  const global = globalResult.rows[0] || {};
  const bankroll = bankrollResult.rows[0] || {
    bankroll_inicial: 0,
    bankroll_actual: 0,
    stake_default: 10,
  };

  return {
    bankroll: {
      inicial: Number(bankroll.bankroll_inicial || 0),
      actual: Number(bankroll.bankroll_actual || 0),
      diferencia: Number(bankroll.bankroll_actual || 0) - Number(bankroll.bankroll_inicial || 0),
      rentabilidad_pct:
        Number(bankroll.bankroll_inicial || 0) > 0
          ? Number((((Number(bankroll.bankroll_actual || 0) - Number(bankroll.bankroll_inicial || 0)) / Number(bankroll.bankroll_inicial || 0)) * 100).toFixed(2))
          : 0,
      stake_default: Number(bankroll.stake_default || 10),
      stake_tipo: bankroll.stake_tipo || "fijo",
    },
    global: {
      total_picks: Number(global.total_picks || 0),
      ganados: Number(global.ganados || 0),
      perdidos: Number(global.perdidos || 0),
      pendientes: Number(global.pendientes || 0),
      voids: Number(global.voids || 0),
      pct_acierto: Number(global.pct_acierto || 0),
      ganancia_neta_total: Number(global.ganancia_neta_total || 0),
      total_apostado: Number(global.total_apostado || 0),
      roi_pct: Number(global.roi_pct || 0),
      primera_fecha: global.primera_fecha || null,
      ultima_fecha: global.ultima_fecha || null,
    },
    por_deporte: sportResult.rows.map((row) => ({
      sport: row.sport,
      total: Number(row.total || 0),
      ganados: Number(row.ganados || 0),
      perdidos: Number(row.perdidos || 0),
      pct_acierto: Number(row.pct_acierto || 0),
      ganancia_neta: Number(row.ganancia_neta || 0),
      roi_pct: Number(row.roi_pct || 0),
    })),
    ultimos_7_dias: dailyResult.rows.map((row) => ({
      fecha: row.pick_date,
      total: Number(row.total_picks || 0),
      ganados: Number(row.ganados || 0),
      perdidos: Number(row.perdidos || 0),
      pendientes: Number(row.pendientes || 0),
      pct_acierto: Number(row.pct_acierto || 0),
      ganancia_dia: Number(row.ganancia_neta_dia || 0),
      roi_dia: Number(row.roi_pct || 0),
    })),
    resueltos_hoy: resolvedTodayResult.rows.map((row) => ({
      id: row.id,
      sport: row.sport,
      partido: row.partido,
      pick_label: row.pick_label,
      cuota: row.cuota != null ? Number(row.cuota) : null,
      casa: row.casa,
      resultado: row.resultado,
      ganancia_neta: row.ganancia_neta != null ? Number(row.ganancia_neta) : 0,
      pick_date: row.pick_date,
      hora_partido: row.hora_partido,
      liga: row.liga,
    })),
  };
}

export async function updateBankroll({ bankroll_inicial, stake_default, stake_tipo } = {}) {
  const currentResult = await getPool().query("SELECT * FROM bankroll ORDER BY id LIMIT 1");
  const current = currentResult.rows[0];

  if (!current) {
    throw new Error("No existe configuracion de bankroll");
  }

  const nextInitial =
    bankroll_inicial != null ? coerceMoney(bankroll_inicial, Number(current.bankroll_inicial)) : Number(current.bankroll_inicial);
  const nextStake = stake_default != null ? coerceMoney(stake_default, Number(current.stake_default)) : Number(current.stake_default);
  const nextStakeType = stake_tipo ? String(stake_tipo).trim().toLowerCase() : current.stake_tipo;

  const currentInitial = Number(current.bankroll_inicial);
  const currentActual = Number(current.bankroll_actual);
  const nextActual =
    bankroll_inicial != null && currentActual === currentInitial
      ? nextInitial
      : currentActual;

  const { rows } = await getPool().query(
    `
      UPDATE bankroll
      SET bankroll_inicial = $1,
          bankroll_actual = $2,
          stake_default = $3,
          stake_tipo = $4,
          updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `,
    [nextInitial, nextActual, nextStake, nextStakeType, current.id]
  );

  return rows[0];
}

export async function deletePendingPick(id) {
  const existing = await getPool().query(
    `
      SELECT *
      FROM picks
      WHERE id = $1
        AND resultado = 'pendiente'
      LIMIT 1
    `,
    [id]
  );

  if (!existing.rows.length) {
    return null;
  }

  const timing = getPendingPickTimingMetaLive(existing.rows[0]);
  if (!timing.can_remove) {
    throw new Error(timing.lock_reason || "No se puede quitar un pick iniciado.");
  }

  const { rows } = await getPool().query(
    `
      DELETE FROM picks
      WHERE id = $1
        AND resultado = 'pendiente'
      RETURNING id
    `,
    [id]
  );

  return rows[0] || null;
}

export function normalizeTrackedMatchKey(value) {
  return normalizeText(value).replace(/@/g, "vs");
}
