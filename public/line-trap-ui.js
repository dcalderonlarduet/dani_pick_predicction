/** UI compartida: badge de línea trampa (MLB / NBA / NFL / WNBA / Fútbol / Quiniela). */
(function initLineTrapUi(global) {
  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function resolvePickSideForTrap(raw) {
    if (!raw) return null;
    if (raw.side) return raw.side;
    if (raw.betSide) return raw.betSide;
    const qSign = raw.quinielaSign || raw.favoritoSign;
    if (qSign === "1") return "home";
    if (qSign === "2") return "away";
    const pickLabel = String(raw.pick_label || raw.selection || "").trim();
    if (pickLabel === "1") return "home";
    if (pickLabel === "2") return "away";
    if (raw.type === "moneyline" || raw.type === "runline") return raw.teamSide || null;
    if (raw.type === "totals" || raw.type === "team-total") {
      const sel = String(raw.selection || "").toLowerCase();
      if (sel.includes("más") || sel.includes("over") || sel.includes("(+)")) return "over";
      if (sel.includes("menos") || sel.includes("under") || sel.includes("(-)")) return "under";
    }
    return null;
  }

  function isLineTrapPick(raw) {
    if (!raw) return false;
    if (raw.lineTrapActive) return true;
    const lm = raw.line_movement;
    if (!lm || lm.tipo !== "LINEA_TRAMPA") return false;
    const side = resolvePickSideForTrap(raw);
    if (side && lm.lado_publico) return side === lm.lado_publico;
    return Boolean(raw.lineTrapDetected);
  }

  function lineTrapPublicPct(raw) {
    if (!raw) return null;
    const side = resolvePickSideForTrap(raw);
    if (side === "away" && raw.pct_public_away != null) return Math.round(Number(raw.pct_public_away));
    if (side === "home" && raw.pct_public_home != null) return Math.round(Number(raw.pct_public_home));
    if (raw.pct_public_home != null) return Math.round(Number(raw.pct_public_home));
    if (raw.pct_public_away != null) return Math.round(Number(raw.pct_public_away));
    return null;
  }

  function sideLabelPlain(side) {
    const map = {
      home: "el equipo local",
      away: "el equipo visitante",
      over: "Más (Over)",
      under: "Menos (Under)",
      "1": "el local (1)",
      "2": "el visitante (2)",
    };
    return map[side] || "ese resultado";
  }

  /** Convierte notas técnicas del backend a lenguaje claro. */
  function plainifyBackendTrapNote(note) {
    if (!note) return "";
    return String(note)
      .replace(/Señal de línea trampa:/gi, "Trampa detectada:")
      .replace(/Línea trampa detectada:/gi, "Trampa detectada:")
      .replace(/el mercado mueve hacia el lado público/gi, "la cuota se mueve hacia donde apuesta casi todo el mundo")
      .replace(/el modelo penaliza esta lectura/gi, "por eso el modelo desaconseja esta apuesta")
      .replace(/posible valor en el lado contrario al público/gi, "puede haber mejor opción en el lado contrario")
      .replace(/\bbook\b/gi, "casa de apuestas")
      .replace(/\bedge\b/gi, "ventaja real")
      .replace(/\bhandle\b/gi, "dinero fuerte")
      .replace(/\btickets\b/gi, "apuestas del público")
      .replace(/\bpp\b/gi, "puntos");
  }

  function buildLineTrapExplanation(raw) {
    if (!raw) return "";
    const lm = raw.line_movement;

    if ((!lm || lm.tipo !== "LINEA_TRAMPA") && raw.lineTrapActive && raw.lineMovementNote) {
      return plainifyBackendTrapNote(raw.lineMovementNote);
    }
    if (!lm || lm.tipo !== "LINEA_TRAMPA") return "";

    if (raw.lineMovementNote && String(raw.lineMovementNote).toLowerCase().includes("trampa")) {
      const base = plainifyBackendTrapNote(raw.lineMovementNote);
      const pct = lineTrapPublicPct(raw);
      if (pct != null && pct >= 55 && !base.includes(String(pct))) {
        return `${base} El ${pct}% de la gente apuesta por el mismo lado.`;
      }
      return base;
    }

    const pct = lineTrapPublicPct(raw);
    const publicSide = lm.lado_publico || resolvePickSideForTrap(raw);
    const sideText = sideLabelPlain(publicSide);
    const parts = [];

    if (pct != null && pct >= 55) {
      parts.push(`El ${pct}% de los apostadores va por ${sideText}. Es decir, casi todo el mundo elige lo mismo.`);
    } else if (pct != null) {
      parts.push(`Hay más gente apostando por un lado concreto (${pct}% de las apuestas).`);
    } else {
      parts.push(`Hay mucha gente apostando por ${sideText}.`);
    }

    const marketKey = String(lm.marketKey || raw.market || raw.marketKey || raw.type || "").toLowerCase();
    const isWinnerMarket =
      marketKey.includes("moneyline") || raw.type === "moneyline" || raw.type === "runline";

    if (isWinnerMarket) {
      const delta = Number(lm.delta_prob_home);
      if (Number.isFinite(delta) && Math.abs(delta) >= 0.01) {
        const team = delta > 0 ? "local" : "visitante";
        parts.push(
          `Pese a eso, la casa de apuestas ha empeorado la cuota del ${team}: ahora pagas peor que antes por el mismo resultado.`
        );
      } else {
        parts.push("La cuota del favorito se ha movido hacia donde apuesta la mayoría.");
      }
    } else if (Number.isFinite(Number(lm.delta_linea)) && Math.abs(Number(lm.delta_linea)) >= 0.5) {
      const deltaLine = Number(lm.delta_linea);
      const dir = deltaLine > 0 ? "subió" : "bajó";
      parts.push(
        `La línea de total ${dir} ${Math.abs(deltaLine).toFixed(1)} puntos mientras entra mucho dinero del público por un lado.`
      );
    }

    if (Number.isFinite(Number(lm.gap_tickets_handle)) && Math.abs(Number(lm.gap_tickets_handle)) >= 8) {
      const favor =
        Number(lm.gap_tickets_handle) > 0
          ? "más dinero fuerte entra por el local que apuestas sueltas del público"
          : "más dinero fuerte entra por el visitante que apuestas sueltas del público";
      parts.push(`Además, ${favor}. Eso indica que no todo el mundo va a la misma dirección.`);
    }

    parts.push(
      "¿Por qué lo llamamos trampa? Cuando la multitud va al mismo sitio y la cuota empeora, la casa de apuestas ya ha ajustado el precio: queda poca ventaja real."
    );

    if (resolvePickSideForTrap(raw) === lm.lado_publico) {
      parts.push("Este pick está en ese lado masificado; por eso el modelo lo marca como TRAMPA y no lo recomienda.");
    }

    return parts.join(" ");
  }

  function buildLineTrapExplanationShort(raw) {
    const pct = lineTrapPublicPct(raw);
    const lm = raw?.line_movement;
    const side = sideLabelPlain(lm?.lado_publico || resolvePickSideForTrap(raw));
    if (pct != null && pct >= 55) {
      return `Trampa: el ${pct}% apuesta por ${side} y la cuota empeoró. Poca ventaja real.`;
    }
    const full = buildLineTrapExplanation(raw);
    if (!full) return "";
    const firstSentence = full.split(/(?<=[.!?])\s+/)[0] || full;
    if (firstSentence.length <= 150) return firstSentence;
    return `${firstSentence.slice(0, 147).trim()}…`;
  }

  function renderLineTrapBadge(raw, { compact = false, inline = false } = {}) {
    if (!isLineTrapPick(raw)) return "";
    const pct = lineTrapPublicPct(raw);
    const meta = !compact && pct != null ? `${pct}% del público` : "";
    const explain = buildLineTrapExplanationShort(raw);
    return `
      <div class="line-trap-badge${compact ? " is-compact" : ""}${inline ? " is-inline" : ""}" role="status" aria-label="Apuesta trampa detectada" title="${esc(explain || "Mucha gente apuesta aquí y la cuota empeoró")}">
        <span class="line-trap-badge-icon" aria-hidden="true">🪤</span>
        <span class="line-trap-badge-text">TRAMPA</span>
        ${meta ? `<span class="line-trap-badge-meta">${esc(meta)}</span>` : ""}
      </div>
    `;
  }

  function renderLineTrapBlock(raw, { compact = false, inline = false, explain = true } = {}) {
    if (!isLineTrapPick(raw)) return "";
    const badge = renderLineTrapBadge(raw, { compact, inline });
    if (!explain) return badge;
    const text = compact ? buildLineTrapExplanationShort(raw) : buildLineTrapExplanation(raw);
    if (!text) return badge;
    return `
      <div class="line-trap-block${compact ? " is-compact" : ""}">
        ${badge}
        <p class="line-trap-explain">${esc(text)}</p>
      </div>
    `;
  }

  function gameHasLineTrap(entity) {
    const game = entity?.raw || entity || {};
    const pools = [
      ...(game.recommendations || []),
      ...(entity?.analyses || []),
      ...(entity?.picks || []),
    ];
    return pools.some((item) => {
      const raw = item?.raw || item;
      return raw?.lineTrapDetected || raw?.line_movement?.tipo === "LINEA_TRAMPA" || isLineTrapPick(raw);
    });
  }

  function applyLineTrapPickState(pick) {
    if (!pick) return pick;
    const raw = pick.raw || pick;
    const active = isLineTrapPick(raw);
    return { ...pick, lineTrapActive: active };
  }

  global.resolvePickSideForTrap = resolvePickSideForTrap;
  global.isLineTrapPick = isLineTrapPick;
  global.lineTrapPublicPct = lineTrapPublicPct;
  global.renderLineTrapBadge = renderLineTrapBadge;
  global.renderLineTrapBlock = renderLineTrapBlock;
  global.buildLineTrapExplanation = buildLineTrapExplanation;
  global.buildLineTrapExplanationShort = buildLineTrapExplanationShort;
  global.gameHasLineTrap = gameHasLineTrap;
  global.applyLineTrapPickState = applyLineTrapPickState;
})(typeof window !== "undefined" ? window : globalThis);
