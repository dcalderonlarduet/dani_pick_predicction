import fs from "node:fs";
import path from "node:path";
import { getTelegramSentState, markTelegramSent } from "./pick-telegram-flags.js";
import { buildPickIdentityKey, getPickDateKey } from "../utils/pick-identity.js";
import {
  buildRelativeScheduleTagForPick,
  isPickEligibleForTelegram,
  resolvePickHourLabel,
  resolvePickStartIso,
} from "../utils/pick-timing.js";

const TELEGRAM_SEND_LOCKS = new Map();
const QUINIELA_SENT_FILE = path.join(process.cwd(), ".quiniela-jornadas-sent.json");
const DAILY_BALANCE_SENT_FILE = path.join(process.cwd(), ".telegram-daily-balance-sent.json");

function buildQuinielaProposalFingerprint({
  propuesta = [],
  propuestaMinima = [],
  plenoPick = "",
} = {}) {
  const modelo = propuesta
    .slice(0, 14)
    .map((row) => `${row.order}|${String(row.pick || "").toUpperCase()}|${String(row.tipo || "").toLowerCase()}`)
    .join(";");
  const minimo = propuestaMinima
    .slice(0, 14)
    .map((row) => `${row.order}|${String(row.pick || "").toUpperCase()}`)
    .join(";");
  return `${modelo}::${minimo}::${String(plenoPick || "")}`;
}

