/* DANY PICKS v3 - Tennis + Futbol UI overrides */
(function () {
  function toNumber(value) {
    if (typeof parsNum === "function") return parsNum(value);
    const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function text(value) {
    return typeof esc === "function" ? esc(value) : String(value ?? "");
  }

  function loose(value) {
    if (typeof normalizeLooseText === "function") return normalizeLooseText(value);
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function trackLabel(trackedState) {
    if (trackedState.tracked) return "Añadida";
    if (trackedState.started) return "Ya inició";
    return "+ Añadir al tracker";
  }

  function metricClass(value, goodAt, warnAt) {
    if (value == null || Number.isNaN(value)) return "m-neutral";
    if (value >= goodAt) return "m-good";
    if (value >= warnAt) return "m-mid";
    return "m-bad";
  }

  function stripClass(value, goodAt, warnAt) {
    if (value == null || Number.isNaN(value)) return "fv-neutral";
    if (value >= goodAt) return "fv-good";
    if (value >= warnAt) return "fv-mid";
    return "fv-bad";
  }

  function isValueReadyPick(pick) {
    if (typeof pickIsValueCandidate === "function") return pickIsValueCandidate(pick);
    const raw = pick?.raw || {};
    const ev = toNumber(pick?.evNum ?? pick?.ev ?? raw.ev ?? raw.ev_model);
    const conf = toNumber(pick?.confianza ?? pick?.confidence ?? raw.confianza ?? raw.confidence);
    const sport = String(pick?.sportId || pick?._sport || "").toLowerCase();
    const minEv = sport === "mlb" ? 0.03 : sport === "futbol" ? 0.04 : 0.03;
    const minConf = sport === "wnba" ? 48 : 58;
    return (
      (pick?.estado === "verde" || pick?.estado === "amarillo") &&
      !pick?.lineTrapActive &&
      !raw.lineTrapActive &&
      !raw.discarded &&
      conf != null &&
      conf >= minConf &&
      ev != null &&
      (Math.abs(ev) > 1 ? ev / 100 : ev) >= minEv
    );
  }

  function isTopValuePick(pick) {
    if (typeof qualifiesTopPick === "function") return qualifiesTopPick(pick);
    return isValueReadyPick(pick);
  }

  function getVisualState(entry) {
    const isValue = isValueReadyPick(entry);
    const isGreen = entry.estado === "verde" || entry.tone === "verde" || isValue;
    const isAlt = entry.estado === "amarillo" || entry.tone === "amarillo";
    if (isGreen) {
      return {
        key: "verde",
        tennis: "t-pick-verde",
        tb: "tb-verde",
        label: "VERDE",
        stake: "t-stake-verde",
        fps: "fps-best",
      };
    }
    if (isAlt) {
      return {
        key: "amarillo",
        tennis: "t-pick-amarillo",
        tb: "tb-amarillo",
        label: "ALTERNATIVA",
        stake: "t-stake-amarillo",
        fps: "fps-alt",
      };
    }
    return {
      key: "lean",
      tennis: "t-pick-lean",
      tb: "tb-lean",
      label: "SIN VALOR",
      stake: "",
      fps: "fps-fade",
    };
  }

  function getFutbolStateKey(pick, index) {
    if (isValueReadyPick(pick)) return index === 0 ? "best" : "good";
    if (pick.estado === "verde") return index === 0 ? "best" : "good";
    if (pick.estado === "amarillo") return "alt";
    return "fade";
  }

  function getFutbolStateMeta(state) {
    const map = {
      best: { cls: "f-state-best", badge: "fb-best", label: "MEJOR PICK" },
      good: { cls: "f-state-good", badge: "fb-good", label: "RECOMENDADA" },
      alt: { cls: "f-state-alt", badge: "fb-alt", label: "ALTERNATIVA" },
      fade: { cls: "f-state-fade", badge: "fb-fade", label: "SIN VALOR" },
    };
    return map[state] || map.fade;
  }

  function getMarketCode(mercado) {
    const value = String(mercado || "").toUpperCase();
    if (value.includes("BOOK") || value.includes("TARJET")) return "BOOK";
    if (value.includes("CORNER")) return "CORN";
    if (value.includes("DOUBLE") || value.includes("DOBLE")) return "1X2";
    if (value.includes("TOTAL") || value.includes("GOAL") || value.includes("GOL")) return "GOALS";
    if (value.includes("HANDICAP") || value.includes("SPREAD")) return "HCP";
    if (value.includes("GANADOR") || value.includes("ML")) return "ML";
    return value.slice(0, 6) || "MKT";
  }

  function getSurfaceInfo(pick) {
    const match = pick.eventContext || pick.raw || {};
    const label = match.surfaceLabel || match.surface || "";
    const norm = loose(label);
    let cls = "surface-hard";
    if (norm.includes("arcill") || norm.includes("clay") || norm.includes("tierra")) cls = "surface-clay";
    else if (norm.includes("hierba") || norm.includes("grass")) cls = "surface-grass";
    return { label, cls };
  }

  function renderLiveInline(statusInfo) {
    if (!statusInfo?.isLive) return "";
    return '<span class="live-pill live-pill-strong live-pill-inline"><span class="status-dot"></span>EN VIVO</span>';
  }

  function renderBestPriceRow(raw, style = "dany") {
    return typeof renderBookOddsRow === "function" ? renderBookOddsRow(raw || {}, style) : "";
  }

  function renderConfidenceRing(conf, tone) {
    const pct = Math.max(0, Math.min(100, Math.round(conf || 0)));
    const circumference = 125.6;
    const offset = circumference - (pct / 100) * circumference;
    const color = tone === "verde" ? "#10e87a" : tone === "amarillo" ? "#ffc830" : "#5a7a96";
    const valColor = tone === "verde" ? "var(--good)" : tone === "amarillo" ? "var(--warn)" : "var(--text2)";
    return `
      <div class="f-ring">
        <svg width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="20" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"></circle>
          <circle cx="26" cy="26" r="20" fill="none" stroke="${color}" stroke-width="5"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"></circle>
        </svg>
        <div class="f-ring-val" style="color:${valColor}">${pct}%</div>
      </div>
    `;
  }

  function renderDanyStakeBox(ev, cuota, variant, visual, confidence = 60) {
    const kelly = typeof calcKellyPct === "function" ? calcKellyPct(ev, cuota, confidence) : null;
    if (!kelly) return "";

    if (variant === "futbol") {
      return `
        <div class="f-stake-row">
          <div>
            <div class="f-stake-lbl">% a apostar (Kelly 5%)</div>
            <div class="f-stake-pct ${visual?.fps || "fps-best"}">${kelly.pct}%</div>
            <div class="f-stake-sub">del bankroll</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:7px;color:var(--text3);letter-spacing:1px;margin-bottom:3px">SI ACIERTA</div>
            <div class="f-stake-gana" style="color:${visual?.key === "amarillo" ? "var(--warn)" : "var(--good)"}">+${kelly.ganPct}%</div>
          </div>
        </div>
      `;
    }

    const pctCls = visual?.key === "amarillo" ? "s-a" : "s-v";
    const ganCls = visual?.key === "amarillo" ? "sg-a" : "sg-v";
    return `
      <div class="t-stake ${visual?.stake || "t-stake-verde"}">
        <div>
          <div class="t-stake-lbl">% a apostar</div>
          <div class="t-stake-pct ${pctCls}">${kelly.pct}%</div>
          <div class="t-stake-sub">del bankroll${visual?.key === "amarillo" ? " · con criterio" : ""}</div>
        </div>
        <div class="t-stake-right">
          <div style="font-size:7px;color:var(--text3);letter-spacing:1px;margin-bottom:3px">SI ACIERTA</div>
          <div class="t-stake-gana ${ganCls}">+${kelly.ganPct}%</div>
          <div class="t-stake-sub">EV esp. +${kelly.evRetPct}%</div>
        </div>
      </div>
    `;
  }

  function renderTrackerActionRow(trackedState, ids, options = {}) {
    const trackAttr = ids.pickId
      ? `data-track-pick-id="${text(ids.pickId)}"`
      : `data-track-analysis-id="${text(ids.analysisId)}"`;
    const untrackAttr = ids.pickId
      ? `data-untrack-pick-id="${text(ids.pickId)}"`
      : `data-untrack-analysis-id="${text(ids.analysisId)}"`;

    return `
      <div class="dp-track-row">
        ${options.showDetail && ids.pickId ? `<button class="pick-detail-btn" type="button" data-pick-detail-open="${text(ids.pickId)}">Detalle</button>` : ""}
        <button
          class="pick-track-btn${trackedState.tracked ? " is-tracked" : ""}${!trackedState.canAdd && !trackedState.tracked ? " is-locked" : ""}"
          type="button"
          ${trackAttr}
          ${trackedState.canAdd ? "" : "disabled"}
        >${trackLabel(trackedState)}</button>
        ${trackedState.tracked
          ? trackedState.canRemove
            ? `<button class="pick-track-btn remove" type="button" ${untrackAttr}>Eliminar</button>`
            : `<button class="pick-track-btn is-locked" type="button" disabled>${text(trackedState.reason || "Bloqueado")}</button>`
          : ""}
      </div>
    `;
  }

  function getDropMetric(raw) {
    const source = raw?.oddsComparison || raw?.droppingOdds || raw || {};
    let drop = toNumber(source.dropPct ?? source.drop12h ?? source.drop ?? source.sharpDrop);
    if (drop == null || drop === 0) return null;
    if (Math.abs(drop) <= 1) drop *= 100;
    if (Math.abs(drop) < 3) return null;
    return `${drop > 0 ? "+" : ""}${Math.round(drop)}%`;
  }

  function renderDropMetricCell(pick) {
    const drop = getDropMetric(pick.raw || pick);
    if (!drop) {
      return `<div class="t-metric t-metric--muted" title="Sin datos de cuota en las ultimas 12h para este mercado">
          <div class="t-metric-label">Drop 12h</div>
          <div class="t-metric-val m-neutral">Sin dato</div>
        </div>`;
    }
    const aligned = pick.droppingOddsSignal === "confirmed";
    return `<div class="t-metric" title="La cuota bajo ${text(drop)} en 12h: el mercado ya movio dinero a este lado">
        <div class="t-metric-label">Drop 12h</div>
        <div class="t-metric-val ${aligned ? "m-good" : "m-mid"}">${text(drop)}</div>
      </div>`;
  }

  function getRiskMetric(entry) {
    const raw = entry.raw || {};
    const risk = toNumber(raw.riskScore ?? raw.riskPct);
    if (risk != null) return Math.max(0, Math.min(99, Math.round(risk <= 1 ? risk * 100 : risk)));
    return Math.max(0, Math.min(99, Math.round(100 - (entry.confianza || 50))));
  }

  function getFormTokens(record) {
    const explicit = record?.sequence || record?.form || record?.recentForm || record?.label || "";
    const tokens = String(explicit)
      .replace(/[^WLD]/gi, "")
      .toUpperCase()
      .split("")
      .slice(0, 5);
    return tokens.length ? tokens : [];
  }

  function getPlayerStatLabel(rawParticipant, participantInsight) {
    if (participantInsight?.surfaceRecord?.label) return participantInsight.surfaceRecord.label;
    if (rawParticipant?.surface?.sample && rawParticipant?.surface?.winPct != null) {
      return `${Math.round(rawParticipant.surface.winPct * 100)}% victorias`;
    }
    return "N/D";
  }

  function getPlayerRankLabel(rawParticipant) {
    const ranking = rawParticipant?.ranking ?? rawParticipant?.rank;
    if (ranking == null) return "Ranking N/D";
    return `Ranking ${ranking}`;
  }

  function getParticipantBlocks(pick) {
    const match = pick.eventContext || {};
    const rawParticipants = Array.isArray(match.participants) ? match.participants : [];
    const insightParticipants = Array.isArray(pick.raw?.participantInsights) && pick.raw.participantInsights.length
      ? pick.raw.participantInsights
      : rawParticipants.map((participant) => ({
          name: participant?.name || "Jugador",
          isPick: false,
          recentRecord: participant?.form || null,
          surfaceRecord: participant?.surface?.sample && participant?.surface?.winPct != null
            ? { label: `${Math.round(participant.surface.winPct * 100)}% victorias` }
            : null,
          medicalLabel: participant?.medical?.note || "",
        }));
    const pickedName = loose(pick.pick).replace(/\s+gana.*$/i, "").trim();

    return insightParticipants.slice(0, 2).map((participant, index) => {
      const rawParticipant = rawParticipants.find((item) => loose(item?.name) === loose(participant?.name)) || rawParticipants[index] || {};
      const isPick = Boolean(participant?.isPick) || loose(participant?.name).includes(pickedName);
      return {
        isPick,
        name: participant?.name || rawParticipant?.name || "Jugador",
        rankLabel: getPlayerRankLabel(rawParticipant),
        formTokens: getFormTokens(participant?.recentRecord || rawParticipant?.form),
        surfaceLabel: getPlayerStatLabel(rawParticipant, participant),
        hasMedicalRisk: Boolean(
          participant?.hasMedicalRisk ||
          (participant?.medicalLevel && participant.medicalLevel !== "none") ||
          (rawParticipant?.medical?.level && rawParticipant.medical.level !== "none")
        ),
        medicalLabel:
          participant?.medicalNote ||
          participant?.medicalLabel ||
          rawParticipant?.medical?.note ||
          "Sin alerta medica",
      };
    });
  }

  function renderParticipantBlock(participant) {
    const medicalClass = participant.hasMedicalRisk ? "" : " is-safe";
    return `
      <div class="t-player${participant.isPick ? " is-pick" : ""}">
        ${participant.isPick ? '<span class="t-player-tag">TU APUESTA</span>' : ""}
        <div class="t-player-name">${text(participant.name)}</div>
        <div class="t-player-rank">${text(participant.rankLabel)}</div>
        <div class="t-form-seq">
          ${participant.formTokens.length
            ? participant.formTokens.map((token) => `<span class="t-form-chip ${token === "W" ? "fc-w" : "fc-l"}">${text(token)}</span>`).join("")
            : '<span class="t-player-rank">Forma N/D</span>'}
        </div>
        <div class="t-surf-pct">${text(participant.surfaceLabel)}</div>
        <div class="t-lesion${medicalClass}" style="margin-top:6px"><span class="t-lesion-dot"></span>${text(participant.medicalLabel)}</div>
      </div>
    `;
  }

  function formatPctValue(value) {
    const parsed = toNumber(value);
    if (parsed == null) return null;
    const normalized = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
    return `${Math.round(normalized)}%`;
  }

  function translateNarrativeCopy(value) {
    if (typeof translateVerdictCopy === "function") return translateVerdictCopy(value);
    return String(value || "").trim();
  }

  function resolvePickPricing(pick) {
    if (pick?.pricingSignal) return pick.pricingSignal;
    if (typeof buildPickPricingSignal === "function") return buildPickPricingSignal(pick);
    return null;
  }

  function isGenericValueHeadline(text) {
    const normalized = loose(text);
    return (
      !normalized ||
      normalized === "sin valor" ||
      normalized.includes("sin valor claro") ||
      normalized === "no recomendar" ||
      normalized === "mejor no apostar" ||
      normalized === "valor marginal"
    );
  }

  function resolveMlbNarrativeHeadline(pick) {
    const market = loose(pick.mercado || pick.raw?.market || pick.raw?.type || "");
    if (market.includes("total")) return "Proyeccion de carreras";
    if (market.includes("ganador") || market.includes("moneyline")) return "Matchup de pitchers";
    if (market.includes("handicap") || market.includes("runline")) return "Handicap de carreras";
    return "Lectura MLB";
  }

  function resolveSportNarrative(pick) {
    const pricing = resolvePickPricing(pick);
    const rawHeadline = translateNarrativeCopy(
      pick.valueLabel || pricing?.cardLabel || pick.pricingSignal?.label || ""
    );
    let headline = rawHeadline;
    if (pick.sportId === "mlb" && isGenericValueHeadline(rawHeadline)) {
      headline = resolveMlbNarrativeHeadline(pick);
    } else if (isGenericValueHeadline(rawHeadline) && (pick.note || pick.raw?.rationale)) {
      headline = pick.sportId === "mlb" ? resolveMlbNarrativeHeadline(pick) : "";
    }
    let body = String(pick.note || pick.raw?.rationale || pick.raw?.note || pick.raw?.sportContextNote || "").trim();

    if (!body) {
      const chunks = [];
      const modelPct = formatPctValue(pick.modelProbability);
      const cuota = pick.cuota != null && Number.isFinite(Number(pick.cuota)) ? Number(pick.cuota).toFixed(2) : null;
      if (pick.partido && pick.pick) {
        chunks.push(
          cuota && modelPct
            ? `${pick.partido} · ${pick.pick}: modelo ${modelPct}, cuota ${cuota}.`
            : `${pick.partido} · ${pick.pick}.`
        );
      }
      if (pricing?.summary) chunks.push(pricing.summary);
      if (pricing?.reasons?.length) {
        chunks.push(`Factores clave: ${pricing.reasons.slice(0, 4).join(", ")}.`);
      }
      body = chunks.join(" ");
    }

    return { headline, body };
  }

  function renderSportNarrativeBlock(pick) {
    const { headline, body } = resolveSportNarrative(pick);
    if (!headline && !body) return "";
    return `
      <div class="t-sport-narrative">
        ${headline ? `<div class="t-sport-narrative-head">${text(headline)}</div>` : ""}
        ${body ? `<div class="t-sport-narrative-body">${text(body)}</div>` : ""}
      </div>
    `;
  }

  function resolvePickSportIdLocal(pick) {
    if (typeof resolvePickSportId === "function") return resolvePickSportId(pick);
    return pick?.sportId || pick?._sport || pick?.raw?.sport || "";
  }

  function renderDpSportIcon(pick, variant = "card") {
    if (typeof renderPickSportIcon === "function") {
      return renderPickSportIcon(pick, variant);
    }
    const cls = variant === "title" ? "dp-title-sport-icon" : "dp-card-sport-icon";
    const sportId = resolvePickSportIdLocal(pick);
    if (typeof sportIconHtml === "function") {
      return `<span class="${cls}">${sportIconHtml(sportId)}</span>`;
    }
    return `<span class="${cls}">${text(pick.icono || "")}</span>`;
  }

  function resolvePickRankLabel(index, visual) {
    if (index < 3) return `#${index + 1}`;
    return visual.key === "amarillo" ? "ALT" : "INFO";
  }

  function resolvePickLeagueTitle(pick) {
    const sportId = resolvePickSportIdLocal(pick);
    const match = pick.eventContext || {};
    if (sportId === "tennis") {
      return String(match.category || match.tournament || pick.deporte || "TENNIS").toUpperCase();
    }
    if (sportId === "mlb") {
      return String(match.league?.name || pick.deporte || "MLB").toUpperCase();
    }
    if (sportId === "futbol") {
      return String(match.league?.name || match.liga || pick.deporte || "FUTBOL").toUpperCase();
    }
    if (sportId === "nba") return String(match.league?.name || pick.deporte || "NBA").toUpperCase();
    if (sportId === "wnba") return String(match.league?.name || pick.deporte || "WNBA").toUpperCase();
    if (sportId === "nfl") return String(match.league?.name || pick.deporte || "NFL").toUpperCase();
    return String(pick.deporte || "PICK").toUpperCase();
  }

  function renderPickCardHeader(pick, index, visual) {
    const rank = resolvePickRankLabel(index, visual);
    const league = resolvePickLeagueTitle(pick);
    const market = text((pick.mercadoLabel || pick.mercado || "Mercado").toUpperCase());
    return `
      <header class="t-pick-header">
        <div class="t-pick-title-block">
          ${renderDpSportIcon(pick, "title")}
          <div class="t-pick-title-text">
            <span class="t-pick-rank-num">${text(rank)}</span>
            <h3 class="t-pick-sport-title">${text(league)}</h3>
          </div>
        </div>
        <div class="t-pick-header-meta">
          <span class="t-pick-market">${market}</span>
          <span class="t-pick-badge ${visual.tb}">${text(visual.label)}</span>
        </div>
      </header>
    `;
  }

  function renderSportMetricsRow(pick) {
    const evPct = pick.evNum != null ? pick.evNum * 100 : null;
    const risk = getRiskMetric(pick);
    return `
      <div class="t-metrics">
        <div class="t-metric">
          <div class="t-metric-label">EV</div>
          <div class="t-metric-val ${metricClass(evPct, 5, 3)}">${pick.evNum != null ? text(pick.ev) : "N/D"}</div>
        </div>
        <div class="t-metric">
          <div class="t-metric-label">Confianza</div>
          <div class="t-metric-val ${metricClass(pick.confianza, 62, 58)}">${Math.round(pick.confianza)}%</div>
        </div>
        ${renderDropMetricCell(pick)}
        <div class="t-metric">
          <div class="t-metric-label">Riesgo</div>
          <div class="t-metric-val ${metricClass(100 - risk, 70, 56)}">${risk}%</div>
        </div>
      </div>
    `;
  }

  function renderTennisMetrics(pick) {
    const evPct = pick.evNum != null ? pick.evNum * 100 : null;
    const risk = getRiskMetric(pick);
    return `
      <div class="t-metrics">
        <div class="t-metric">
          <div class="t-metric-label">EV</div>
          <div class="t-metric-val ${metricClass(evPct, 5, 3)}">${pick.evNum != null ? text(pick.ev) : "N/D"}</div>
        </div>
        <div class="t-metric">
          <div class="t-metric-label">Confianza</div>
          <div class="t-metric-val ${metricClass(pick.confianza, 62, 58)}">${Math.round(pick.confianza)}%</div>
        </div>
        ${renderDropMetricCell(pick)}
        <div class="t-metric">
          <div class="t-metric-label">Riesgo</div>
          <div class="t-metric-val ${metricClass(100 - risk, 70, 56)}">${risk}%</div>
        </div>
      </div>
    `;
  }

  function renderTennisSchedule(pick) {
    const match = pick.eventContext || {};
    const surface = getSurfaceInfo(pick);
    const tournament = match.tournament || match.league?.name || "";
    const scheduleMarkup = typeof renderPickScheduleMarkup === "function"
      ? renderPickScheduleMarkup(pick, { inlineSport: false })
      : text(pick.hora || "");
    return `
      <div class="t-pick-schedule">
        ${surface.label ? `<span class="t-surface-dot ${surface.cls}"></span>` : ""}
        <span>${tournament ? `${text(tournament)} · ` : ""}${scheduleMarkup}${surface.label ? ` · ${text(surface.label)}` : ""}</span>
      </div>
    `;
  }

  function renderDanyTennisPickCard(pick, index) {
    const visual = getVisualState(pick);
    const trackedState = getTrackedStateForEntry(pick);
    const participants = getParticipantBlocks(pick);
    const senalDoble = pick.senalDoble
      ? `<div class="t-senal-doble">SEÑAL DOBLE · ${text(pick.ev)}${getDropMetric(pick.raw) ? ` · Drop ${text(getDropMetric(pick.raw))}` : ""}</div>`
      : "";
    const sharpBadge = pick.droppingOddsSignal === "confirmed"
      ? `<div class="sharp-signal-badge is-confirmed">\u{1F4C9} SHARP ${Math.round(pick.drop12h || 0)}% (12h)</div>`
      : pick.droppingOddsSignal === "faded"
        ? `<div class="sharp-signal-badge is-faded">⚠️ FADE SHARP ${Math.round(pick.drop12h || 0)}% (12h)</div>`
        : "";
    const isTopPick = isTopValuePick(pick);
    const topBadge = isTopPick ? `<div class="t-alta-confianza">TOP PICK</div>` : "";

    return `
      <article class="t-pick ${visual.tennis} analysis-proposal is-tennis-pick${isTopPick ? " is-top-pick" : ""}${pick._homeTopPick ? " is-home-top-pick" : ""}">
        <div class="t-pick-bar"></div>
        <div class="t-pick-body">
          ${renderPickCardHeader(pick, index, visual)}
          ${renderTennisSchedule(pick)}
          <div class="t-pick-match">${text(pick.partido)}</div>
          <div class="t-pick-selection">${text(pick.pick)}</div>
          ${topBadge}
          ${senalDoble}
          ${sharpBadge}
          ${participants.length ? `<div class="t-players-row">${participants.map(renderParticipantBlock).join("")}</div>` : ""}
          ${renderSportNarrativeBlock(pick)}
          ${renderBestPriceRow(pick.raw || {}, "dany")}
          ${renderSportMetricsRow(pick)}
          ${visual.key !== "lean" ? renderDanyStakeBox(pick.evNum, pick.cuota, "tennis", visual, pick.confianza) : ""}
          ${renderTrackerActionRow(trackedState, { pickId: pick.id }, { showDetail: true })}
        </div>
      </article>
    `;
  }

  function renderFootballBody(pick) {
    const match = pick.eventContext || {};
    const expectedGoals = toNumber(match.matchModel?.expectedGoals);
    const expectedCorners = toNumber(match.matchModel?.expectedCorners);
    const expectedCards = toNumber(match.matchModel?.expectedCards);
    const chips = [];
    const reasons = Array.isArray(pick.pricingSignal?.reasons) ? pick.pricingSignal.reasons.slice(0, 3) : [];
    reasons.forEach((reason) => chips.push(`<span class="f-ev-chip">${text(reason)}</span>`));
    if (match.h2h?.dominantMarketLabel) chips.push(`<span class="f-ev-chip">${text(match.h2h.dominantMarketLabel)}</span>`);

    return `
      <div class="f-body">
        <div class="f-h2h">
          <div class="f-h2h-stat">
            <div class="f-h2h-val ${stripClass(expectedGoals, 3, 2.2)}">${expectedGoals != null ? expectedGoals.toFixed(1) : "N/D"}</div>
            <div class="f-h2h-label">xG total</div>
          </div>
          <div class="f-h2h-stat">
            <div class="f-h2h-val ${stripClass(expectedCorners, 10, 8)}">${expectedCorners != null ? expectedCorners.toFixed(1) : "N/D"}</div>
            <div class="f-h2h-label">Corners</div>
          </div>
          <div class="f-h2h-stat">
            <div class="f-h2h-val ${stripClass(expectedCards, 4.5, 3.5)}">${expectedCards != null ? expectedCards.toFixed(1) : "N/D"}</div>
            <div class="f-h2h-label">Tarjetas</div>
          </div>
          ${match.h2h?.dominantMarketLabel ? `<div class="f-h2h-note">H2H: <strong style="color:var(--good)">${text(match.h2h.dominantMarketLabel)}</strong></div>` : ""}
        </div>
        ${renderBestPriceRow(pick.raw || {}, "dany")}
        ${chips.length ? `<div class="f-evidence-chips">${chips.join("")}</div>` : ""}
        ${pick.note ? `<div class="f-rationale">${text(pick.note)}</div>` : ""}
        ${pick.tarjetasInfo ? `<div class="f-risk">Tarjetas · linea ${text(pick.tarjetasInfo.linea)} ${text(pick.tarjetasInfo.betSide || "")}</div>` : ""}
      </div>
    `;
  }

  function renderDanyFutbolPickCard(pick, index) {
    const isCardsMarket = String(pick?.mercado || "").toLowerCase().includes("booking");
    const hasReferee = Boolean(String(pick?.raw?.referee || pick?.eventContext?.referee || "").trim());
    if (isCardsMarket && !hasReferee) return "";
    const visual = getVisualState(pick);
    const trackedState = getTrackedStateForEntry(pick);
    const isFutbolTopPick = isTopValuePick(pick);
    const senalDoble = pick.senalDoble
      ? `<div class="t-senal-doble">SEÑAL DOBLE · ${text(pick.ev)}${getDropMetric(pick.raw) ? ` · Drop ${text(getDropMetric(pick.raw))}` : ""}</div>`
      : "";
    const sharpBadge = pick.droppingOddsSignal === "confirmed"
      ? `<div class="sharp-signal-badge is-confirmed">\u{1F4C9} SHARP ${Math.round(pick.drop12h || 0)}% (12h)</div>`
      : pick.droppingOddsSignal === "faded"
        ? `<div class="sharp-signal-badge is-faded">⚠️ FADE SHARP ${Math.round(pick.drop12h || 0)}% (12h)</div>`
        : "";
    const topBadge = isFutbolTopPick ? `<div class="t-alta-confianza">TOP PICK</div>` : "";
    const scheduleParts = typeof buildPickScheduleParts === "function" ? buildPickScheduleParts(pick) : {};
    const schedule = renderPickScheduleRow(pick) || (pick.statusInfo?.isLive ? `<div class="t-pick-schedule">${renderLiveInline(pick.statusInfo)}</div>` : "");
    const liveClass = scheduleParts.statusInfo?.isLive ? " is-live" : "";

    return `
      <article class="t-pick ${visual.tennis} analysis-proposal is-futbol-pick${liveClass}${isFutbolTopPick ? " is-top-pick" : ""}${pick._homeTopPick ? " is-home-top-pick" : ""}">
        <div class="t-pick-bar"></div>
        <div class="t-pick-body">
          ${renderPickCardHeader(pick, index, visual)}
          ${schedule}
          <div class="t-pick-match">${text(pick.partido)}</div>
          <div class="t-pick-selection">${text(pick.pick)}</div>
          ${topBadge}
          ${senalDoble}
          ${sharpBadge}
          ${renderSportNarrativeBlock(pick)}
          ${renderBestPriceRow(pick.raw || {}, "dany")}
          ${renderSportMetricsRow(pick)}
          ${visual.key !== "lean" ? renderDanyStakeBox(pick.evNum, pick.cuota, "tennis", visual, pick.confianza) : ""}
          ${renderTrackerActionRow(trackedState, { pickId: pick.id }, { showDetail: true })}
        </div>
      </article>
    `;
  }

  function renderPickScheduleRow(pick) {
    if (typeof renderPickScheduleBlock === "function") {
      return renderPickScheduleBlock(pick, { inlineSport: false });
    }
    return pick?.hora ? `<div class="t-pick-schedule"><span>${text(pick.hora)}</span></div>` : "";
  }

  function renderDanyProPickCard(pick, index, sportClass) {
    const visual = getVisualState(pick);
    const trackedState = getTrackedStateForEntry(pick);
    const isTop = isTopValuePick(pick);
    const senalDoble = pick.senalDoble
      ? `<div class="t-senal-doble">SEÑAL DOBLE · ${text(pick.ev)}</div>`
      : "";
    const topBadge = isTop ? `<div class="t-alta-confianza">TOP PICK</div>` : "";
    const scheduleParts = typeof buildPickScheduleParts === "function" ? buildPickScheduleParts(pick) : {};
    const schedule = renderPickScheduleRow(pick);
    const liveClass = scheduleParts.statusInfo?.isLive ? " is-live" : "";

    return `
      <article class="t-pick ${visual.tennis} analysis-proposal ${sportClass}${liveClass}${isTop ? " is-top-pick" : ""}${pick._homeTopPick ? " is-home-top-pick" : ""}">
        <div class="t-pick-bar"></div>
        <div class="t-pick-body">
          ${renderPickCardHeader(pick, index, visual)}
          ${schedule}
          <div class="t-pick-match">${text(pick.partido)}</div>
          <div class="t-pick-selection">${text(pick.pick)}</div>
          ${topBadge}
          ${senalDoble}
          ${renderSportNarrativeBlock(pick)}
          ${renderBestPriceRow(pick.raw || {}, "dany")}
          ${renderSportMetricsRow(pick)}
          ${visual.key !== "lean" ? renderDanyStakeBox(pick.evNum, pick.cuota, "tennis", visual, pick.confianza) : ""}
          ${renderTrackerActionRow(trackedState, { pickId: pick.id }, { showDetail: true })}
        </div>
      </article>
    `;
  }

  function renderTrapBadgeForPick(pick, compact = false) {
    if (typeof renderLineTrapBlock === "function") {
      const raw = pick?.raw || pick;
      if (typeof isLineTrapPick === "function" && !isLineTrapPick(raw) && !pick?.lineTrapActive) return "";
      if (!pick?.lineTrapActive && raw?.line_movement?.tipo !== "LINEA_TRAMPA") return "";
      return renderLineTrapBlock(raw, { compact, explain: true });
    }
    if (typeof renderLineTrapBadge !== "function") return "";
    const raw = pick?.raw || pick;
    if (typeof isLineTrapPick === "function" && !isLineTrapPick(raw) && !pick?.lineTrapActive) return "";
    if (!pick?.lineTrapActive && raw?.line_movement?.tipo !== "LINEA_TRAMPA") return "";
    return renderLineTrapBadge(raw, { compact });
  }

  function renderDanyMlbPickCard(pick, index) {
    const visual = getVisualState(pick);
    const trackedState = getTrackedStateForEntry(pick);
    const isMlbTopPick = isTopValuePick(pick);
    const game = pick.eventContext || {};
    const senalDoble = pick.senalDoble
      ? `<div class="t-senal-doble">SEÑAL DOBLE · ${text(pick.ev)}</div>`
      : "";
    const topBadge = isMlbTopPick ? `<div class="t-alta-confianza">TOP PICK</div>` : "";
    const scheduleParts = typeof buildPickScheduleParts === "function" ? buildPickScheduleParts(pick) : {};
    const schedule = renderPickScheduleRow(pick);
    const mlbContext = [
      game.parkPlain || game.park,
      game.homePitcher?.name && game.awayPitcher?.name ? `${game.awayPitcher.name} @ ${game.homePitcher.name}` : "",
    ].filter(Boolean).join(" · ");
    const liveClass = scheduleParts.statusInfo?.isLive ? " is-live" : "";

    return `
      <article class="t-pick ${visual.tennis} analysis-proposal is-mlb-pick${liveClass}${isMlbTopPick ? " is-top-pick" : ""}${pick._homeTopPick ? " is-home-top-pick" : ""}${pick.lineTrapActive ? " has-line-trap" : ""}">
        <div class="t-pick-bar"></div>
        <div class="t-pick-body">
          ${renderPickCardHeader(pick, index, visual)}
          ${schedule}
          ${mlbContext ? `<div class="t-pick-schedule t-pick-schedule-sub"><span>${text(mlbContext)}</span></div>` : ""}
          <div class="t-pick-match">${text(pick.partido)}</div>
          <div class="t-pick-selection">${text(pick.pick)}</div>
          ${topBadge}
          ${renderTrapBadgeForPick(pick)}
          ${senalDoble}
          ${renderSportNarrativeBlock(pick)}
          ${renderBestPriceRow(pick.raw || {}, "dany")}
          ${renderSportMetricsRow(pick)}
          ${visual.key !== "lean" ? renderDanyStakeBox(pick.evNum, pick.cuota, "tennis", visual, pick.confianza) : ""}
          ${renderTrackerActionRow(trackedState, { pickId: pick.id }, { showDetail: true })}
        </div>
      </article>
    `;
  }

  function renderLegacyPickCardFactory(legacyFn) {
    return function renderLegacyPickCard(pick, index) {
      if (typeof legacyFn === "function") return legacyFn(pick, index);
      return "";
    };
  }

  function renderDanyAnalysisLine(item, featured, moduleId) {
    if (moduleId === "futbol") {
      const isCardsMarket = String(item?.mercado || "").toLowerCase().includes("booking");
      const hasReferee = Boolean(String(item?.raw?.referee || item?.eventContext?.referee || "").trim());
      if (isCardsMarket && !hasReferee) return "";
    }
    const trackedState = getTrackedStateForEntry(item);
    const visual = getVisualState(item);

    if (moduleId === "tennis") {
      return `
        <article class="t-pick ${visual.tennis} analysis-proposal">
          <div class="t-pick-bar"></div>
          <div class="t-pick-body">
            <div class="t-pick-topline">
              <span class="t-pick-market">${text(item.marketLabel || item.mercado || "Mercado")}</span>
              <span class="t-pick-badge ${visual.tb}">${text(featured ? "MEJOR LINEA" : visual.label)}</span>
            </div>
            <div class="t-pick-selection">${text(item.pick)}</div>
            ${renderSportNarrativeBlock(item)}
            ${renderBestPriceRow(item.raw || {}, "dany")}
            ${renderSportMetricsRow(item)}
            ${renderTrackerActionRow(trackedState, { analysisId: item.id })}
          </div>
        </article>
      `;
    }

    if (moduleId === "futbol") {
      const visual = getVisualState(item);
      return `
        <article class="t-pick ${visual.tennis} analysis-proposal is-futbol-pick">
          <div class="t-pick-bar"></div>
          <div class="t-pick-body">
            <div class="t-pick-topline">
              <span class="t-pick-market">${text(item.marketLabel || item.mercado || "Mercado")}</span>
              <span class="t-pick-badge ${visual.tb}">${text(featured ? "MEJOR LINEA" : visual.label)}</span>
            </div>
            <div class="t-pick-selection">${text(item.pick)}</div>
            ${renderSportNarrativeBlock(item)}
            ${renderBestPriceRow(item.raw || {}, "dany")}
            ${renderSportMetricsRow(item)}
            ${renderTrackerActionRow(trackedState, { analysisId: item.id })}
          </div>
        </article>
      `;
    }

    return null;
  }

  function renderFplPickLabel(item) {
    if (!item) return "";
    const toneCls = item.tone === "verde" ? "fpl-verde" : item.tone === "amarillo" ? "fpl-amarillo" : "";
    if (!toneCls) return "";
    const evText = item.evNum != null && item.evNum > 0 ? `EV ${item.ev}` : String(item.valueText || "N/D");
    return `
      <span class="f-pick-label ${toneCls}">
        <span class="fpl-val">${text(typeof trimText === "function" ? trimText(item.pick, 42) : item.pick)}</span>
        <span class="fpl-ev">${text(evText)}</span>
        ${renderBestPriceRow(item.raw || {}, "mini")}
      </span>
    `;
  }

  function renderDanyMatchRow(event, moduleId) {
    const hasPick = event.valueCount > 0;
    const hasAlt = !hasPick && event.leanCount > 0;
    const isOpen = STATE.expandedMatch[moduleId] === event.id;
    const statusInfo = typeof enrichStatusWithStartTime === "function"
      ? enrichStatusWithStartTime(
          typeof normalizeStatus === "function" ? normalizeStatus(event.status) : {},
          event.startIso
        )
      : (typeof normalizeStatus === "function" ? normalizeStatus(event.status) : {});
    const dateTag = event.startIso && typeof buildRelativeScheduleTag === "function"
      ? buildRelativeScheduleTag(event.startIso)
      : "";
    const timeLabel = statusInfo?.isLive
      ? renderLiveInline(statusInfo)
      : statusInfo?.isFinal
        ? '<span class="status-pill final">FINAL</span>'
        : event.startIso
          ? text(typeof fmtTimeMadrid === "function" ? fmtTimeMadrid(event.startIso) : event.fallbackTime || "")
          : text(event.fallbackTime || "");
    const metaSchedule = [dateTag ? `<span class="status-pill">${text(dateTag)}</span>` : "", timeLabel ? (statusInfo?.isLive || statusInfo?.isFinal ? timeLabel : `<span class="status-pill">${timeLabel} Madrid</span>`) : ""].filter(Boolean).join(" · ");
    const featuredGroups = event.analysisGroups
      .filter((group) => group.best?.tone === "verde" || group.best?.tone === "amarillo")
      .slice(0, 2);
    const rowClass = `f-match-row${moduleId === "tennis" ? " is-tennis" : ""}${hasPick ? " has-pick" : hasAlt ? " has-alt" : ""}${isOpen ? " is-open" : ""}`;

    return `
      <article class="${rowClass}">
        <button class="f-match-toggle" type="button" data-match-toggle="${text(event.id)}">
          <div class="f-match-head">
            <div style="min-width:0;flex:1">
              <div class="f-match-liga">${text(String(event.league || MODULES[moduleId].name).toUpperCase())}</div>
              <div class="f-match-teams">${text(event.label)}</div>
              ${featuredGroups.length
                ? `<div class="f-match-picks">${featuredGroups.map((group) => renderFplPickLabel(group.best)).join("")}</div>`
                : `<div class="f-match-empty">Sin picks de valor · ${event.analysisGroups.length} lineas analizadas</div>`}
            </div>
            <div class="f-match-meta">
              ${metaSchedule ? `<div class="f-match-hora">${metaSchedule}</div>` : ""}
              <span class="f-match-expand-hint">Detalle <span class="match-chevron">${isOpen ? "−" : "+"}</span></span>
            </div>
          </div>
        </button>
        ${isOpen ? renderExpandedMatch(event, moduleId) : ""}
      </article>
    `;
  }

  function renderDanyMatchRows(moduleId) {
    let rows = buildMatchRows(moduleId).slice().sort(sortMatchRowsByConfidence);
    if (moduleId === "futbol" || moduleId === "tennis") {
      rows = rows.filter((event) => (event.analyses?.length || 0) > 0);
    }
    if (!rows.length) {
      return `
        <div class="empty-state">
          <div class="empty-icon">${MODULES[moduleId].icon}</div>
          <div class="empty-msg">Sin partidos cargados todavia</div>
          <div class="empty-sub">Este modulo no devolvio eventos en este momento.</div>
        </div>
      `;
    }
    return `<div class="dany-matches-list">${rows.map((event) => renderDanyMatchRow(event, moduleId)).join("")}</div>`;
  }

  function picksGridClass(moduleId) {
    if (moduleId === "tennis") return "tennis-picks-grid";
    if (moduleId === "futbol") return "f-market-list";
    return "picks-grid";
  }

  function getDeskPriority(entry) {
    if (!entry) return 0;
    if (entry.estado === "verde" || entry.tone === "verde") return 2;
    if (entry.estado === "amarillo" || entry.tone === "amarillo") return 1;
    return 0;
  }

  function sortDeskPicksByConfidence(left, right) {
    const priorityDiff = getDeskPriority(right) - getDeskPriority(left);
    if (priorityDiff !== 0) return priorityDiff;
    const confidenceDiff = (right?.confianza || 0) - (left?.confianza || 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    const evDiff = (right?.evNum ?? -99) - (left?.evNum ?? -99);
    if (evDiff !== 0) return evDiff;
    return String(left?.pick || "").localeCompare(String(right?.pick || ""), "es");
  }

  function sortMatchRowsByConfidence(left, right) {
    const leftBest = (left?.analyses || [])
      .filter((item) => item?.tone === "verde" || item?.tone === "amarillo")
      .sort(sortDeskPicksByConfidence)[0];
    const rightBest = (right?.analyses || [])
      .filter((item) => item?.tone === "verde" || item?.tone === "amarillo")
      .sort(sortDeskPicksByConfidence)[0];
    const priorityDiff = getDeskPriority(rightBest) - getDeskPriority(leftBest);
    if (priorityDiff !== 0) return priorityDiff;
    const confidenceDiff = (rightBest?.confianza || 0) - (leftBest?.confianza || 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    const evDiff = (rightBest?.evNum ?? -99) - (leftBest?.evNum ?? -99);
    if (evDiff !== 0) return evDiff;
    const leftTime = left?.startIso ? new Date(left.startIso).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right?.startIso ? new Date(right.startIso).getTime() : Number.POSITIVE_INFINITY;
    return leftTime - rightTime;
  }

  function resolvePickDayBucket(pick) {
    if (!pick?.startIso) return "otro";
    if (typeof diffMadridDaysFromToday === "function") {
      const diff = diffMadridDaysFromToday(pick.startIso);
      if (diff === 0) return "hoy";
      if (diff === 1) return "manana";
    }
    if (typeof buildRelativeScheduleTag !== "function") return "otro";
    const tag = String(buildRelativeScheduleTag(pick.startIso) || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (tag.startsWith("HOY")) return "hoy";
    if (tag.startsWith("MANANA")) return "manana";
    return "otro";
  }

  function renderGroupedDeskPicks(moduleId, picks) {
    const buckets = { hoy: [], manana: [], otro: [] };
    picks.forEach((pick) => {
      const bucket = resolvePickDayBucket(pick);
      buckets[bucket].push(pick);
    });

    const sections = [];
    if (buckets.hoy.length) {
      sections.push(renderDeskSection(moduleId, "Hoy", "Partidos de hoy con datos mas fiables.", buckets.hoy));
    }
    if (buckets.manana.length) {
      sections.push(renderDeskSection(
        moduleId,
        "Mañana",
        "Alineaciones y relevos pueden cambiar antes del partido.",
        buckets.manana
      ));
    }
    if (buckets.otro.length) {
      sections.push(renderDeskSection(moduleId, "Otros", "", buckets.otro));
    }
    return sections.join("");
  }

  function renderMarketHistoryBanner(moduleId) {
    const cache = typeof window !== "undefined" ? window._backtestStatsCache : null;
    const byType = cache?.[moduleId]?.by_market_type;
    if (!byType) return "";

    const rows = Object.entries(byType)
      .filter(([, stats]) => (stats?.wins || 0) + (stats?.losses || 0) >= 3)
      .map(([type, stats]) => {
        const resolved = (stats.wins || 0) + (stats.losses || 0);
        const pct = stats.hitRatePct != null ? `${stats.hitRatePct}%` : "N/D";
        return `<span class="market-history-chip"><strong>${text(stats.label || type)}</strong> ${pct} (${resolved} picks)</span>`;
      });

    if (!rows.length) return "";

    return `
      <div class="market-history-banner">
        <span class="market-history-title">Historico del modelo</span>
        <div class="market-history-chips">${rows.join("")}</div>
      </div>
    `;
  }

  function renderDeskSection(moduleId, title, note, picks) {
    if (!picks.length) return "";
    return `
      <section class="desk-subsection">
        <div class="sec-head">
          <div class="sec-copy">
            <span class="sec-title">${text(title)}</span>
            <span class="sec-note">${text(note)}</span>
          </div>
          <div class="sec-line"></div>
        </div>
        <div class="${picksGridClass(moduleId)}">
          ${picks.map((pick, index) => renderPickCard(pick, index)).join("")}
        </div>
      </section>
    `;
  }

  window.installDanyPicksUI = function installDanyPicksUI() {
    const legacyRenderPickCard = typeof renderPickCard === "function" ? renderPickCard : null;
    const legacyRenderAnalysisLine = typeof renderAnalysisLine === "function" ? renderAnalysisLine : null;
    const legacyRenderDeskContent = typeof renderDeskContent === "function" ? renderDeskContent : null;
    const legacyRenderMatchRows = typeof renderMatchRows === "function" ? renderMatchRows : null;
    const legacyRenderTimeLine = typeof renderTimeLine === "function" ? renderTimeLine : null;
    const legacyRenderExpandedMatch = typeof renderExpandedMatch === "function" ? renderExpandedMatch : null;
    const renderLegacyPickCard = renderLegacyPickCardFactory(legacyRenderPickCard);

    renderPickCard = window.renderPickCard = function renderPickCardDany(pick, index) {
      const sportId = resolvePickSportIdLocal(pick);
      const cardPick = sportId && !pick?.sportId ? { ...pick, sportId } : pick;
      if (sportId === "tennis") return renderDanyTennisPickCard(cardPick, index);
      if (sportId === "futbol") return renderDanyFutbolPickCard(cardPick, index);
      if (sportId === "mlb") return renderDanyMlbPickCard(cardPick, index);
      if (sportId === "nba") return renderDanyProPickCard(cardPick, index, "is-nba-pick");
      if (sportId === "wnba") return renderDanyProPickCard(cardPick, index, "is-wnba-pick");
      if (sportId === "nfl") return renderDanyProPickCard(cardPick, index, "is-nfl-pick");
      return renderLegacyPickCard(cardPick, index);
    };

    renderAnalysisLine = window.renderAnalysisLine = function renderAnalysisLineDany(item, featured, moduleId) {
      const dany = moduleId ? renderDanyAnalysisLine(item, featured, moduleId) : null;
      if (dany) return dany;
      return typeof legacyRenderAnalysisLine === "function" ? legacyRenderAnalysisLine(item, featured) : "";
    };

    renderMatchRows = window.renderMatchRows = function renderMatchRowsDany(moduleId) {
      if (moduleId === "tennis" || moduleId === "futbol") return renderDanyMatchRows(moduleId);
      return typeof legacyRenderMatchRows === "function" ? legacyRenderMatchRows(moduleId) : "";
    };

    renderTimeLine = window.renderTimeLine = function renderTimeLineDany(pick) {
      if (typeof renderPickScheduleMarkup === "function") {
        return renderPickScheduleMarkup(pick, { inlineSport: true });
      }
      if (pick?.statusInfo?.isLive) {
        return `${text(pick.deporte)} · ${renderLiveInline(pick.statusInfo)}`;
      }
      if (typeof legacyRenderTimeLine === "function") return legacyRenderTimeLine(pick);
      return pick?.hora ? `${text(pick.deporte)} · ${text(pick.hora)}` : text(pick?.deporte || "");
    };

    renderExpandedMatch = window.renderExpandedMatch = function renderExpandedMatchDany(event, moduleId) {
      const trackerState = getTrackedStateForEvent(event, moduleId);
      const linesClass = moduleId === "tennis" || moduleId === "futbol" ? "analysis-lines dany-analysis-lines" : "analysis-lines";

      return `
        <div class="match-expand">
          <div class="match-detail-grid">
            <div class="detail-panel">
              <div class="detail-panel-head">
                <span class="detail-panel-title">Apuestas analizadas</span>
                <span class="detail-panel-note">${event.analysisGroups.length} lineas revisadas</span>
              </div>
              ${event.analyses.length
                ? `<div class="${linesClass}">${event.analyses.map((item) => renderAnalysisLine(item, event.bestIds.has(item.id), moduleId)).join("")}</div>`
                : '<div class="match-empty-note">Todavia no llegaron lineas analizadas para este partido.</div>'}
            </div>
            ${renderMatchContext(event, moduleId)}
          </div>
          <div class="match-track-actions">
            <button
              class="match-track-btn${trackerState.trackedCount ? " is-tracked" : ""}${!trackerState.canAdd && !trackerState.trackedCount ? " is-locked" : ""}"
              type="button"
              data-track-match-id="${text(event.id)}"
              data-track-match-module="${text(moduleId)}"
              ${trackerState.canAdd ? "" : "disabled"}
            >
              ${trackerState.trackedCount
                ? `${trackerState.trackedCount} en tracker`
                : trackerState.started
                  ? "Partido iniciado"
                  : `+ Añadir picks al tracker${trackerState.totalTrackable ? ` (${trackerState.totalTrackable})` : ""}`}
            </button>
            ${trackerState.trackedCount
              ? trackerState.canRemove
                ? `<button class="match-track-btn remove" type="button" data-untrack-match-id="${text(event.id)}" data-untrack-match-module="${text(moduleId)}">Quitar del tracker (${trackerState.trackedCount})</button>`
                : `<button class="match-track-btn is-locked" type="button" disabled>${text(trackerState.reason || "Bloqueado")}</button>`
              : ""}
          </div>
        </div>
      `;
    };

    renderDeskContent = window.renderDeskContent = function renderDeskContentDany(moduleId, tab) {
      if (tab !== "picks" && tab !== "alternativas") {
        return typeof legacyRenderDeskContent === "function" ? legacyRenderDeskContent(moduleId, tab) : "";
      }

      if (MODULE_LOADING[moduleId]) {
        return '<div class="loading-copy">Cargando informacion del modulo seleccionado...</div>';
      }
      if (!MODULE_LOADED[moduleId]) {
        return '<div class="loading-copy">Selecciona el modulo para cargar sus datos.</div>';
      }

      const picks = PICKS_CACHE[moduleId] || [];
      const valuePicks = picks
        .filter((pick) => (pick.estado === "verde" || isValueReadyPick(pick)) && !pick?.lineTrapActive && !pick?.raw?.lineTrapActive)
        .slice()
        .sort(typeof sortPicks === "function" ? sortPicks : sortDeskPicksByConfidence);
      const alternativas = picks
        .filter((pick) => pick.estado === "amarillo" && !isValueReadyPick(pick))
        .slice()
        .sort(sortDeskPicksByConfidence);

      if (tab === "alternativas" && !alternativas.length) {
        return `
          <div class="empty-state">
            <div class="empty-icon">${MODULES[moduleId].icon}</div>
            <div class="empty-msg">Sin alternativas hoy</div>
            <div class="empty-sub">No hay lineas accionables en este momento.</div>
          </div>
        `;
      }

      if (tab === "picks") {
        if (!valuePicks.length) {
          return `
            <div class="empty-state">
              <div class="empty-icon">${MODULES[moduleId].icon}</div>
              <div class="empty-msg">Sin picks de valor hoy</div>
              <div class="empty-sub">No hay lineas con EV positivo y mercado limpio en este momento.</div>
            </div>
          `;
        }

        return `
          ${renderMarketHistoryBanner(moduleId)}
          ${renderGroupedDeskPicks(moduleId, valuePicks)}
          ${moduleId === "futbol" && valuePicks.length ? renderTarjetasFutbol(valuePicks) : ""}
        `;
      }

      return `
        ${renderDeskSection(moduleId, "Alternativas Con Valor", "Senales positivas del modulo", alternativas)}
      `;
    };
  };
})();
