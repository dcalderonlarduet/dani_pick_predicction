/** Flags de línea trampa reutilizables (MLB / NBA / NFL / WNBA). */

export function resolvePickSideLm(raw = {}) {
  if (raw.side) return raw.side;
  if (raw.betSide) return raw.betSide;
  if (raw.type === "moneyline" || raw.type === "runline") return raw.teamSide || null;
  if (raw.type === "totals" || raw.type === "team-total") {
    const sel = String(raw.selection || "").toLowerCase();
    if (sel.includes("más") || sel.includes("over") || sel.includes("(+)")) return "over";
    if (sel.includes("menos") || sel.includes("under") || sel.includes("(-)")) return "under";
  }
  return null;
}

export function inferPublicSideFromSharp(lm) {
  if (!lm?.lado_sharp) return null;
  const map = {
    home: "away",
    away: "home",
    over: "under",
    under: "over",
  };
  return map[lm.lado_sharp] || null;
}

export function normalizeLineMovement(lm) {
  if (!lm || lm.tipo !== "LINEA_TRAMPA") return lm;
  return {
    ...lm,
    lado_publico: lm.lado_publico || inferPublicSideFromSharp(lm),
  };
}

export function computeLineTrapFlags(lm, pickSide) {
  const normalized = normalizeLineMovement(lm);
  const lineTrapDetected = normalized?.tipo === "LINEA_TRAMPA";
  const lineTrapActive =
    lineTrapDetected &&
    pickSide != null &&
    normalized?.lado_publico != null &&
    pickSide === normalized.lado_publico;
  return {
    line_movement: normalized,
    lineTrapActive,
    lineTrapDetected,
  };
}

export function attachLineTrapFlags(pick, lm, pickSide) {
  const flags = computeLineTrapFlags(lm, pickSide);
  return {
    ...pick,
    line_movement: flags.line_movement ?? pick.line_movement ?? lm,
    lineTrapActive: flags.lineTrapActive,
    lineTrapDetected: flags.lineTrapDetected,
  };
}