function formatQuinielaEurTelegram(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${n.toFixed(2).replace(".", ",")} €`;
}

function loadQuinielaSentState() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUINIELA_SENT_FILE, "utf8"));
    if (Array.isArray(raw)) {
      const migrated = {};
      for (const key of raw) migrated[String(key)] = { fingerprint: null, sentAt: null };
      return migrated;
    }
    if (raw && typeof raw === "object") return raw;
  } catch {
    // archivo ausente o corrupto
  }
  return {};
}

function persistQuinielaSentState(lockKey, fingerprint) {
  try {
    const existing = loadQuinielaSentState();
    existing[String(lockKey)] = {
      fingerprint,
      sentAt: new Date().toISOString(),
    };
    fs.writeFileSync(QUINIELA_SENT_FILE, JSON.stringify(existing), "utf8");
    TELEGRAM_QUINIELA_SENT_STATE[String(lockKey)] = existing[String(lockKey)];
  } catch {
    // No bloquear el flujo si el sistema de archivos falla
  }
}

const TELEGRAM_QUINIELA_SENT_STATE = loadQuinielaSentState();

function loadDailyBalanceSentState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DAILY_BALANCE_SENT_FILE, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
    // archivo ausente o corrupto
  }
  return {};
}

function persistDailyBalanceSentState(dateKey, snapshot) {
  try {
    const existing = loadDailyBalanceSentState();
    existing[String(dateKey)] = {
      ...snapshot,
      sentAt: new Date().toISOString(),
    };
    fs.writeFileSync(DAILY_BALANCE_SENT_FILE, JSON.stringify(existing), "utf8");
    TELEGRAM_DAILY_BALANCE_SENT_STATE[String(dateKey)] = existing[String(dateKey)];
  } catch {
    // No bloquear el flujo si el sistema de archivos falla
  }
}

const TELEGRAM_DAILY_BALANCE_SENT_STATE = loadDailyBalanceSentState();

async function withTelegramSendLock(lockKey, task) {
  const previous = TELEGRAM_SEND_LOCKS.get(lockKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  TELEGRAM_SEND_LOCKS.set(lockKey, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (TELEGRAM_SEND_LOCKS.get(lockKey) === queued) {
      TELEGRAM_SEND_LOCKS.delete(lockKey);
    }
  }
}

function isTelegramEnabled() {
  return process.env.TELEGRAM_ENABLED === "true";
}

function getTelegramConfig() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  return { token, chatId };
}

function resolveHoraPartido(pick) {
  return resolvePickHourLabel(pick);
}

function resolveCasa(pick) {
  const direct = String(pick?.casa || pick?.valueBook || "").trim();
  if (direct) {
    const lower = direct.toLowerCase();
    if (lower.includes("bet365")) return "Bet365";
    if (lower.includes("winamax")) return "Winamax FR";
    return direct;
  }

  const comparison = pick?.oddsComparison || {};
  const best = String(comparison.bestBookmaker || comparison.bestBookmakerKey || "").trim();
  if (best) return best;

  return null;
}

function resolveEvPct(pick) {
  if (pick?.ev_pct != null && Number.isFinite(Number(pick.ev_pct))) {
    return Number(pick.ev_pct);
  }
  if (typeof pick?.evPercent === "string" && pick.evPercent.trim()) {
    const parsed = Number.parseFloat(pick.evPercent.replace("%", "").replace("+", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (pick?.ev != null && Number.isFinite(Number(pick.ev))) {
    const ev = Number(pick.ev);
    return Math.abs(ev) <= 1 ? ev * 100 : ev;
  }
  return null;
}

function resolveConfianza(pick) {
  const value = pick?.confianza ?? pick?.confidence;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function resolveEstadoColor(pick) {
  const raw = String(pick?.estado_color || pick?.estado || "").toLowerCase();
  if (raw === "verde" || raw === "amarillo") return raw;
  if (pick?.readyToBet || pick?.bettable) return "verde";
  if (pick?.safeForComboLeg) return "amarillo";
  return raw;
}

export function normalizePickForTelegram(pick, sportHint = null) {
  const estado_color = resolveEstadoColor(pick);
  const hora_partido = resolveHoraPartido(pick);
  const cuotaRaw = pick?.cuota ?? pick?.bestOdds ?? pick?.mejor_cuota ?? pick?.odds ?? null;
  const cuota = cuotaRaw != null && Number.isFinite(Number(cuotaRaw)) ? Number(cuotaRaw) : null;

  return {
    id: pick?.id,
    pick_date: getPickDateKey(pick),
    sport: sportHint || pick?.sport || pick?.sportId || "",
    partido: String(pick?.partido || pick?.matchLabel || pick?.match || "").trim(),
    pick_label: String(pick?.pick_label || pick?.selection || pick?.seleccion || pick?.label || "").trim(),
    mercado: String(pick?.mercado || pick?.market || pick?.type || pick?.category || "").trim(),
    cuota,
    casa: resolveCasa(pick),
    ev_pct: resolveEvPct(pick),
    confianza: resolveConfianza(pick),
    estado_color,
    hora_partido,
    scheduledAt: resolvePickStartIso(pick),
    status: pick?.status || pick?.matchStatus || pick?.gameStatus || pick?.statusInfo?.raw || "",
    resultado: pick?.resultado || "pendiente",
    ganancia_neta: pick?.ganancia_neta != null ? Number(pick.ganancia_neta) : null,
    notas: String(pick?.notas || pick?.note || pick?.rationale || "").trim(),
  };
}

function isGenericValueLabel(text) {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return (
    !normalized ||
    normalized === "sin valor" ||
    normalized.includes("sin valor claro") ||
    normalized === "no recomendar" ||
    normalized === "valor marginal"
  );
}

function buildPickTelegramNotes(pick) {
  const sport = String(pick?.sport || "").toLowerCase();
  const note = String(pick?.notas || pick?.note || pick?.rationale || "").trim();
  const label = String(pick?.valueLabel || "").trim();
  const maxLen = sport === "mlb" || sport === "baseball" || sport === "nba" || sport === "wnba" || sport === "nfl" ? 900 : 400;

  if (sport === "mlb" || sport === "baseball" || sport === "nba" || sport === "wnba" || sport === "nfl") {
    const parts = [];
    if (note) parts.push(note);
    if (label && !isGenericValueLabel(label) && !note.includes(label)) parts.push(label);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxLen);
  }

  const parts = [];
  if (label && !isGenericValueLabel(label)) parts.push(label);
  if (note && !parts.some((part) => note.includes(part))) parts.push(note);
  return parts.join(" | ").slice(0, maxLen);
}

function extractTierChangeReason(pick, previousPick) {
  const notes = buildPickTelegramNotes(pick);
  if (notes) return notes;
  const prevNotes = buildPickTelegramNotes(previousPick);
  if (prevNotes) return prevNotes;
  return null;
}

function buildTierChangeBanner(tierChange, pick, previousPick) {
  const oldConf = resolveConfianza(previousPick);
  const newConf = resolveConfianza(pick);
  const confLine =
    oldConf != null && newConf != null && oldConf !== newConf
      ? `🧠 Confianza: ${oldConf}% → ${newConf}%`
      : null;
  const reason = extractTierChangeReason(pick, previousPick);

  if (tierChange === "amarillo_to_verde") {
    const lines = [
      "⬆️ <b>SUBE A TOP PICK</b>",
      "La confianza de este pick ha mejorado.",
      confLine,
      reason ? `📋 <i>${escapeHtml(reason)}</i>` : null,
    ];
    return lines.filter(Boolean).join("\n");
  }

  if (tierChange === "verde_to_amarillo") {
    const lines = [
      "⬇️ <b>BAJA A ALTERNATIVA</b>",
      "⚠️ La confianza de este pick ha bajado.",
      confLine,
      reason ? `📋 Motivo: <i>${escapeHtml(reason)}</i>` : null,
    ];
    return lines.filter(Boolean).join("\n");
  }

  return null;
}

/** Puntuación de datos disponibles (más alto = mensaje más completo). */
export function getPickCompletenessScore(pick) {
  const normalized = normalizePickForTelegram(pick);
  let score = 0;
  if (normalized.partido && normalized.pick_label) score += 2;
  if (normalized.mercado) score += 1;
  if (normalized.cuota != null && normalized.cuota > 1) score += 2;
  if (normalized.casa) score += 2;
  if (normalized.ev_pct != null) score += 1;
  if (normalized.confianza != null) score += 1;
  if (normalized.hora_partido) score += 2;
  return score;
}

export function hasMinimumTelegramFields(pick) {
  const normalized = normalizePickForTelegram(pick);
  return Boolean(
    normalized.sport &&
    normalized.partido &&
    normalized.pick_label &&
    normalized.mercado
  );
}

function tierWasAlreadySent(state, tier) {
  if (tier === "verde") return Boolean(state.verde);
  if (tier === "amarillo") return Boolean(state.amarillo);
  return false;
}

async function shouldSendNewPickNotification(pick) {
  if (!shouldNotifyPick(pick)) {
    return { allow: false, reason: "tier_not_allowed" };
  }

  const normalized = normalizePickForTelegram(pick);
  if (!hasMinimumTelegramFields(normalized)) {
    return { allow: false, reason: "missing_required_fields" };
  }

  if (!isPickEligibleForTelegram(normalized)) {
    return { allow: false, reason: "match_not_actionable" };
  }

  const tier = String(normalized.estado_color || "").toLowerCase();
  const completeness = getPickCompletenessScore(normalized);
  const { state } = await getTelegramSentState(normalized);
  const registryKey = `${getPickDateKey(normalized)}|${buildPickIdentityKey(normalized)}`;

  if (tier === "verde" && state.amarillo && !state.verde) {
    return { allow: true, registryKey, tier, completeness, pick: normalized, tierChange: "amarillo_to_verde" };
  }

  if (tier === "amarillo" && state.verde && !state.amarillo) {
    return { allow: true, registryKey, tier, completeness, pick: normalized, tierChange: "verde_to_amarillo" };
  }

  if (tierWasAlreadySent(state, tier)) {
    return { allow: false, reason: "already_sent_same_tier", registryKey, tier };
  }

  return { allow: true, registryKey, tier, completeness, pick: normalized };
}

function normalizeMarketName(value) {
  const text = String(value || "").trim();
  if (!text) return "Mercado";
  return text
    .replace(/\bHCP\b/gi, "Handicap")
    .replace(/\bML\b/gi, "Ganador del partido")
    .replace(/\bGOALS\b/gi, "Total de goles")
    .replace(/\bBOOK\b/gi, "Total de tarjetas")
    .replace(/\bCORN\b/gi, "Total de corners")
    .replace(/\b1X2\b/gi, "Doble oportunidad")
    .replace(/\bRunline\b/gi, "Handicap de carreras")
    .replace(/\bBookings Totals\b/gi, "Total de tarjetas")
    .replace(/\bBookings Spread\b/gi, "Handicap de tarjetas")
    .replace(/\bCorners Totals\b/gi, "Total de corners")
    .replace(/\bCorners Spread\b/gi, "Handicap de corners")
    .replace(/\bDouble Chance\b/gi, "Doble oportunidad")
    .replace(/\bTeam Total Home\b/gi, "Total equipo local")
    .replace(/\bTeam Total Away\b/gi, "Total equipo visitante")
    .replace(/\bTotals\b/gi, "Totales");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sportLabel(sport) {
  const value = String(sport || "").toLowerCase();
  if (value === "tennis") return "🎾 TENNIS";
  if (value === "futbol" || value === "football") return "⚽ FUTBOL";
  if (value === "mlb" || value === "baseball") return "⚾ MLB";
  if (value === "nba") return "🏀 NBA";
  if (value === "wnba") return "🏀 WNBA";
  if (value === "nfl") return "🏈 NFL";
  return "🏟️ DEPORTE";
}

function pickTierLabel(estadoColor, confianza = null) {
  const value = String(estadoColor || "").toLowerCase();
  const conf = Number(confianza);
  if (value === "verde" && Number.isFinite(conf) && conf >= 75) return "🟢 MEJOR PICK";
  if (value === "verde") return "🟢 TOP PICK";
  if (value === "amarillo") return "🟡 TOP PICK";
  return "ℹ️ PICK";
}

function buildNewPickMessage(pick, meta = {}) {
  const evValue = pick.ev_pct != null ? Number(pick.ev_pct) : null;
  const evText =
    evValue != null
      ? `${evValue >= 0 ? "+" : ""}${evValue.toFixed(1)}%`
      : "N/D";
  const tierBanner = meta.tierChange
    ? buildTierChangeBanner(meta.tierChange, pick, meta.previousPick)
    : null;
  const narrative = buildPickTelegramNotes(pick);
  const scheduleTag = buildRelativeScheduleTagForPick(pick);
  const hora = resolvePickHourLabel(pick);
  const scheduleLine = [
    scheduleTag ? `📅 ${scheduleTag}` : null,
    hora ? `🕒 ${hora} (Madrid)` : null,
  ].filter(Boolean).join(" · ");
  const scoreLine =
    pick.score_final != null && Number.isFinite(Number(pick.score_final))
      ? `📊 Score: ${Math.round(Number(pick.score_final))}/100`
      : null;
  const stakeLine =
    pick.stake_pct != null && Number.isFinite(Number(pick.stake_pct))
      ? `💼 Stake sugerido: ${Number(pick.stake_pct).toFixed(1)}% bankroll`
      : null;
  const lines = [
    tierBanner,
    `<b>${escapeHtml(pickTierLabel(pick.estado_color, pick.confianza))}</b> | <b>${escapeHtml(sportLabel(pick.sport))}</b>`,
    scheduleLine || null,
    `🏟️ <b>${escapeHtml(pick.partido || "Partido")}</b>`,
    `🎯 ${escapeHtml(pick.pick_label || "Seleccion")}`,
    `🏷️ Mercado: ${escapeHtml(normalizeMarketName(pick.mercado))}`,
    `💸 Cuota: ${pick.cuota != null ? escapeHtml(Number(pick.cuota).toFixed(2)) : "N/D"}${pick.casa ? ` · ${escapeHtml(pick.casa)}` : ""}`,
    `📈 EV: <b>${escapeHtml(evText)}</b>   🧠 Confianza: ${pick.confianza != null ? escapeHtml(`${Math.round(Number(pick.confianza))}%`) : "N/D"}`,
    scoreLine,
    stakeLine,
    narrative ? `\n📋 <i>${escapeHtml(narrative)}</i>` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function resultLabel(resultado) {
  if (resultado === "ganado") return "✅ GANADO";
  if (resultado === "perdido") return "❌ PERDIDO";
  return "⚪ VOID";
}

function buildResolvedScheduleLine(pick) {
  const normalized = normalizePickForTelegram(pick);
  const dateTag = buildRelativeScheduleTagForPick(normalized);
  const hora = resolvePickHourLabel(normalized);
  return [dateTag, hora ? `🕒 ${hora}` : null].filter(Boolean).join(" · ");
}

function buildResolvedMessage(pick) {
  const normalized = normalizePickForTelegram(pick);
  const result = String(normalized?.resultado || "").toLowerCase();
  const animatedBadge =
    result === "ganado"
      ? "🎉✨"
      : result === "perdido"
        ? "💥😵"
        : "⚪";
  const scheduleLine = buildResolvedScheduleLine(normalized);
  const cuotaUsada = Number(normalized.cuota) || 1;
  const gananciaUnidades =
    result === "ganado"
      ? (cuotaUsada - 1).toFixed(2)
      : result === "perdido"
        ? "-1.00"
        : "0.00";
  const rendimientoPct =
    result === "ganado"
      ? `+${((cuotaUsada - 1) * 100).toFixed(0)}%`
      : result === "perdido"
        ? "-100%"
        : "0%";
  const lines = [
    `<b>${escapeHtml(resultLabel(normalized.resultado))}</b> ${animatedBadge}`,
    `${escapeHtml(sportLabel(normalized.sport))} | ${escapeHtml(pickTierLabel(normalized.estado_color, normalized.confianza))}`,
    scheduleLine ? `📅 ${escapeHtml(scheduleLine)}` : null,
    `🏟️ ${escapeHtml(normalized.partido || "Partido")}`,
    `🎯 ${escapeHtml(normalized.pick_label || "Seleccion")}`,
    `🏷️ ${escapeHtml(normalizeMarketName(normalized.mercado))} · Cuota ${cuotaUsada.toFixed(2)}`,
    `💰 Resultado: <b>${escapeHtml(gananciaUnidades)} u</b> (${escapeHtml(rendimientoPct)})`,
  ];
  return lines.filter(Boolean).join("\n");
}

function buildDailyBalanceMessage({
  date,
  ganados = 0,
  perdidos = 0,
  voids = 0,
  totalResueltos = 0,
  pendientes = 0,
  gananciaTotalU = null,
  roiPct = null,
}) {
  const balanceText =
    ganados > perdidos
      ? "📈 Día positivo"
      : perdidos > ganados
        ? "📉 Día negativo"
        : "⚖️ Día equilibrado";
  const winRate =
    totalResueltos > 0
      ? `${((ganados / totalResueltos) * 100).toFixed(1)}%`
      : "0.0%";
  const gananciasLine =
    gananciaTotalU != null
      ? `💰 Ganancia: <b>${Number(gananciaTotalU) >= 0 ? "+" : ""}${Number(gananciaTotalU).toFixed(2)} u</b>`
      : null;
  const roiLine =
    roiPct != null
      ? `📊 ROI del día: <b>${Number(roiPct) >= 0 ? "+" : ""}${Number(roiPct).toFixed(1)}%</b>`
      : null;
  const pendientesLine =
    pendientes > 0
      ? `⏳ Pendientes: <b>${pendientes}</b> (sin resultado aún)`
      : null;
  const lines = [
    "📊 <b>CIERRE DEL DÍA</b> ✨",
    `🗓️ Fecha: <b>${escapeHtml(String(date || ""))}</b>`,
    "",
    `✅ Ganados: <b>${ganados}</b>`,
    `❌ Perdidos: <b>${perdidos}</b>`,
    `⚪ Void: <b>${voids}</b>`,
    pendientesLine,
    `📌 Resueltos: <b>${totalResueltos}</b> · Acierto: <b>${escapeHtml(winRate)}</b>`,
    gananciasLine,
    roiLine,
    "",
    balanceText,
  ];
  return lines.filter(Boolean).join("\n");
}

async function sendTelegramMessage(text) {
  if (!isTelegramEnabled()) return false;
  const { token, chatId } = getTelegramConfig();
  if (!token || !chatId) return false;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed (${response.status}): ${body}`);
  }

  return true;
}

function shouldNotifyPick(pick) {
  const tier = String(pick?.estado_color || "").toLowerCase();
  return tier === "verde" || tier === "amarillo";
}

export async function notifyNewPickTelegram(pick, options = {}) {
  if (!isTelegramEnabled()) return false;
  const normalized = normalizePickForTelegram(pick);
  const lockKey = `${getPickDateKey(normalized)}|${buildPickIdentityKey(normalized)}|${String(normalized.estado_color || "").toLowerCase()}`;

  return withTelegramSendLock(lockKey, async () => {
    const decision = await shouldSendNewPickNotification(normalized);
    if (!decision.allow) {
      if (decision.reason === "match_not_actionable") {
        console.log(
          `[telegram] Pick omitido (ya jugado o no proximo): ${normalized.partido || normalized.pick_label || "sin nombre"}`
        );
      }
      return false;
    }

    const payload = decision.pick || normalizePickForTelegram(normalized);
    const tierChange = options.tierChange || decision.tierChange || null;
    const previousPick = options.previousPick
      ? normalizePickForTelegram(options.previousPick)
      : null;
    const message = buildNewPickMessage(payload, { tierChange, previousPick });
    const sent = await sendTelegramMessage(message);
    if (sent) {
      await markTelegramSent(payload, decision.tier, decision.completeness);
    }
    return sent;
  });
}

export async function notifyAnalysisDetectedPick(sport, pick) {
  return notifyNewPickTelegram({ ...pick, sport });
}

export async function notifyResolvedPickTelegram(pick) {
  if (!isTelegramEnabled()) return false;
  if (!shouldNotifyPick(pick)) return false;

  const resultado = String(pick?.resultado || "").toLowerCase();
  if (!["ganado", "perdido", "void"].includes(resultado)) return false;

  // Los picks terminados siempre se notifican (ganado/perdido/void),
  // aunque el partido ya no sea "proximo" para un aviso de pick nuevo.
  const message = buildResolvedMessage(pick);
  const sent = await sendTelegramMessage(message);
  if (sent) {
    console.log(
      `[telegram] Resultado enviado (${resultado}): ${pick?.partido || pick?.pick_label || "pick"}`
    );
  }
  return sent;
}

export async function notifyDailyBalanceTelegram(summary) {
  if (!isTelegramEnabled()) return false;
  const dateKey = String(summary?.date || "").trim();
  if (!dateKey) return false;
  const payload = {
    date: dateKey,
    ganados: Number(summary?.ganados || 0),
    perdidos: Number(summary?.perdidos || 0),
    voids: Number(summary?.voids || 0),
    totalResueltos: Number(summary?.totalResueltos || 0),
    pendientes: Number(summary?.pendientes || 0),
    gananciaTotalU:
      summary?.gananciaTotalU != null && Number.isFinite(Number(summary.gananciaTotalU))
        ? Number(summary.gananciaTotalU)
        : null,
    roiPct:
      summary?.roiPct != null && Number.isFinite(Number(summary.roiPct))
        ? Number(summary.roiPct)
        : null,
  };
  if (payload.totalResueltos <= 0 && payload.pendientes <= 0) return false;

  const lockKey = `daily-balance:${dateKey}`;
  return withTelegramSendLock(lockKey, async () => {
    const previous = TELEGRAM_DAILY_BALANCE_SENT_STATE[dateKey] || loadDailyBalanceSentState()[dateKey];
    if (
      previous &&
      Number(previous.ganados) === payload.ganados &&
      Number(previous.perdidos) === payload.perdidos &&
      Number(previous.voids) === payload.voids &&
      Number(previous.totalResueltos) === payload.totalResueltos &&
      Number(previous.pendientes || 0) === payload.pendientes &&
      Number(previous.gananciaTotalU ?? NaN) === Number(payload.gananciaTotalU ?? NaN) &&
      Number(previous.roiPct ?? NaN) === Number(payload.roiPct ?? NaN)
    ) {
      return false;
    }
    const message = buildDailyBalanceMessage(payload);
    const sent = await sendTelegramMessage(message);
    if (sent) {
      persistDailyBalanceSentState(dateKey, payload);
    }
    return sent;
  });
}

function formatQuinielaTelegramRow(item) {
  const tipo = String(item.tipo || "").toUpperCase();
  const ventaja = String(item.ventajaMayor || "").toLowerCase();
  const icon =
    ventaja === "fijo" ? "★" :
    ventaja === "doble" ? "⚡" : "";
  if (item?.fijoForzadoPorCupo) {
    const fav = item?.favoritoSign || item?.pick || "";
    const prob = item?.favoritoProbPct != null ? ` ${item.favoritoProbPct}%` : "";
    return `${item.order}. ${escapeHtml(item.partido)} → <b>${escapeHtml(item.pick)}</b> (${escapeHtml(tipo)}) 🔒◆${escapeHtml(fav)}${escapeHtml(prob)} · pref. doble ${icon}`;
  }
  const ventajaTag = icon && ventaja === String(item.tipo || "").toLowerCase()
    ? ` ${icon}`
    : icon
      ? ` · mayor ventaja ${ventaja.toUpperCase()} ${icon}`
      : "";
  return `${item.order}. ${escapeHtml(item.partido)} → <b>${escapeHtml(item.pick)}</b> (${escapeHtml(tipo)})${ventajaTag}`;
}

function formatQuinielaTelegramRowMinimo(item) {
  return `${item.order}. ${escapeHtml(item.partido)} → <b>${escapeHtml(item.pick)}</b> (FIJO)`;
}

export async function notifyQuinielaOfficialProposal(payload = {}) {
  if (!isTelegramEnabled()) return false;
  const jornada = Number(payload?.jornada || 0);
  const propuesta = Array.isArray(payload?.propuesta) ? payload.propuesta : [];
  const propuestaMinima = Array.isArray(payload?.propuestaMinima) ? payload.propuestaMinima : [];
  if (!jornada || propuesta.length < 14) return false;

  const lockKey = `quiniela:jornada:${jornada}`;
  const fingerprint = buildQuinielaProposalFingerprint({
    propuesta,
    propuestaMinima,
    plenoPick: payload?.propuestaPleno15?.pick || "",
  });
  const previous = TELEGRAM_QUINIELA_SENT_STATE[lockKey] || loadQuinielaSentState()[lockKey];

  return withTelegramSendLock(lockKey, async () => {
    if (previous?.fingerprint && previous.fingerprint === fingerprint) {
      return false;
    }

    const fixed = propuesta.filter((row) => String(row.tipo).toLowerCase() === "fijo").length;
    const doubles = propuesta.filter((row) => String(row.tipo).toLowerCase() === "doble").length;
    const costModelo = formatQuinielaEurTelegram(payload?.pricing?.direct?.costEur);
    const costMinimo = formatQuinielaEurTelegram(
      payload?.pricing?.minimal?.costEur ?? payload?.pricing?.minimumCostEur ?? 1.5
    );
    const isUpdate = Boolean(payload?.isUpdate) || Boolean(previous?.fingerprint);

    const lines = [
      isUpdate
        ? "🔄 <b>QUINIELA ACTUALIZADA</b>"
        : "🧾 <b>QUINIELA OFICIAL PUBLICADA</b>",
      `Jornada <b>${escapeHtml(String(jornada))}</b>`,
      "",
      "<b>BOLETO MODELO</b>" +
        (costModelo ? ` · ${escapeHtml(costModelo)}` : "") +
        ` · ${fixed} fijos · ${doubles} doble${doubles === 1 ? "" : "s"}`,
      ...propuesta.slice(0, 14).map((item) => formatQuinielaTelegramRow(item)),
    ];

    if (propuestaMinima.length >= 14) {
      lines.push(
        "",
        `<b>BOLETO MÍNIMO 1,50 €</b>` +
          (costMinimo ? ` · ${escapeHtml(costMinimo)}` : "") +
          " · 14 fijos (un signo por partido)",
        ...propuestaMinima.slice(0, 14).map((item) => formatQuinielaTelegramRowMinimo(item))
      );
    }
    if (payload?.pleno15?.home && payload?.pleno15?.away) {
      const pl = payload?.propuestaPleno15;
      if (pl?.pick) {
        lines.push(
          "",
          `P-15 <b>${escapeHtml(pl.home)} vs ${escapeHtml(pl.away)}</b>`,
          `→ <b>${escapeHtml(pl.pick)}</b> (local ${escapeHtml(pl.pickHome)} · visitante ${escapeHtml(pl.pickAway)}) · λ ${escapeHtml(String(pl.lambdaHome))}-${escapeHtml(String(pl.lambdaAway))}`
        );
      } else {
        lines.push("", `P-15 oficial: ${escapeHtml(payload.pleno15.home)} vs ${escapeHtml(payload.pleno15.away)}`);
      }
    }

    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent) {
      persistQuinielaSentState(lockKey, fingerprint);
    }
    return sent;
  });
}

function formatQuinielaClosingHour(closingTime) {
  if (!closingTime) return null;
  try {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(closingTime));
  } catch {
    return null;
  }
}

export async function notifyQuinielaPlazoCerradaTelegram(payload = {}) {
  if (!isTelegramEnabled()) return false;

  const jornada = Number(payload?.jornada || 0);
  if (!jornada) return false;

  const lockKey = `quiniela:cerrada:${jornada}`;
  const previous = TELEGRAM_QUINIELA_SENT_STATE[lockKey] || loadQuinielaSentState()[lockKey];
  if (previous?.fingerprint === "closed") return false;

  const horaCierre = formatQuinielaClosingHour(payload?.closingTime);
  const propuesta = Array.isArray(payload?.propuesta) ? payload.propuesta : [];
  const first = propuesta[0];
  const last = propuesta[propuesta.length - 1];

  const lines = [
    `🔒 <b>QUINIELA J${escapeHtml(String(jornada))} CERRADA</b>`,
    horaCierre
      ? `El pronóstico es definitivo — plazo cerrado a las ${escapeHtml(horaCierre)}`
      : "El pronóstico es definitivo — plazo cerrado",
    "",
    first || last
      ? `Los partidos empiezan${first ? ` (${escapeHtml(first.partido || "")})` : ""}${last && last !== first ? ` y ${escapeHtml(last.partido || "")}` : ""}`
      : null,
    "",
    "Suerte! 🍀",
  ];

  return withTelegramSendLock(lockKey, async () => {
    const sent = await sendTelegramMessage(lines.filter(Boolean).join("\n"));
    if (sent) persistQuinielaSentState(lockKey, "closed");
    return sent;
  });
}

export async function notifyQuinielaResultadosTelegram({ jornada, evaluacion } = {}) {
  if (!isTelegramEnabled()) return false;
  if (!evaluacion?.detalle?.length) return false;

  const lockKey = `quiniela:resultados:${jornada}`;
  const fingerprint = `aciertos:${evaluacion.aciertos}:fallos:${evaluacion.fallos}`;
  const previous = TELEGRAM_QUINIELA_SENT_STATE[lockKey] || loadQuinielaSentState()[lockKey];
  if (previous?.fingerprint === fingerprint) return false;

  const icon =
    evaluacion.aciertos >= 14
      ? "🏆🎉"
      : evaluacion.aciertos >= 12
        ? "🎯"
        : evaluacion.aciertos >= 10
          ? "✅"
          : "📋";

  const lines = [
    `${icon} <b>RESULTADO QUINIELA J${escapeHtml(String(jornada || ""))}</b>`,
    `📊 Aciertos: <b>${evaluacion.aciertos}/14</b> · Fallos: ${evaluacion.fallos}`,
    "",
    "<b>Detalle:</b>",
    ...evaluacion.detalle.slice(0, 14).map((row) => {
      const acierto = row.acierto === null ? "⏳" : row.acierto ? "✅" : "❌";
      const marcador = row.marcador ? ` (${escapeHtml(row.marcador)})` : "";
      return `${acierto} ${row.order}. ${escapeHtml(row.partido || "")} → ${escapeHtml(row.pick || "")} / Real: ${escapeHtml(row.resultadoReal || "?")}${marcador}`;
    }),
  ];

  return withTelegramSendLock(lockKey, async () => {
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent) persistQuinielaSentState(lockKey, fingerprint);
    return sent;
  });
}
