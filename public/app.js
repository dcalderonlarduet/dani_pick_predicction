import { filterBettableMatches, filterUpcomingDayMatches, isFutbolMatchBettable, isMlbGameBettable, isTennisMatchBettable } from "./bettable-events.js";
import { LEGEND, PITCHER_STATS, TEAM_STATS } from "./mlb-copy.js";
import { TENNIS_FACTORS, TENNIS_LEGEND, TENNIS_ODDS_TIERS } from "./tennis-copy.js";
import { renderTennisMatchCard } from "./tennis-match-card.js";

const MODULES = {
  tennis: {
    key: "tennis",
    label: "Tennis",
    title: "Tennis Oracle",
    status: "live",
    tagline: "ATP, WTA, singles y dobles con motor de factores y capa medica propia.",
    shortNote: "Workspace activo",
    subtabs: [
      { id: "overview", label: "Resumen" },
      { id: "picks", label: "Picks" },
      { id: "matches", label: "Partidos" },
      { id: "providers", label: "Proveedores" },
      { id: "signals", label: "Signals" },
    ],
  },
  mlb: {
    key: "mlb",
    label: "MLB",
    title: "MLB Desk",
    status: "live",
    tagline: "Pronósticos claros: equipos, abridores, carreras y apuestas explicadas en español sencillo.",
    shortNote: "Modulo live",
    subtabs: [
      { id: "picks", label: "Pronosticos" },
      { id: "board", label: "Board" },
      { id: "games", label: "Partidos" },
      { id: "stack", label: "Data stack" },
    ],
  },
  futbol: {
    key: "futbol",
    label: "Futbol",
    title: "Football Desk",
    status: "live",
    tagline: "Goles, corners, tiros, props y combinadas cruzando forma real con mercados del dia.",
    shortNote: "Modulo live",
    subtabs: [
      { id: "overview", label: "Resumen" },
      { id: "picks", label: "Picks" },
      { id: "matches", label: "Partidos" },
      { id: "stack", label: "Data stack" },
    ],
  },
};

const pageParams = new URLSearchParams(window.location.search);

function resolveInitialSport() {
  const requestedSport = pageParams.get("sport");
  return MODULES[requestedSport] ? requestedSport : "tennis";
}

function resolveRequestedDate() {
  const requestedDate = pageParams.get("date");
  return /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "") ? requestedDate : "";
}

const state = {
  activeSport: resolveInitialSport(),
  activeTabBySport: {
    tennis: "overview",
    mlb: "picks",
    futbol: "overview",
  },
  analysisBySport: {
    tennis: null,
    mlb: null,
    futbol: null,
  },
  loadingBySport: {
    tennis: false,
    mlb: false,
    futbol: false,
  },
  errorBySport: {
    tennis: null,
    mlb: null,
    futbol: null,
  },
  requestedDate: resolveRequestedDate(),
  footballExpandedMatchId: null,
  footballExpandedMarketId: null,
  footballShowStatsByMatch: {},
  tennisExpandedMarketId: null,
  tennisExpandedMatchId: null,
  tennisLesionOpen: {},
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatCoverage(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function formatDate(dateValue) {
  return new Date(dateValue).toLocaleString("es-ES", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

function formatOdds(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "N/D";
}

function formatMetric(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "N/D";
}

function formatPercent(value, digits = 0) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "N/D";
}

function formatSignedPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}%` : "N/D";
}

function formatEvPercentDisplay(value) {
  if (value == null || value === "") return "N/D";
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace("%", "").replace("+", "").replace(",", ".").trim());
    return formatSignedPercent(parsed);
  }
  return formatSignedPercent(value);
}

function formatCompactDateTime(dateValue) {
  if (!dateValue) return "";
  return new Date(dateValue).toLocaleString("es-ES", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function confidenceToneClass(confidence) {
  if (confidence >= 70) return "score-positive";
  if (confidence >= 55) return "score-neutral";
  return "score-negative";
}

function verdictCardClass(item) {
  if (item?.verdict === "valid" || item?.bettable) return "bet-valid";
  if (item?.verdict === "lean") return "bet-lean";
  return "bet-avoid";
}

function verdictBadgeClass(item) {
  return `verdict-badge ${verdictCardClass(item)}`;
}

function tennisPickCardClass(pick) {
  if (pick?.verdict) return verdictCardClass(pick);
  if (pick?.readyToBet) return "bet-valid";
  if (pick?.confidence >= 55) return "bet-lean";
  return "bet-avoid";
}

function resolveSurfaceKey(item) {
  if (item?.surfaceKey) return item.surfaceKey;
  const label = String(item?.surface || "hard").toLowerCase();
  if (label.includes("clay") || label.includes("tierra")) return "clay";
  if (label.includes("grass") || label.includes("hierba")) return "grass";
  if (label.includes("indoor") || label.includes("cubierto")) return "indoor";
  return "hard";
}

function tennisSurfaceClass(pick) {
  return `surface-${resolveSurfaceKey(pick)}`;
}

function renderTennisSurfaceBadge(pick) {
  const label = pick?.surfaceLabel || pick?.surface || "Pista";
  return `<span class="surface-badge ${tennisSurfaceClass(pick)}">${escapeHtml(label)}</span>`;
}

function renderTennisMatchInsight(pick) {
  const insight = pick.matchInsight;
  if (!insight) return "";

  const probs = insight.probabilities || {};
  const probBlock =
    pick.type === "winner"
      ? `
        <div class="match-probability-box">
          <p class="${probs.matchWin >= 0.58 ? "metric-good" : "metric-neutral"}"><strong>${escapeHtml(probs.matchWinLabel || "")}</strong></p>
          ${probs.setWinLabel ? `<p class="${probs.setWin >= 0.62 ? "metric-good" : "metric-neutral"}">${escapeHtml(probs.setWinLabel)}</p>` : ""}
        </div>
      `
      : pick.type === "totals"
        ? `
        <div class="match-probability-box">
          <p class="metric-good"><strong>${escapeHtml(probs.gamesLabel || "")}</strong></p>
          <p>${escapeHtml(probs.leanLabel || "")} · confianza del modelo ${formatPercent(probs.confidence)}</p>
        </div>
      `
        : "";

  return `
    <div class="tennis-match-insight">
      ${renderTennisSurfaceBadge(pick)}
      <p class="match-h2h-line ${insight.hasH2h ? "metric-good" : "metric-neutral"}">${escapeHtml(insight.h2hLine)}</p>
      ${probBlock}
    </div>
  `;
}

function playerStatusToneClass(tone) {
  if (tone === "good") return "metric-good";
  if (tone === "bad") return "metric-bad";
  return "metric-neutral";
}

function renderEventSchedule(item) {
  const schedule = item?.schedule;
  if (!schedule) return "";

  return `
    <div class="event-schedule-bar">
      <p class="schedule-tournament">
        <strong>${escapeHtml(schedule.tournament || "Evento")}</strong>
        ${schedule.round ? `<span> · ${escapeHtml(schedule.round)}</span>` : ""}
      </p>
      <p class="schedule-datetime">
        ${escapeHtml(schedule.dateLabel || "")}
        ${schedule.timeLabel ? ` · <strong>${escapeHtml(schedule.timeLabel)}</strong>` : ""}
        ${schedule.venue ? ` · ${escapeHtml(schedule.venue)}` : ""}
      </p>
    </div>
  `;
}

function renderOddsComparison(item) {
  const compare = item?.oddsComparison;
  if (!compare) return "";

  const retailClass =
    !Number.isFinite(compare.retailOdd)
      ? "metric-bad"
      : Number.isFinite(compare.oddsGap) && compare.oddsGap >= 0.1
        ? "metric-good"
        : "metric-neutral";
  const sharpClass =
    !Number.isFinite(compare.sharpOdd)
      ? "metric-bad"
      : Number.isFinite(compare.oddsGap) && compare.oddsGap <= -0.1
        ? "metric-good"
        : "metric-neutral";
  const evLine =
    Number.isFinite(item?.evPercent)
      ? `<p class="odds-compare-note">EV ${item.evPercent > 0 ? "+" : ""}${item.evPercent}% · ${escapeHtml(item.valueLabel || "Sin valor")} ${item.valueBook ? `· mejor para ${escapeHtml(item.valueBook)}` : ""}</p>`
      : "";

  return `
    <div class="odds-compare-box">
      <p class="odds-compare-title">Comparativa de cuotas</p>
      <div class="odds-compare-grid">
        <div>
          <span class="metric-label">${escapeHtml(compare.sharpBook || "Bet365")}</span>
          <strong class="${sharpClass}">${formatOdds(compare.sharpOdd)}</strong>
        </div>
        <div>
          <span class="metric-label">${escapeHtml(compare.retailBook || "Winamax FR")}</span>
          <strong class="${retailClass}">${formatOdds(compare.retailOdd ?? compare.winamaxOdd)}</strong>
        </div>
      </div>
      ${evLine}
      <p class="odds-compare-note">${escapeHtml(compare.comparisonNote || "")}</p>
    </div>
  `;
}

function renderTennisPlayerStatus(pick) {
  const rows = pick.participantInsights || [];
  if (!rows.length) return "";

  return `
    <div class="tennis-player-status">
      <p class="player-status-heading">Estado de cada jugadora</p>
      ${rows
        .map(
          (row) => `
            <div class="player-status-row ${row.isPick ? "is-pick" : ""}">
              <div class="player-status-name">
                <strong>${escapeHtml(row.name)}</strong>
                ${row.isPick ? `<span class="pick-player-tag">Tu apuesta</span>` : ""}
              </div>
              <div class="player-status-lines">
                <p>
                  <span class="metric-label">En pista</span>
                  <span class="${playerStatusToneClass(row.surfaceRecord?.tone)}">${escapeHtml(row.surfaceRecord?.label || "N/D")}</span>
                </p>
                <p>
                  <span class="metric-label">Forma</span>
                  <span class="${playerStatusToneClass(row.recentRecord?.tone)}">${escapeHtml(row.recentRecord?.label || "N/D")}</span>
                </p>
                ${
                  row.h2hRecord?.label
                    ? `<p>
                  <span class="metric-label">H2H</span>
                  <span class="${playerStatusToneClass(row.h2hRecord.tone)}">${escapeHtml(row.h2hRecord.label)}</span>
                </p>`
                    : ""
                }
                ${
                  row.setWinProb != null
                    ? `<p>
                  <span class="metric-label">1 set</span>
                  <span class="${row.setWinProb >= 0.62 ? "metric-good" : "metric-neutral"}">Prob. ganar un set: ${formatPercent(row.setWinProb)}</span>
                </p>`
                    : ""
                }
                <p>
                  <span class="metric-label">Descanso</span>
                  <span class="${playerStatusToneClass(row.restTone)}">${escapeHtml(row.restLabel)}</span>
                </p>
                <p>
                  <span class="metric-label">Médico</span>
                  <span class="${playerStatusToneClass(row.medicalTone)}">${escapeHtml(row.medicalLabel)}</span>
                  ${
                    row.hasMedicalRisk
                      ? `<span class="medical-risk-flag ${row.medicalLevel === "red" ? "severe" : ""}">⚠ Riesgo médico</span>`
                      : ""
                  }
                </p>
                ${
                  row.hasMedicalRisk && row.medicalNote
                    ? `<p class="player-status-note">${escapeHtml(row.medicalNote)}</p>`
                    : ""
                }
              </div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTennisCompactPickCard(pick, index, mode = "safe") {
  const failTone =
    pick.failRisk <= 22 ? "metric-good" : pick.failRisk <= 35 ? "metric-neutral" : "metric-bad";

  return `
    <article class="pick-card tennis-compact-card ${tennisSurfaceClass(pick)} ${tennisPickCardClass(pick)}">
      <div class="pick-topline">
        <span class="pick-rank">${mode === "lean" ? `Idea ${index + 1}` : `#${pick.rank || index + 1}`}</span>
        <span class="pick-market">${escapeHtml(pick.market)}</span>
        <span class="${verdictBadgeClass(pick)}">${escapeHtml(pick.oddsTierLabel || pick.verdictLabel || TENNIS_ODDS_TIERS[pick.oddsTier] || "")}</span>
      </div>
      ${renderEventSchedule(pick)}
      ${renderTennisMatchInsight(pick)}
      <h3 class="pick-title">${escapeHtml(pick.matchLabel)}</h3>
      <p class="pick-selection">${escapeHtml(pick.selection)}</p>
      ${renderOddsComparison(pick)}
      <div class="pick-metrics tennis-metrics-compact">
        <div>
          <span class="metric-label">Cuota usada</span>
          <strong class="${pick.odds >= 1.5 ? "metric-good" : pick.odds ? "metric-neutral" : "metric-bad"}">${formatOdds(pick.odds)}</strong>
        </div>
        <div>
          <span class="metric-label">EV</span>
          <strong class="${pick.evPercent >= 10 ? "metric-good" : pick.evPercent >= 5 ? "metric-neutral" : "metric-bad"}">${Number.isFinite(pick.evPercent) ? `${pick.evPercent > 0 ? "+" : ""}${pick.evPercent}%` : "N/D"}</strong>
        </div>
        <div>
          <span class="metric-label">Confianza</span>
          <strong class="${confidenceToneClass(pick.confidence)}">${pick.confidence}%</strong>
        </div>
        <div>
          <span class="metric-label">Riesgo fallo</span>
          <strong class="${failTone}">${pick.failRisk ?? "N/D"}%</strong>
        </div>
      </div>
      ${renderTennisPlayerStatus(pick)}
      ${pick.totalProjection != null ? `<p class="pick-meta-line">Proyección: <strong>${formatMetric(pick.totalProjection, 1)}</strong> juegos · ${escapeHtml(pick.bookmaker || "sin casa")}</p>` : `<p class="pick-meta-line">${escapeHtml(pick.bookmaker || "Sin cuota emparejada")}</p>`}
      ${pick.repeatValue ? `<p class="pick-meta-line repeat-value">Valor repetido en el modelo (alta probabilidad sostenida)</p>` : ""}
    </article>
  `;
}

function renderTennisParlayCard(parlay, index) {
  const failTone =
    parlay.combinedFailRisk <= 24 ? "metric-good" : parlay.combinedFailRisk <= 36 ? "metric-neutral" : "metric-bad";

  return `
    <article class="pick-card tennis-parlay-card bet-valid">
      <div class="pick-topline">
        <span class="pick-rank">Combinada ${index + 1}</span>
        <span class="pick-market">Cuota total ${formatOdds(parlay.totalOdds)}</span>
        <span class="verdict-badge bet-valid">${parlay.repeatValue ? "Alta fiabilidad" : "Combinada sugerida"}</span>
      </div>
      <div class="parlay-legs">
        <p><strong>1.</strong> ${escapeHtml(parlay.selections[0].selection)} <span class="metric-good">${formatOdds(parlay.selections[0].odds)}</span></p>
        <p><strong>2.</strong> ${escapeHtml(parlay.selections[1].selection)} <span class="metric-good">${formatOdds(parlay.selections[1].odds)}</span></p>
      </div>
      <div class="pick-metrics tennis-metrics-compact">
        <div>
          <span class="metric-label">Nota combinada</span>
          <strong class="${confidenceToneClass(parlay.comboScore)}">${parlay.comboScore}/100</strong>
        </div>
        <div>
          <span class="metric-label">EV combinado</span>
          <strong class="${parlay.combinedEVPercent >= 10 ? "metric-good" : parlay.combinedEVPercent >= 5 ? "metric-neutral" : "metric-bad"}">${Number.isFinite(parlay.combinedEVPercent) ? `+${parlay.combinedEVPercent}%` : "N/D"}</strong>
        </div>
        <div>
          <span class="metric-label">Riesgo fallo</span>
          <strong class="${failTone}">${parlay.combinedFailRisk}%</strong>
        </div>
      </div>
      <p class="pick-meta-line">${escapeHtml(parlay.rationale)}</p>
    </article>
  `;
}

function renderTennisPickSection(title, note, items, fallbackMode) {
  if (!items.length) return "";
  return `
    <section class="tennis-pick-section">
      <div class="section-header">
        <div>
          <h2 class="section-title">${title}</h2>
        </div>
        <p class="section-note">${note}</p>
      </div>
      <div class="picks-grid">
        ${items.map((item, index) => renderTennisCompactPickCard(item, index, fallbackMode ? "lean" : "safe")).join("")}
      </div>
    </section>
  `;
}

function metricToneClass(value, baseline, lowerIsBetter = false) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return "metric-neutral";
  const delta = value - baseline;
  if (lowerIsBetter) {
    if (delta < -0.05) return "metric-good";
    if (delta > 0.05) return "metric-bad";
  } else {
    if (delta > 0.05) return "metric-good";
    if (delta < -0.05) return "metric-bad";
  }
  return "metric-neutral";
}

function providerClass(provider) {
  if (provider.status === "manual-required" || provider.status === "rules-only" || provider.status === "partial") {
    return "provider-card manual";
  }
  if (provider.status === "missing-credentials") {
    return "provider-card warning";
  }
  return "provider-card";
}

function getActiveAnalysis() {
  return state.analysisBySport[state.activeSport];
}

function isDataUnavailable(analysis) {
  return analysis?.dataAvailable === false;
}

function dayEventsForSport(data, sport) {
  if (!data) return [];
  const source = sport === "mlb" ? data.games || [] : data.matches || [];
  return filterUpcomingDayMatches(source, sport, data.date);
}

function isBettableEvent(item, sport, date) {
  if (sport === "mlb") return isMlbGameBettable(item, date);
  if (sport === "futbol") return isFutbolMatchBettable(item, date);
  return isTennisMatchBettable(item, date);
}

function getAnalysisMeta(analysis) {
  if (!analysis) {
    return {
      events: 0,
      picks: 0,
      ready: 0,
      providers: 0,
    };
  }

  if (isDataUnavailable(analysis)) {
    return {
      events: 0,
      picks: 0,
      ready: 0,
      providers: analysis.providers?.length || 0,
    };
  }

  if (analysis.sport === "mlb") {
    return {
      events: analysis.slateSummary?.gamesToday ?? analysis.games?.length ?? 0,
      picks: analysis.picks?.length || 0,
      ready: analysis.picks?.length || 0,
      providers: analysis.providers?.length || 0,
    };
  }

  if (analysis.sport === "futbol") {
    return {
      events: analysis.slateSummary?.matchesToday ?? analysis.matches?.length ?? 0,
      picks: analysis.picks?.length || 0,
      ready: analysis.slateSummary?.readyRecommendations || 0,
      providers: analysis.providers?.length || 0,
    };
  }

  return {
    events: analysis.slateSummary?.matchesToday ?? analysis.matches?.length ?? 0,
    picks: analysis.picks?.length || 0,
    ready: analysis.slateSummary?.readyRecommendations || 0,
    providers: analysis.providers?.length || 0,
  };
}

function sportMetaLine(module, analysis, loading) {
  if (loading) return "cargando datos";
  if (module.status !== "live") return "shell lista para conectar providers";
  if (!analysis) return "pipeline listo";
  if (isDataUnavailable(analysis)) return "datos no disponibles";

  if (module.key === "mlb") {
    const runsCount = analysis.runsPicks?.length || 0;
    return analysis.picks.length
      ? `${analysis.picks.length} validos - ${runsCount} carreras`
      : `${analysis.modelPicks?.length || analysis.leans.length} pronosticos modelo`;
  }

  if (module.key === "futbol") {
    const corners = analysis.cornersPicks?.length || 0;
    return analysis.picks.length
      ? `${analysis.picks.length} verdes - ${corners} corners`
      : `${analysis.trendPicks?.length || 0} patrones activos`;
  }

  const matched = analysis.slateSummary?.oddsMatched ?? 0;
  const safe = analysis.picks?.length || 0;
  const combos = analysis.parlays?.length || 0;
  const legs = analysis.comboLegs?.length || 0;
  if (safe || combos) {
    return `${safe} seguras · ${combos} combinadas · ${matched} cuotas`;
  }
  return `${legs || analysis.modelLeans?.length || 0} ideas · ${matched} emparejadas`;
}

function moduleHeadline(module) {
  if (module.key === "mlb") {
    return "Pronósticos en español claro: primero estadísticas de equipos, luego abridores y apuestas (ganador, carreras, hándicap).";
  }

  if (module.key === "tennis") {
    return "Pronósticos de ganador y total de juegos con factores de superficie, forma, fatiga y cuotas Odds-API.io cuando hay match.";
  }

  if (module.key === "futbol") {
    return "Pronosticos de futbol con goles, corners, tiros de equipo, tiros de jugador y combinadas a partir de forma reciente, lideres de produccion y mercado real.";
  }

  return "Este modulo aun no consume datos, pero la estructura visual y de navegacion ya existe para conectarlo con su propio pipeline.";
}

function renderBrandBar(analysis) {
  const runtimeData = analysis?.runtime?.dataProvider || "pending";
  const runtimeOdds = analysis?.runtime?.oddsProvider || "pending";
  const unavailable = isDataUnavailable(analysis);

  return `
    <section class="brand-bar">
      <div class="brand-mark">
        <span class="brand-orb"></span>
        <div>
          <span class="brand-kicker">Multi-sport intelligence platform</span>
          <p class="brand-title">Sports Oracle Workspace</p>
        </div>
      </div>
      <div class="runtime-pill-row">
        <span class="runtime-pill live">Docker live</span>
        <span class="runtime-pill">${escapeHtml(runtimeData)} data</span>
        <span class="runtime-pill">${escapeHtml(runtimeOdds)} odds</span>
        ${unavailable ? `<span class="runtime-pill warning">datos no disponibles</span>` : ""}
      </div>
    </section>
  `;
}

function renderHero(analysis) {
  const meta = getAnalysisMeta(analysis);

  return `
    <section class="hero-card">
      <div class="hero-grid">
        <div>
          <span class="mini-label">Sports modeling shell</span>
          <h1 class="hero-title">One workspace. Many sports.</h1>
          <p class="hero-copy">
            La shell esta pensada para crecer por modulos: cada deporte trae su propio scoring, proveedores, zonas de riesgo y paneles de lectura sin romper la experiencia visual.
          </p>
        </div>
        <div class="hero-side">
          <p class="hero-note">
            El objetivo no es solo ver picks. Es abrir una mesa moderna de analisis donde convivan contexto, cobertura, mercado y notas de riesgo con una jerarquia visual clara.
          </p>
          <div class="metric-strip">
            <article class="metric-card">
              <span class="metric-label">Eventos</span>
              <strong>${meta.events}</strong>
            </article>
            <article class="metric-card">
              <span class="metric-label">Picks</span>
              <strong>${meta.picks}</strong>
            </article>
            <article class="metric-card">
              <span class="metric-label">Providers</span>
              <strong>${meta.providers}</strong>
            </article>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderSportTabs() {
  return `
    <section class="sport-tab-row">
      ${Object.values(MODULES)
        .map((module) => {
          const isActive = state.activeSport === module.key;
          const analysis = state.analysisBySport[module.key];
          const loading = state.loadingBySport[module.key];

          return `
            <button class="sport-tab ${isActive ? "active" : ""}" type="button" data-action="select-sport" data-sport="${module.key}">
              <div class="sport-tab-head">
                <div>
                  <span class="tab-kicker">${module.shortNote}</span>
                  <h2 class="sport-tab-title">${module.label}</h2>
                </div>
                <span class="sport-tab-pill ${module.status === "live" ? "live" : "future"}">${module.status === "live" ? "live" : "next"}</span>
              </div>
              <p class="sport-tab-copy">${module.tagline}</p>
              <div class="sport-tab-meta">
                <span class="sport-status">${sportMetaLine(module, analysis, loading)}</span>
                <span class="sport-status">${module.status === "live" ? "routing live" : "module shell"}</span>
              </div>
            </button>
          `;
        })
        .join("")}
    </section>
  `;
}

function renderSubtabs(module) {
  const activeTab = state.activeTabBySport[module.key];
  return `
    <nav class="subtab-bar" aria-label="Module sections">
      ${module.subtabs
        .map(
          (tab) => `
            <button class="subtab ${activeTab === tab.id ? "active" : ""}" type="button" data-action="select-tab" data-sport="${module.key}" data-tab="${tab.id}">
              <span class="subtab-kicker">${module.label}</span>
              <strong>${tab.label}</strong>
            </button>
          `
        )
        .join("")}
    </nav>
  `;
}

function renderLoadingCard(message) {
  return `
    <section class="loading-card">
      <div class="pulse"></div>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

function renderErrorCard(message) {
  return `
    <section class="loading-card">
      <div class="pulse"></div>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

function renderUnavailableCard(module, analysis) {
  const reason =
    analysis?.unavailableReason ||
    analysis?.methodology?.note ||
    "Datos no disponibles. No se cargaron fuentes reales ni se ejecuto el analisis del dia.";

  return `
    <section class="unavailable-card">
      <span class="mini-label">${escapeHtml(module.label)} · sin datos reales</span>
      <h2 class="unavailable-title">Datos no disponibles</h2>
      <p class="unavailable-copy">${escapeHtml(reason)}</p>
      <p class="section-note">Revisa las credenciales en <code>.env</code> y reinicia Docker. La clave comun para tenis, MLB y futbol es <code>ODDS_API_IO_KEY</code>; tenis puede enriquecer el analisis con <code>MATCHSTAT_RAPIDAPI_KEY</code>.</p>
      ${
        analysis?.providers?.length
          ? `<div class="chip-row">${analysis.providers
              .map(
                (provider) =>
                  `<span class="chip ${provider.status === "configured" ? "positive" : "warning"}">${escapeHtml(provider.name)} · ${escapeHtml(provider.status)}</span>`
              )
              .join("")}</div>`
          : ""
      }
    </section>
  `;
}

function renderOverviewPanel(data) {
  const runtimeLine = data.runtime
    ? `Datos: ${data.runtime.dataProvider}. Cuotas: ${data.runtime.oddsProvider}.`
    : "";
  const fallbackLine = "";
  const oddsLine = data.slateSummary?.oddsMatched != null
    ? `Cuotas emparejadas: ${data.slateSummary.oddsMatched}/${data.slateSummary.matchesAnalyzed} partidos del slate.`
    : "";
  const topThree = [...(data.picks || []).slice(0, 3), ...(data.parlays || []).slice(0, 1)].slice(0, 3);
  const providerSummary = data.providers
    .map((provider) => `<span class="chip">${escapeHtml(provider.name)} - ${escapeHtml(provider.status)}</span>`)
    .join("");

  return `
    <div class="tab-panel">
      <section class="top-row">
        <article class="overview-card">
          <span class="mini-label">Motor</span>
          <h2 class="section-title">Analisis trazable y modular</h2>
          <p>${escapeHtml(data.methodology.principle)}</p>
          <div class="overview-grid">
            <div class="overview-stat">
              <span class="metric-label">Partidos hoy</span>
              <strong>${data.slateSummary.matchesToday ?? data.matches?.length ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Apuestas verdes</span>
              <strong>${data.slateSummary.matchesBettable ?? data.slateSummary.matchesAnalyzed ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Picks</span>
              <strong>${data.picks.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Seguras ≥1.50</span>
              <strong>${data.picks?.length || 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Combinadas</span>
              <strong>${data.parlays?.length || 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Cuotas OK</span>
              <strong>${data.slateSummary.oddsMatched ?? 0}/${data.slateSummary.matchesAnalyzed}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Cobertura medica</span>
              <strong>${formatCoverage(data.coverage.medical)}</strong>
            </div>
          </div>
        </article>
        <article class="overview-card">
          <span class="mini-label">Runtime</span>
          <h2 class="section-title">Provider activo y techo de confianza</h2>
          <p>${escapeHtml(data.methodology.confidenceCaps)}</p>
          <p class="section-note">
            Fecha de analisis (Madrid): ${escapeHtml(data.date)}. Ultima generacion: ${formatDate(data.generatedAt)}.
            Odds stale: ${data.stalenessMinutes.odds} min. Medical stale: ${data.stalenessMinutes.medical} min.
          </p>
          <p class="section-note">${escapeHtml(runtimeLine)} ${escapeHtml(oddsLine)} ${escapeHtml(fallbackLine)}</p>
          <div class="module-chip-row">${providerSummary}</div>
        </article>
      </section>
      <section class="legend-bar">
        <span class="verdict-badge bet-valid">${TENNIS_LEGEND.valid}</span>
        <span class="verdict-badge bet-lean">${TENNIS_LEGEND.lean}</span>
        <span class="verdict-badge bet-avoid">${TENNIS_LEGEND.avoid}</span>
      </section>
      <section class="insight-grid">
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Top 3</span>
              <h2 class="section-title">Picks de foco rapido</h2>
            </div>
            <p class="section-note">Solo apuestas verdes validadas (simples y combinadas).</p>
          </div>
          <div class="factor-list">
            ${topThree.length
              ? topThree
                  .map(
                    (pick) => `
                  <div class="recommendation-chip ${tennisPickCardClass(pick)}">
                    <strong>${escapeHtml(pick.label)} — <span class="${confidenceToneClass(pick.confidence)}">${pick.confidence}/100</span> — ${escapeHtml(pick.bookmaker || "sin cuota")} ${formatOdds(pick.odds)}</strong>
                    ${pick.participantInsights ? renderTennisPlayerStatus(pick) : ""}
                    <p>${escapeHtml(pick.verdictLabel || pick.rationale)}</p>
                  </div>
                `
                  )
                  .join("")
              : `<div class="factor-chip"><strong>Sin picks destacados</strong><p>No hay confianza suficiente hoy; revisa la pestaña Partidos.</p></div>`}
          </div>
        </article>
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Combinadas</span>
              <h2 class="section-title">Doble segura (1.50 – 2.20)</h2>
            </div>
          </div>
          <div class="factor-list">
            ${
              (data.parlays || []).length
                ? data.parlays
                    .map(
                      (parlay, index) => `
                        <div class="recommendation-chip bet-valid">
                          <strong>Combinada ${index + 1} · ${formatOdds(parlay.totalOdds)}</strong>
                          <p>${escapeHtml(parlay.selections[0].selection)} + ${escapeHtml(parlay.selections[1].selection)}</p>
                          <p>Riesgo estimado ${parlay.combinedFailRisk}%</p>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="factor-chip"><strong>Sin combinada hoy</strong><p>Hace falta dos patas fiables en partidos distintos.</p></div>`
            }
          </div>
        </article>
      </section>
    </div>
  `;
}

function renderPicksPanel(data) {
  const safeItems = data.picks || [];
  const parlays = data.parlays || [];
  const hasGreen = safeItems.length > 0 || parlays.length > 0;

  return `
    <div class="tab-panel tennis-picks-panel">
      <section class="legend-bar">
        <span class="verdict-badge bet-valid">${TENNIS_LEGEND.valid}</span>
        <span class="legend-hint">Solo apuestas verdes: simples ≥1.50 y combinadas validadas.</span>
      </section>
      ${
        hasGreen
          ? `${renderTennisPickSection(
              "Apuestas simples seguras (cuota ≥ 1.50)",
              "Alta confianza, margen de valor y menor riesgo estimado de fallo.",
              safeItems,
              false
            )}${
              parlays.length
                ? `
        <section class="tennis-pick-section">
          <div class="section-header">
            <div><h2 class="section-title">Combinadas sugeridas</h2></div>
            <p class="section-note">Dos patas verdes que suman entre 1.50 y 2.20 de cuota total.</p>
          </div>
          <div class="picks-grid">${parlays.map((parlay, index) => renderTennisParlayCard(parlay, index)).join("")}</div>
        </section>`
                : ""
            }`
          : `<section class="overview-card"><p class="section-note">Hoy no hay apuestas verdes. Revisa la pestaña Partidos para ver el calendario completo del dia.</p></section>`
      }
    </div>
  `;
}

function renderMatchesPanel(data) {
  const matches = dayEventsForSport(data, "tennis");

  return `
    <div class="tab-panel tennis-matches-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Matriz</span>
            <h2 class="section-title">Partidos del dia (Madrid)</h2>
          </div>
          <p class="section-note">Cabecera con forma, pista y alertas medicas. Las mejores apuestas aparecen primero; las sin valor quedan atenuadas.</p>
        </div>
        <div class="matches-grid tennis-matches-grid">
          ${
            matches.length
              ? matches
                  .map((match) =>
                    renderTennisMatchCard(match, {
                      analysisDate: data.date,
                      isBettable: isBettableEvent(match, "tennis", data.date),
                      surfaceClass: tennisSurfaceClass(match),
                      expandedMarketId:
                        state.tennisExpandedMatchId === match.id ? state.tennisExpandedMarketId : null,
                      openLesions: state.tennisLesionOpen,
                    })
                  )
                  .join("")
              : `<p class="section-note">Hoy no hay partidos pendientes en el calendario (fecha Madrid: ${escapeHtml(data.date)}).</p>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderProvidersPanel(data) {
  return `
    <div class="tab-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Fuentes</span>
            <h2 class="section-title">Providers desacoplados</h2>
          </div>
          <p class="section-note">La shell ya esta lista para que cada deporte enchufe su propio stack de schedule, odds y signals.</p>
        </div>
        <div class="provider-grid">
          ${data.providers
            .map(
              (provider) => `
                <article class="${providerClass(provider)}">
                  <span class="provider-status">${escapeHtml(provider.status)}</span>
                  <h3>${escapeHtml(provider.name)}</h3>
                  <p>${escapeHtml(provider.purpose)}</p>
                  ${provider.notes ? `<p>${escapeHtml(provider.notes)}</p>` : ""}
                  ${
                    provider.docs && String(provider.docs).startsWith("http")
                      ? `<p><strong>Docs:</strong> <a href="${escapeHtml(provider.docs)}" target="_blank" rel="noreferrer">${escapeHtml(provider.docs)}</a></p>`
                      : ""
                  }
                  <p><strong>Candidatos prod:</strong> ${provider.productionCandidates.map(escapeHtml).join(", ")}</p>
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderSignalsPanel() {
  return `
    <div class="tab-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Signals layer</span>
            <h2 class="section-title">Factores delicados y capa medica</h2>
          </div>
          <p class="section-note">Esta vista prepara el terreno para lo que mas diferencia hace en precision real: contexto, lesiones, carga y validacion humana.</p>
        </div>
        <div class="signal-grid">
          <article class="signal-card">
            <span class="mini-label">Medical</span>
            <h3>Lesiones, retiros y MTO</h3>
            <p>Se combina lectura automatica de resultados recientes con overrides manuales para evitar que una sola API dicte el riesgo medico.</p>
            <ul>
              <li>retiros recientes</li>
              <li>walkovers o estados anormales</li>
              <li>flags manuales por jugador o pareja</li>
            </ul>
          </article>
          <article class="signal-card">
            <span class="mini-label">Load</span>
            <h3>Carga, descanso e inactividad</h3>
            <p>El modelo ya contempla tiempo sin competir, minutos recientes, fatiga del ultimo partido y acumulacion en la misma jornada.</p>
            <ul>
              <li>descanso corto</li>
              <li>parones largos</li>
              <li>doble carga singles + dobles</li>
            </ul>
          </article>
          <article class="signal-card">
            <span class="mini-label">Surface</span>
            <h3>Superficie y overrides</h3>
            <p>La shell permite corregir superficies por torneo para no depender ciegamente de un feed cuando falte ese dato o venga ambiguo.</p>
            <ul>
              <li>clay, hard, grass, indoor</li>
              <li>adaptacion por historial</li>
              <li>ajuste de tempo del partido</li>
            </ul>
          </article>
        </div>
      </section>
    </div>
  `;
}

function renderMlbFeatureCard(item, index, isPickMode) {
  const note = isPickMode
    ? `${escapeHtml(item.market)} · Casa: ${escapeHtml(item.bookmaker || "sin dato")} · Cuota ${formatOdds(item.odds)}`
    : "Idea del modelo; aún no hay cuota cargada para validar la apuesta";

  return `
    <article class="spotlight-card ${verdictCardClass(item)}">
      <div class="spotlight-head">
        <span class="pick-rank">Destacado ${index + 1}</span>
        <span class="${verdictBadgeClass(item)}">${escapeHtml(item.verdictLabel || (isPickMode ? LEGEND.valid : LEGEND.lean))}</span>
      </div>
      ${renderEventSchedule(item)}
      ${renderOddsComparison(item)}
      <span class="spotlight-market">${escapeHtml(item.market)}</span>
      <h3 class="spotlight-title">${escapeHtml(item.matchLabel)}</h3>
      <p class="spotlight-selection">${escapeHtml(item.selection)}</p>
      <div class="spotlight-score-row">
        <strong class="spotlight-score ${confidenceToneClass(item.confidence)}">${item.confidence}/100</strong>
        <span class="spotlight-note">${note}</span>
      </div>
      ${item.totalProjection != null ? `<p class="spotlight-copy"><span class="metric-label">Carreras esperadas en el partido</span> <strong class="${metricToneClass(item.totalProjection, 8.5)}">${formatMetric(item.totalProjection, 1)}</strong></p>` : ""}
      <p class="spotlight-copy">${escapeHtml(item.rationale)}</p>
    </article>
  `;
}

function renderMlbScoreFactor(factor) {
  const label = factor.label || factor.key;
  const help = factor.help || "Peso de este bloque en la nota final del pronóstico.";
  const value = factor.value ?? factor;
  const numeric = Number(value);
  const tone = Number.isFinite(numeric)
    ? numeric >= 8
      ? "metric-good"
      : numeric <= 3
        ? "metric-bad"
        : "metric-neutral"
    : "metric-neutral";
  return `
    <div class="factor-chip">
      <strong>${escapeHtml(label)} <span class="${tone}">${escapeHtml(String(value))}</span></strong>
      <p>${escapeHtml(help)}</p>
    </div>
  `;
}

function renderMlbTeamStatsBlock(prediction) {
  if (!prediction) return "";

  return `
    <section class="team-stats-prediction">
      <div class="section-header compact">
        <h4 class="subsection-title">Pronóstico por estadísticas de equipos</h4>
        <p class="section-note">Lectura aparte de la línea de apuestas: resume quién debería ganar y cuántas carreras se esperan según bateo, pitcheo y relevo.</p>
      </div>
      <div class="prediction-grid">
        <article class="prediction-card metric-good">
          <span class="metric-label">Favorito para ganar</span>
          <strong>${escapeHtml(prediction.winnerPick)}</strong>
          <p>${escapeHtml(prediction.winnerSummary)}</p>
        </article>
        <article class="prediction-card">
          <span class="metric-label">Total de carreras esperado</span>
          <strong>${escapeHtml(prediction.totalRunsPick)}</strong>
          <p>${escapeHtml(prediction.totalRunsPlain)}</p>
        </article>
      </div>
      <div class="team-outlook-grid">
        <article class="team-outlook-card">
          <span class="metric-label">Visitante</span>
          <strong>${escapeHtml(prediction.awayOutlook.teamName)} (${escapeHtml(prediction.awayOutlook.record)})</strong>
          <p>${escapeHtml(prediction.awayOutlook.narrative)}</p>
        </article>
        <article class="team-outlook-card">
          <span class="metric-label">Local</span>
          <strong>${escapeHtml(prediction.homeOutlook.teamName)} (${escapeHtml(prediction.homeOutlook.record)})</strong>
          <p>${escapeHtml(prediction.homeOutlook.narrative)}</p>
        </article>
      </div>
    </section>
  `;
}

function renderMlbRecommendationCard(item, index, fallbackMode) {
  const scoreFactors =
    item.scoreFactors ||
    Object.entries(item.scoreBreakdown || {}).map(([key, value]) => ({ key, label: key, help: "", value }));
  const riskFlags = item.riskFlags || [];
  const projectionLine =
    item.totalProjection != null
      ? `<p class="pick-selection">Carreras esperadas en el partido: <strong class="${metricToneClass(item.totalProjection, 8.5)}">${formatMetric(item.totalProjection, 1)}</strong>${item.type === "totals" ? ` (comparado con la línea de la casa de apuestas)` : ""}</p>`
      : "";

  return `
    <article class="pick-card mlb-pick-card ${verdictCardClass(item)}">
      <div class="pick-topline">
        <span class="pick-rank">${fallbackMode ? `Idea ${index + 1}` : `Mejor ${index + 1}`}</span>
        <span class="pick-market">${escapeHtml(item.market)}</span>
        <span class="${verdictBadgeClass(item)}">${escapeHtml(item.verdictLabel || (item.confidence >= 70 ? LEGEND.valid : item.confidence >= 55 ? LEGEND.lean : LEGEND.avoid))}</span>
      </div>
      ${renderEventSchedule(item)}
      <h3 class="pick-title">${escapeHtml(item.matchLabel)}</h3>
      <p class="pick-selection">${escapeHtml(item.selection)}</p>
      ${projectionLine}
      ${renderOddsComparison(item)}
      <div class="pick-metrics">
        <div>
          <span class="metric-label">Nivel de confianza</span>
          <strong class="${confidenceToneClass(item.confidence)}">${item.confidence}/100</strong>
        </div>
        <div>
          <span class="metric-label">Cuota usada</span>
          <strong class="${item.odds ? "metric-good" : "metric-bad"}">${formatOdds(item.odds)}</strong>
        </div>
        <div>
          <span class="metric-label">Probabilidad del modelo</span>
          <strong class="${item.modelProbability != null && item.modelProbability >= 0.55 ? "metric-good" : "metric-neutral"}">${item.modelProbability != null ? formatPercent(item.modelProbability) : "N/D"}</strong>
        </div>
      </div>
      <p class="pick-rationale">${escapeHtml(item.rationale)}</p>
      <div class="factor-list">
        ${scoreFactors.map((factor) => renderMlbScoreFactor(factor)).join("")}
      </div>
      <ul class="risk-list">
        ${riskFlags.map((flag) => `<li>${escapeHtml(flag)}</li>`).join("")}
      </ul>
    </article>
  `;
}

function renderMlbPitcherPanel(pitcher, teamName, sideLabel) {
  const runMetric = Number.isFinite(pitcher.xFip30) ? pitcher.xFip30 : pitcher.era30;
  return `
    <article class="duel-card pitcher-card">
      <span class="mini-label">${escapeHtml(sideLabel)} · ${escapeHtml(teamName)}</span>
      <h4>${escapeHtml(pitcher.name)}</h4>
      <p class="pitcher-record">
        <span class="metric-label">${PITCHER_STATS.record.label}</span>
        <strong>${escapeHtml(pitcher.record?.label || "N/D")}</strong> ·
        ${escapeHtml(pitcher.handLabelFull || pitcher.handLabel)}
      </p>
      <div class="pitcher-stat-grid">
        <div title="${escapeHtml(PITCHER_STATS.xFIP.help)}">
          <span class="metric-label">${PITCHER_STATS.xFIP.label}</span>
          <strong class="${metricToneClass(runMetric, 4.05, true)}">${formatMetric(runMetric)}</strong>
          <p class="stat-help">${escapeHtml(PITCHER_STATS.xFIP.help)}</p>
        </div>
        <div title="${escapeHtml(PITCHER_STATS.WHIP.help)}">
          <span class="metric-label">${PITCHER_STATS.WHIP.label}</span>
          <strong class="${metricToneClass(pitcher.whip30, 1.22, true)}">${formatMetric(pitcher.whip30)}</strong>
          <p class="stat-help">${escapeHtml(PITCHER_STATS.WHIP.help)}</p>
        </div>
        <div title="${escapeHtml(PITCHER_STATS.K9.help)}">
          <span class="metric-label">${PITCHER_STATS.K9.label}</span>
          <strong class="${metricToneClass(pitcher.k9, 7.5)}">${formatMetric(pitcher.k9)}</strong>
          <p class="stat-help">${escapeHtml(PITCHER_STATS.K9.help)}</p>
        </div>
        <div title="${escapeHtml(PITCHER_STATS.rest.help)}">
          <span class="metric-label">${PITCHER_STATS.rest.label}</span>
          <strong class="${pitcher.restDays >= 5 ? "metric-good" : "metric-bad"}">${pitcher.restDays} días</strong>
          <p class="stat-help">${escapeHtml(PITCHER_STATS.rest.help)}</p>
        </div>
      </div>
    </article>
  `;
}

function renderMlbTeamPanel(team, projectedRuns, lineTotal) {
  const offense = team.offense;
  return `
    <article class="team-panel">
      <div class="team-panel-head">
        <strong>${escapeHtml(team.name)}</strong>
        <span class="team-record" title="Victorias-Derrotas en temporada">Récord ${escapeHtml(team.record?.label || "N/D")}</span>
      </div>
      <div class="team-stat-grid">
        <div>
          <span class="metric-label">${TEAM_STATS.scoredRecent.label}</span>
          <strong class="${metricToneClass(offense.runsLast10, offense.seasonRunsPerGame)}">${formatMetric(offense.runsLast10, 1)}</strong>
          <p class="stat-help">${escapeHtml(TEAM_STATS.scoredRecent.help)}</p>
        </div>
        <div>
          <span class="metric-label">${TEAM_STATS.allowedRecent.label}</span>
          <strong class="${metricToneClass(offense.allowedLast10, offense.seasonRunsPerGame, true)}">${formatMetric(offense.allowedLast10, 1)}</strong>
          <p class="stat-help">${escapeHtml(TEAM_STATS.allowedRecent.help)}</p>
        </div>
        <div>
          <span class="metric-label">${TEAM_STATS.scoredSeason.label}</span>
          <strong>${formatMetric(offense.seasonRunsPerGame, 1)}</strong>
          <p class="stat-help">${escapeHtml(TEAM_STATS.scoredSeason.help)}</p>
        </div>
        <div>
          <span class="metric-label">${TEAM_STATS.projected.label}</span>
          <strong class="${metricToneClass(projectedRuns, lineTotal / 2)}">${formatMetric(projectedRuns, 1)}</strong>
          <p class="stat-help">${escapeHtml(TEAM_STATS.projected.help)}</p>
        </div>
      </div>
    </article>
  `;
}

function renderMlbRecommendationRow(item) {
  return `
    <div class="recommendation-chip ${verdictCardClass(item)}">
      <div class="recommendation-chip-head">
        <strong>${escapeHtml(item.market)}</strong>
        <span class="${verdictBadgeClass(item)}">${escapeHtml(item.verdictLabel)}</span>
      </div>
      ${renderEventSchedule(item)}
      ${renderOddsComparison(item)}
      <p><span class="${confidenceToneClass(item.confidence)}">${item.confidence}/100</span> - ${escapeHtml(item.selection)}${item.odds ? ` - ${formatOdds(item.odds)}` : ""}</p>
      ${item.totalProjection != null ? `<p>Carreras esperadas: <strong class="${metricToneClass(item.totalProjection, 8.5)}">${formatMetric(item.totalProjection, 1)}</strong></p>` : ""}
      <p>${escapeHtml(item.rationale)}</p>
    </div>
  `;
}

function renderMlbBoardPanel(data) {
  const featured = (data.picks.length ? data.picks : data.leans).slice(0, 3);
  const pickMode = data.picks.length > 0;
  const providerSummary = data.providers
    .map((provider) => `<span class="chip">${escapeHtml(provider.name)} - ${escapeHtml(provider.status)}</span>`)
    .join("");

  return `
    <div class="tab-panel">
      <section class="top-row">
        <article class="overview-card">
          <span class="mini-label">Jornada MLB</span>
          <h2 class="section-title">Resumen del día</h2>
          <p>${escapeHtml(data.methodology.principle)}</p>
          <div class="overview-grid">
            <div class="overview-stat">
              <span class="metric-label">Juegos hoy</span>
              <strong>${data.slateSummary.gamesToday ?? data.games?.length ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Apuestas verdes</span>
              <strong>${data.slateSummary.gamesBettable ?? data.slateSummary.gamesAnalyzed ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Apuestas validadas</span>
              <strong>${data.picks.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Ideas del modelo</span>
              <strong>${data.leans.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Alineaciones confirmadas</span>
              <strong>${data.slateSummary.lineupsConfirmed}</strong>
            </div>
          </div>
        </article>
        <article class="overview-card">
          <span class="mini-label">Datos y avisos</span>
          <h2 class="section-title">De dónde salen los números</h2>
          <p>${escapeHtml(data.methodology.note)}</p>
          <p class="section-note">
            Fecha analizada (Madrid): ${escapeHtml(data.date)}. Última actualización: ${formatDate(data.generatedAt)}.
            Calendario actualizado hace ${data.stalenessMinutes.schedule} min · Cuotas hace ${data.stalenessMinutes.odds} min.
          </p>
          <div class="module-chip-row">${providerSummary}</div>
        </article>
      </section>
      <section class="featured-picks">
        ${featured.map((item, index) => renderMlbFeatureCard(item, index, pickMode)).join("")}
      </section>
      <section class="insight-grid">
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Combinadas</span>
              <h2 class="section-title">Apuestas combinadas</h2>
            </div>
            <p class="section-note">Solo si hay dos apuestas simples ya validadas (cuota y confianza altas).</p>
          </div>
          <div class="factor-list">
            ${
              data.parlays.length
                ? data.parlays
                    .map(
                      (parlay, index) => `
                        <div class="recommendation-chip">
                          <strong>Combinada ${index + 1} - cuota ${formatOdds(parlay.totalOdds)}</strong>
                          <p>${escapeHtml(parlay.selections[0].selection)} + ${escapeHtml(parlay.selections[1].selection)}</p>
                          <p>${escapeHtml(parlay.rationale)}</p>
                        </div>
                      `
                    )
                    .join("")
                : `<div class="factor-chip"><strong>No hay combinada sugerida</strong><p>Hace falta al menos dos apuestas validadas con nota 70/100 o más.</p></div>`
            }
          </div>
        </article>
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Riesgo</span>
              <h2 class="section-title">Notas operativas</h2>
            </div>
          </div>
          <div class="factor-list">
            ${data.riskNotes
              .map(
                (note) => `
                  <div class="factor-chip">
                    <strong>Control</strong>
                    <p>${escapeHtml(note)}</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      </section>
    </div>
  `;
}

function renderMlbPickSection(title, note, items, fallbackMode) {
  if (!items.length) return "";
  return `
    <section class="mlb-pick-section">
      <div class="section-header">
        <div>
          <h2 class="section-title">${title}</h2>
        </div>
        <p class="section-note">${note}</p>
      </div>
      <div class="picks-grid">
        ${items.map((item, index) => renderMlbRecommendationCard(item, index, fallbackMode)).join("")}
      </div>
    </section>
  `;
}

function renderMlbPicksPanel(data) {
  const validItems = data.picks || [];
  const parlays = data.parlays || [];
  const hasGreen = validItems.length > 0 || parlays.length > 0;

  return `
    <div class="tab-panel">
      <section class="legend-bar">
        <span class="verdict-badge bet-valid">${LEGEND.valid}</span>
        <span class="legend-hint">Solo apuestas verdes con cuota y confianza validadas.</span>
      </section>
      ${
        hasGreen
          ? `${validItems.length ? renderMlbPickSection("Apuestas validadas (verde)", "Cuota cargada, confianza ≥70 y valor del modelo.", validItems, false) : ""}${
              parlays.length
                ? `
        <section class="mlb-pick-section">
          <div class="section-header"><h2 class="section-title">Combinadas</h2></div>
          <div class="picks-grid">${parlays.map((item, index) => renderMlbRecommendationCard(item, index, false)).join("")}</div>
        </section>`
                : ""
            }`
          : `<section class="overview-card"><p class="section-note">Hoy no hay apuestas verdes en MLB. Revisa Partidos para ver todos los juegos del dia.</p></section>`
      }
    </div>
  `;
}

function renderMlbGameCard(game) {
  const lean = game.bestTeamPick || game.modelLean;
  const tierClass = confidenceToneClass(lean?.confidence || 0);
  const projections = game.projections || {};
  const totalTone = metricToneClass(projections.totalRuns, game.totalsLine);
  const diffTone =
    projections.diffVsLine > 0.35 ? "metric-good" : projections.diffVsLine < -0.35 ? "metric-bad" : "metric-neutral";

  return `
    <article class="match-card mlb-game-card ${verdictCardClass(lean)}">
      ${renderEventSchedule(game)}
      <div class="match-header">
        <div>
          <p class="match-category">${escapeHtml(game.status)} · ${escapeHtml(game.stadium)}</p>
          <h3 class="match-title">${escapeHtml(game.awayTeam.name)} (visitante) @ ${escapeHtml(game.homeTeam.name)} (local)</h3>
        </div>
        <div class="match-badges">
          <div class="badge">${escapeHtml(game.park.category)}</div>
          <span class="${verdictBadgeClass(lean)}">${escapeHtml(lean.verdictLabel || game.recommendationTier)}</span>
        </div>
      </div>
      <p class="match-meta">
        Hora: ${formatDate(game.startTime)}.
        Línea de apuestas (total carreras): <strong>${game.totalsLine}</strong>.
        Nuestro total esperado: <strong class="${totalTone}">${formatMetric(projections.totalRuns, 1)}</strong>
        (diferencia <span class="${diffTone}">${projections.diffVsLine > 0 ? "+" : ""}${formatMetric(projections.diffVsLine, 1)}</span>).
        Lectura general: <span class="${tierClass}">${escapeHtml(game.recommendationTier)}</span>
      </p>
      ${renderMlbTeamStatsBlock(game.teamStatsPrediction)}
      <div class="mlb-duel-grid">
        ${renderMlbPitcherPanel(game.awayPitcher, game.awayTeam.name, "Abridor visitante")}
        ${renderMlbPitcherPanel(game.homePitcher, game.homeTeam.name, "Abridor local")}
      </div>
      <div class="mlb-team-metrics">
        ${renderMlbTeamPanel(game.awayTeam, projections.awayRuns, game.totalsLine)}
        ${renderMlbTeamPanel(game.homeTeam, projections.homeRuns, game.totalsLine)}
      </div>
      <section class="game-picks-block">
        <div class="section-header compact">
          <h4 class="subsection-title">Apuestas sugeridas en este partido</h4>
          <p class="section-note">${LEGEND.valid} · ${LEGEND.lean} · ${LEGEND.avoid}</p>
        </div>
        <div class="match-recommendations">
          ${game.recommendations.map((item) => renderMlbRecommendationRow(item)).join("")}
        </div>
      </section>
      <div class="risk-chip-row">
        ${game.notes.map((note) => `<span class="chip warning-chip">${escapeHtml(note)}</span>`).join("")}
      </div>
    </article>
  `;
}

function renderMlbGamesPanel(data) {
  const games = dayEventsForSport(data, "mlb");

  return `
    <div class="tab-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Partidos del día</span>
            <h2 class="section-title">Juegos del dia (Madrid)</h2>
          </div>
          <p class="section-note">Todos los juegos de hoy sin finalizar. La etiqueta verde indica apuesta validada en Picks.</p>
        </div>
        <div class="matches-grid">
          ${
            games.length
              ? games
                  .map((game) => {
                    const bettable = isBettableEvent(game, "mlb", data.date);
                    return `
                      <div class="mlb-game-wrap">
                        ${bettable ? `<div class="chip-row"><span class="chip positive">Apuesta verde</span></div>` : `<div class="chip-row"><span class="chip">Sin apuesta verde</span></div>`}
                        ${renderMlbGameCard(game)}
                      </div>
                    `;
                  })
                  .join("")
              : `<p class="section-note">Hoy no hay juegos pendientes en el calendario (fecha Madrid: ${escapeHtml(data.date)}).</p>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderMlbStackPanel(data) {
  return `
    <div class="tab-panel">
      <section class="top-row">
        <article class="overview-card">
          <span class="mini-label">Coverage</span>
          <h2 class="section-title">Mapa de calidad MLB</h2>
          <div class="factor-list">
            ${Object.entries(data.coverage)
              .map(
                ([key, value]) => `
                  <div class="factor-chip">
                    <strong>${escapeHtml(key)} <span class="score-positive">${formatCoverage(value)}</span></strong>
                    <p>Capa cubierta por el pipeline actual del modulo MLB.</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
        <article class="overview-card">
          <span class="mini-label">Methodology</span>
          <h2 class="section-title">Que entra en el score</h2>
          <p>${escapeHtml(data.methodology.scoring)}</p>
          <p class="section-note">Datos oficiales de MLB (calendario, pitchers, alineaciones). Las cuotas entran solo si configuras The Odds API. Métricas avanzadas tipo Statcast siguen en progreso.</p>
        </article>
      </section>
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Providers</span>
            <h2 class="section-title">Stack del modulo MLB</h2>
          </div>
        </div>
        <div class="provider-grid">
          ${data.providers
            .map(
              (provider) => `
                <article class="${providerClass(provider)}">
                  <span class="provider-status">${escapeHtml(provider.status)}</span>
                  <h3>${escapeHtml(provider.name)}</h3>
                  <p>${escapeHtml(provider.purpose)}</p>
                  ${provider.notes ? `<p>${escapeHtml(provider.notes)}</p>` : ""}
                  ${
                    provider.docs && String(provider.docs).startsWith("http")
                      ? `<p><strong>Docs:</strong> <a href="${escapeHtml(provider.docs)}" target="_blank" rel="noreferrer">${escapeHtml(provider.docs)}</a></p>`
                      : ""
                  }
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function footballMarketStateConfig(item) {
  const stateKey =
    item?.displayState ||
    (item?.bettable ? "buena" : item?.verdict === "lean" ? "alternativa" : "opaca");
  const states = {
    mejor: { label: "MEJOR PICK", className: "state-best" },
    buena: { label: "RECOMENDADA", className: "state-good" },
    alternativa: { label: "ALTERNATIVA", className: "state-alt" },
    opaca: { label: "DESCARTAR", className: "state-fade" },
  };
  return states[stateKey] || states.opaca;
}

function footballMarketCode(item) {
  const codes = {
    result: "1X2",
    goals: "GOALS",
    "team-goals": "TEAM",
    corners: "CORN",
    shots: "SHOTS",
    "player-shots": "PROP",
  };
  return codes[item?.type] || "MARKET";
}

function footballRingTone(confidence) {
  if (confidence >= 72) return "#00ff88";
  if (confidence >= 60) return "#ffc800";
  return "#ff5a68";
}

function renderFootballConfidenceRing(value, size = 52) {
  const tone = footballRingTone(value || 0);
  return `
    <div class="football-confidence-ring" style="--ring-size:${size}px; --ring-value:${Math.max(0, Math.min(value || 0, 100))}; --ring-tone:${tone};">
      <span>${Math.round(value || 0)}%</span>
    </div>
  `;
}

function footballFormResults(team) {
  const recentMatches = team?.recent?.matches || [];
  if (recentMatches.length) {
    return recentMatches.slice(0, 5).map((match) => match.result || "D");
  }

  return String(team?.form?.sequence || "")
    .split("")
    .filter(Boolean)
    .slice(0, 5);
}

function renderFootballFormChips(team) {
  return footballFormResults(team)
    .map((result) => `<span class="football-form-chip result-${escapeHtml(String(result).toLowerCase())}">${escapeHtml(result)}</span>`)
    .join("");
}

function footballTeamStatusLabel(team) {
  if ((team?.recent?.teamScoreRate || 0) >= 0.8) return "Ataque caliente";
  if ((team?.recent?.cleanSheetRate || 0) >= 0.4) return "Bloque solido";
  return "Lectura mixta";
}

function renderFootballStatBar(label, value, max, tone, suffix = "") {
  const safeValue = Number.isFinite(value) ? value : 0;
  const width = max > 0 ? Math.min((safeValue / max) * 100, 100) : 0;
  return `
    <div class="football-stat-row">
      <div class="football-stat-row-head">
        <span>${escapeHtml(label)}</span>
        <strong style="color:${tone};">${formatMetric(safeValue, suffix === "%" ? 0 : 1)}${suffix}</strong>
      </div>
      <div class="football-stat-track">
        <div class="football-stat-fill" style="width:${width}%; background:${tone};"></div>
      </div>
    </div>
  `;
}

function renderFootballEvidenceChips(item, match) {
  const chips = [];
  const model = match?.matchModel || {};
  const team = item?.teamSide === "home" ? match?.homeTeam : item?.teamSide === "away" ? match?.awayTeam : null;

  if (item?.type === "result") {
    if (team?.record?.pointsPerGame != null) chips.push(`${team.name} ${formatMetric(team.record.pointsPerGame, 2)} ppg`);
    if (team?.season?.goalDiffPerGame != null) chips.push(`diff ${formatMetric(team.season.goalDiffPerGame, 2)}`);
    if (team?.form?.sequence) chips.push(`forma ${team.form.sequence}`);
  } else if (item?.type === "goals") {
    if (model.expectedGoals != null) chips.push(`modelo ${formatMetric(model.expectedGoals, 2)} goles`);
    if (match?.homeTeam?.recent?.over25Rate != null && match?.awayTeam?.recent?.over25Rate != null) {
      chips.push(`O2.5 ${Math.round((((match.homeTeam.recent.over25Rate || 0) + (match.awayTeam.recent.over25Rate || 0)) / 2) * 100)}%`);
    }
    if (match?.homeTeam?.recent?.bttsRate != null && match?.awayTeam?.recent?.bttsRate != null) {
      chips.push(`BTTS ${Math.round((((match.homeTeam.recent.bttsRate || 0) + (match.awayTeam.recent.bttsRate || 0)) / 2) * 100)}%`);
    }
  } else if (item?.type === "team-goals") {
    if (team?.recent?.goalsForAvg != null) chips.push(`${formatMetric(team.recent.goalsForAvg, 2)} GF recientes`);
    if (team?.recent?.teamScoreRate != null) chips.push(`marca ${formatPercent(team.recent.teamScoreRate)}`);
    if (item?.teamSide === "home" && model.expectedHomeGoals != null) chips.push(`modelo ${formatMetric(model.expectedHomeGoals, 2)} GF`);
    if (item?.teamSide === "away" && model.expectedAwayGoals != null) chips.push(`modelo ${formatMetric(model.expectedAwayGoals, 2)} GF`);
  } else if (item?.type === "corners") {
    if (model.expectedCorners != null) chips.push(`modelo ${formatMetric(model.expectedCorners, 1)} corners`);
    if (team?.leaders?.shots?.rate != null) chips.push(`shots leader ${formatMetric(team.leaders.shots.rate, 2)}`);
    if (item?.patternRate != null) chips.push(`patron ${Math.round(item.patternRate * 100)}%`);
  } else if (item?.type === "shots" || item?.type === "player-shots") {
    if (item?.teamSide === "home" && model.expectedHomeShots != null) chips.push(`modelo ${formatMetric(model.expectedHomeShots, 1)} tiros`);
    if (item?.teamSide === "away" && model.expectedAwayShots != null) chips.push(`modelo ${formatMetric(model.expectedAwayShots, 1)} tiros`);
    if (team?.leaders?.shots?.athlete) chips.push(`lider ${team.leaders.shots.athlete}`);
    if (item?.patternRate != null) chips.push(`patron ${Math.round(item.patternRate * 100)}%`);
  }

  return chips
    .slice(0, 3)
    .map((chip) => `<span class="football-evidence-chip">${escapeHtml(chip)}</span>`)
    .join("");
}

function findFootballMatchForPick(data, pick) {
  return (data.matches || []).find((match) => match.id === pick?.matchId) || null;
}

function footballMatchMeta(match) {
  const dateLabel = formatCompactDateTime(match?.scheduledAt);
  if (dateLabel && match?.stadium) return `${dateLabel} | ${match.stadium}`;
  return dateLabel || match?.stadium || "";
}

function renderFootballFactorList(item) {
  const factors = item.factors || [];
  if (!factors.length) return "";

  return `
    <div class="football-factor-grid">
      ${factors
        .slice(0, 3)
        .map(
          (factor) => `
            <div class="football-factor-chip">
              <strong>${escapeHtml(factor.label)}</strong>
              <p>${escapeHtml(factor.summary)}</p>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderFootballTeamPanel(team, sideLabel, sideClass) {
  return `
    <div class="football-duel-team ${sideClass}">
      <div class="football-team-crest">
        ${
          team?.logo
            ? `<img src="${escapeHtml(team.logo)}" alt="${escapeHtml(team.name)}" />`
            : `<span>${escapeHtml((team?.abbreviation || team?.name || "TM").slice(0, 3))}</span>`
        }
        <span class="football-crest-fallback">${escapeHtml((team?.abbreviation || team?.name || "TM").slice(0, 3))}</span>
      </div>
      <p class="football-team-side">${escapeHtml(sideLabel)}</p>
      <h3>${escapeHtml(team.name)}</h3>
      <p class="football-team-record">${escapeHtml(team.record?.label || "0-0-0")} | ${formatMetric(team.record?.pointsPerGame, 2)} ppg</p>
      <div class="football-form-row">${renderFootballFormChips(team)}</div>
      <div class="football-team-pill-row">
        <span class="football-team-pill">${escapeHtml(footballTeamStatusLabel(team))}</span>
        <span class="football-team-pill">${formatMetric(team.recent?.goalsForAvg, 2)} GF</span>
      </div>
    </div>
  `;
}

function renderFootballModelPanel(match) {
  const model = match.matchModel || {};
  const homeOver25 = match.homeTeam?.recent?.over25Rate || 0;
  const awayOver25 = match.awayTeam?.recent?.over25Rate || 0;
  const homeBtts = match.homeTeam?.recent?.bttsRate || 0;
  const awayBtts = match.awayTeam?.recent?.bttsRate || 0;

  return `
    <div class="football-duel-center">
      <div class="football-versus-mark">VS</div>
      <div class="football-duel-metrics">
        <div>
          <span>Modelo goles</span>
          <strong>${formatMetric(model.expectedGoals, 2)}</strong>
        </div>
        <div>
          <span>Split gol</span>
          <strong>${formatMetric(model.expectedHomeGoals, 2)} | ${formatMetric(model.expectedAwayGoals, 2)}</strong>
        </div>
        <div>
          <span>Corners proxy</span>
          <strong>${formatMetric(model.expectedCorners, 1)}</strong>
        </div>
        <div>
          <span>BTTS medio</span>
          <strong>${Math.round((((homeBtts + awayBtts) / 2) || 0) * 100)}%</strong>
        </div>
        <div>
          <span>Over 2.5</span>
          <strong>${Math.round((((homeOver25 + awayOver25) / 2) || 0) * 100)}%</strong>
        </div>
      </div>
    </div>
  `;
}

function renderFootballDetailedStats(match) {
  const teams = [
    { label: match.homeTeam.name, team: match.homeTeam, tone: "#4da6ff" },
    { label: match.awayTeam.name, team: match.awayTeam, tone: "#ff6ea8" },
  ];

  return `
    <div class="football-detail-grid">
      ${teams
        .map(
          ({ label, team, tone }) => `
            <div class="football-detail-column">
              <p class="football-detail-title" style="color:${tone};">${escapeHtml(label.toUpperCase())}</p>
              ${renderFootballStatBar("Goles recientes", team.recent?.goalsForAvg, 3.5, tone)}
              ${renderFootballStatBar("Goles encajados", team.recent?.goalsAgainstAvg, 3, "#ff8c42")}
              ${renderFootballStatBar("Points per game", team.record?.pointsPerGame, 3, tone)}
              ${renderFootballStatBar("BTTS", (team.recent?.bttsRate || 0) * 100, 100, "#ffc800", "%")}
              ${renderFootballStatBar("Over 2.5", (team.recent?.over25Rate || 0) * 100, 100, tone, "%")}
              ${renderFootballStatBar("Clean sheets", (team.recent?.cleanSheetRate || 0) * 100, 100, "#00ff88", "%")}
              ${team.leaders?.shots?.rate != null ? renderFootballStatBar("Tiros lider", team.leaders.shots.rate, 4.5, tone) : ""}
              <div class="football-detail-tags">
                ${team.leaders?.goals?.athlete ? `<span class="football-evidence-chip">gol ${escapeHtml(team.leaders.goals.athlete)} ${escapeHtml(team.leaders.goals.displayValue || "")}</span>` : ""}
                ${team.leaders?.shots?.athlete ? `<span class="football-evidence-chip">shots ${escapeHtml(team.leaders.shots.athlete)} ${formatMetric(team.leaders.shots.rate, 2)}/p</span>` : ""}
                <span class="football-evidence-chip">forma ${escapeHtml(team.form?.sequence || "N/D")}</span>
              </div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderFootballMarketCard(item, options = {}) {
  const config = footballMarketStateConfig(item);
  const match = options.match || null;
  const riskLines = (item.riskFlags || []).slice(0, 2);
  const bestBook = item.bookmaker || item.oddsComparison?.bestBookmaker || "Sin casa";
  const defaultOpen = Boolean(options.defaultOpen) && !state.footballExpandedMarketId;
  const isOpen = state.footballExpandedMarketId === item.id || defaultOpen;

  return `
    <article class="football-market-card ${config.className} ${options.featured ? "featured" : ""}">
      <button type="button" class="football-market-toggle" data-action="toggle-football-market" data-market-id="${escapeHtml(item.id)}">
        <div class="football-market-head">
          <div class="football-market-lead">
            <div class="football-market-kicker-row">
              <span class="football-market-code">${escapeHtml(footballMarketCode(item))}</span>
              <span class="football-market-badge">${escapeHtml(config.label)}</span>
              <span class="football-market-type">${escapeHtml(item.category || item.market)}</span>
            </div>
            ${options.showMatchLabel === false ? "" : `<p class="football-market-match">${escapeHtml(item.matchLabel)}</p>`}
            <p class="football-market-pick">${escapeHtml(item.selection)}</p>
            <p class="football-market-note">${escapeHtml(item.supportLabel || item.rationale || "")}</p>
          </div>
          <div class="football-market-side">
            <div class="football-market-price">
              <span>ODD</span>
              <strong>${formatOdds(item.odds)}</strong>
              <em>${escapeHtml(bestBook)}</em>
            </div>
            ${renderFootballConfidenceRing(item.confidence, options.featured ? 58 : 48)}
            <span class="football-market-chevron">${isOpen ? "UP" : "DOWN"}</span>
          </div>
        </div>
        <div class="football-market-strip">
          <div><span>EV</span><strong>${formatEvPercentDisplay(item.evPercent)}</strong></div>
          <div><span>Patron</span><strong>${Math.round((item.patternRate || 0) * 100)}%</strong></div>
          <div><span>Evidencia</span><strong>${Math.round((item.evidenceScore || 0) * 100)}%</strong></div>
          <div><span>Books</span><strong>${item.marketDepth || 0}</strong></div>
        </div>
      </button>
      ${
        isOpen
          ? `
        <div class="football-market-body">
          <div class="football-market-evidence-row">
            ${renderFootballEvidenceChips(item, match)}
          </div>
          ${renderOddsComparison(item)}
          ${renderFootballFactorList(item)}
          <p class="football-market-analysis">${escapeHtml(item.rationale || "")}</p>
          ${
            riskLines.length
              ? `<div class="football-market-risk-list">${riskLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`
              : ""
          }
        </div>
      `
          : ""
      }
    </article>
  `;
}

function renderFootballRecommendationRow(item) {
  return `
    <div class="recommendation-chip football-row ${verdictCardClass(item)}">
      <div class="recommendation-chip-head">
        <strong>${escapeHtml(item.selection)}</strong>
        <span class="${verdictBadgeClass(item)}">${escapeHtml(item.verdictLabel || "")}</span>
      </div>
      <p>${escapeHtml(item.market)} · cuota ${formatOdds(item.odds)} · confianza ${item.confidence}% · patron ${Math.round((item.patternRate || 0) * 100)}%</p>
      <p>${escapeHtml(item.supportLabel || item.rationale || "")}</p>
    </div>
  `;
}

function renderFootballPickSection(title, note, items, fallbackMode, data) {
  if (!items.length) return "";
  return `
    <section class="football-pick-section">
      <div class="section-header">
        <div>
          <h2 class="section-title">${title}</h2>
        </div>
        <p class="section-note">${note}</p>
      </div>
      <div class="football-market-stack">
        ${items
          .map((item, index) =>
            renderFootballMarketCard(item, {
              featured: index === 0 && !fallbackMode,
              match: findFootballMatchForPick(data, item),
              defaultOpen: index === 0 && !fallbackMode,
            })
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderFootballParlaysPanel(parlays = []) {
  if (!parlays.length) return "";

  return `
    <section class="football-pick-section">
      <div class="section-header">
        <div><h2 class="section-title">Combinadas</h2></div>
        <p class="section-note">Solo se quedan patas de partidos distintos y patron compatible para no forzar riesgo innecesario.</p>
      </div>
      <div class="football-market-stack">
        ${parlays
          .map(
            (parlay, index) => `
              <article class="football-market-card state-good">
                <div class="football-market-static">
                  <div class="football-market-kicker-row">
                    <span class="football-market-code">PARLAY</span>
                    <span class="football-market-badge">COMBINADA ${index + 1}</span>
                    <span class="football-market-type">Cuota ${formatOdds(parlay.totalOdds)}</span>
                  </div>
                  <p class="football-market-pick">${escapeHtml(parlay.selections[0].selection)}</p>
                  <p class="football-market-pick">${escapeHtml(parlay.selections[1].selection)}</p>
                  <div class="football-market-strip">
                    <div><span>Cuota</span><strong>${formatOdds(parlay.totalOdds)}</strong></div>
                    <div><span>Patron</span><strong>${Math.round((parlay.combinedPattern || 0) * 100)}%</strong></div>
                    <div><span>Score</span><strong>${parlay.comboScore}</strong></div>
                  </div>
                  <p class="football-market-analysis">${escapeHtml(parlay.rationale)}</p>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderFootballOverviewPanel(data) {
  const featured = (data.picks.length ? data.picks : data.trendPicks).slice(0, 3);
  const providerSummary = data.providers
    .map((provider) => `<span class="chip">${escapeHtml(provider.name)} - ${escapeHtml(provider.status)}</span>`)
    .join("");

  return `
    <div class="tab-panel">
      <section class="top-row">
        <article class="overview-card">
          <span class="mini-label">Jornada de futbol</span>
          <h2 class="section-title">Resumen del dia</h2>
          <p>${escapeHtml(data.methodology.principle)}</p>
          <div class="overview-grid">
            <div class="overview-stat">
              <span class="metric-label">Partidos hoy</span>
              <strong>${data.slateSummary.matchesToday ?? data.matches?.length ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Apuestas verdes</span>
              <strong>${data.slateSummary.matchesBettable ?? 0}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Picks listos</span>
              <strong>${data.picks.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Corners</span>
              <strong>${data.cornersPicks.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Tiros</span>
              <strong>${data.shotsPicks.length + data.playerProps.length}</strong>
            </div>
            <div class="overview-stat">
              <span class="metric-label">Mercados con player props</span>
              <strong>${data.slateSummary.playerPropsMatched}</strong>
            </div>
          </div>
        </article>
        <article class="overview-card">
          <span class="mini-label">Stack activo</span>
          <h2 class="section-title">Como sale cada pick</h2>
          <p>${escapeHtml(data.methodology.scoring)}</p>
          <p class="section-note">
            Fecha Madrid: ${escapeHtml(data.date)}. Ultima actualizacion: ${formatDate(data.generatedAt)}.
            Odds stale: ${data.stalenessMinutes.odds} min. Forma: ${data.stalenessMinutes.form} min.
          </p>
          <div class="module-chip-row">${providerSummary}</div>
        </article>
      </section>
      <section class="featured-picks">
        ${featured.map((item, index) => renderFootballRecommendationCard(item, index, !data.picks.length)).join("")}
      </section>
      <section class="insight-grid">
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Mercados</span>
              <h2 class="section-title">Lo mas repetitivo hoy</h2>
            </div>
          </div>
          <div class="factor-list">
            ${[
              data.resultPicks[0],
              data.goalsPicks[0],
              data.cornersPicks[0],
              data.playerProps[0] || data.shotsPicks[0],
            ]
              .filter(Boolean)
              .map(
                (item) => `
                  <div class="recommendation-chip ${verdictCardClass(item)}">
                    <strong>${escapeHtml(item.category)} · ${escapeHtml(item.selection)}</strong>
                    <p>${escapeHtml(item.supportLabel || item.rationale || "")}</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
        <article class="overview-card">
          <div class="section-header">
            <div>
              <span class="mini-label">Riesgo</span>
              <h2 class="section-title">Notas operativas</h2>
            </div>
          </div>
          <div class="factor-list">
            ${data.riskNotes
              .map(
                (note) => `
                  <div class="factor-chip">
                    <strong>Control</strong>
                    <p>${escapeHtml(note)}</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      </section>
    </div>
  `;
}

function renderFootballPicksPanel(data) {
  const validItems = data.picks || [];
  const parlays = data.parlays || [];

  return `
    <div class="tab-panel">
      <section class="legend-bar">
        <span class="verdict-badge bet-valid">Apuesta verde</span>
        <span class="verdict-badge bet-lean">Patron fuerte</span>
        <span class="legend-hint">Singles desde cuota 1.50 y combinadas solo con patrones repetidos.</span>
      </section>
      ${
        validItems.length || parlays.length
          ? `${renderFootballPickSection(
              "Picks listos para jugar",
              "Mercados con cuota util, confianza alta y patron repetido en la muestra del equipo.",
              validItems,
              false
            )}${
              parlays.length
                ? `
        <section class="football-pick-section">
          <div class="section-header">
            <div><h2 class="section-title">Combinadas</h2></div>
            <p class="section-note">Unimos patas de distintos partidos para superar cuota 1.50 sin forzar picks largos.</p>
          </div>
          <div class="picks-grid">
            ${parlays
              .map(
                (parlay, index) => `
                  <article class="pick-card football-pick-card bet-valid">
                    <div class="pick-topline">
                      <span class="pick-rank">Combinada ${index + 1}</span>
                      <span class="pick-market">Cuota ${formatOdds(parlay.totalOdds)}</span>
                      <span class="verdict-badge bet-valid">Patron combinado</span>
                    </div>
                    <div class="parlay-legs">
                      <p><strong>1.</strong> ${escapeHtml(parlay.selections[0].selection)} · ${formatOdds(parlay.selections[0].odds)}</p>
                      <p><strong>2.</strong> ${escapeHtml(parlay.selections[1].selection)} · ${formatOdds(parlay.selections[1].odds)}</p>
                    </div>
                    <div class="pick-metrics football-pick-metrics">
                      <div>
                        <span class="metric-label">Nota</span>
                        <strong class="${confidenceToneClass(parlay.comboScore)}">${parlay.comboScore}</strong>
                      </div>
                      <div>
                        <span class="metric-label">Patron</span>
                        <strong class="${parlay.combinedPattern >= 0.65 ? "metric-good" : "metric-neutral"}">${Math.round(parlay.combinedPattern * 100)}%</strong>
                      </div>
                    </div>
                    <p class="pick-meta-line">${escapeHtml(parlay.rationale)}</p>
                  </article>
                `
              )
              .join("")}
          </div>
        </section>`
                : ""
            }`
          : renderFootballPickSection(
              "Patrones mas fuertes del dia",
              "Hoy no hay verde puro. Estas son las lecturas mas consistentes para vigilar en la jornada.",
              data.trendPicks || [],
              true
            )
      }
    </div>
  `;
}

function renderFootballMatchCard(match) {
  const best = match.bestRecommendation;
  const model = match.matchModel || {};

  return `
    <article class="match-card football-match-card ${best ? verdictCardClass(best) : ""}">
      ${renderEventSchedule(match)}
      <div class="match-header">
        <div>
          <p class="match-category">${escapeHtml(match.league)}</p>
          <h3 class="match-title">${escapeHtml(match.homeTeam.name)} vs ${escapeHtml(match.awayTeam.name)}</h3>
        </div>
        <div class="match-badges">
          <div class="badge">${escapeHtml(match.status)}</div>
          ${best ? `<span class="${verdictBadgeClass(best)}">${escapeHtml(best.selection)}</span>` : ""}
        </div>
      </div>
      <div class="football-model-strip">
        <div>
          <span class="metric-label">Goles esperados</span>
          <strong>${formatMetric(model.expectedGoals, 2)}</strong>
        </div>
        <div>
          <span class="metric-label">Corners proxy</span>
          <strong>${formatMetric(model.expectedCorners, 1)}</strong>
        </div>
        <div>
          <span class="metric-label">Tiros local</span>
          <strong>${formatMetric(model.expectedHomeShots, 1)}</strong>
        </div>
        <div>
          <span class="metric-label">Tiros visitante</span>
          <strong>${formatMetric(model.expectedAwayShots, 1)}</strong>
        </div>
      </div>
      <div class="football-team-grid">
        ${renderFootballTeamTrend(match.homeTeam, "Local")}
        ${renderFootballTeamTrend(match.awayTeam, "Visitante")}
      </div>
      <section class="game-picks-block">
        <div class="section-header compact">
          <h4 class="subsection-title">Mejores lecturas de este partido</h4>
          <p class="section-note">Cada mercado sale de factores explicitos y del mejor precio disponible.</p>
        </div>
        <div class="match-recommendations">
          ${match.recommendations.map((item) => renderFootballRecommendationRow(item)).join("")}
        </div>
      </section>
    </article>
  `;
}

function renderFootballMatchesPanel(data) {
  const matches = dayEventsForSport(data, "futbol");

  return `
    <div class="tab-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Partidos del dia</span>
            <h2 class="section-title">Calendario de futbol (Madrid)</h2>
          </div>
          <p class="section-note">Cada partido ensena su mejor pick, sus tendencias de goles y las variantes de corners o tiros si el mercado existe.</p>
        </div>
        <div class="matches-grid">
          ${
            matches.length
              ? matches
                  .map(
                    (match) => `
                      <div class="football-match-wrap">
                        <div class="chip-row">
                          <span class="chip ${isBettableEvent(match, "futbol", data.date) ? "positive" : ""}">
                            ${isBettableEvent(match, "futbol", data.date) ? "Apuesta verde" : "Patron sin validar"}
                          </span>
                        </div>
                        ${renderFootballMatchCard(match)}
                      </div>
                    `
                  )
                  .join("")
              : `<p class="section-note">No hay partidos de futbol cargados para la fecha Madrid ${escapeHtml(data.date)}.</p>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderFootballMatchCardV2(match) {
  const best = match.bestRecommendation;
  const showStats = Boolean(state.footballShowStatsByMatch[match.id]);

  return `
    <article class="match-card football-match-card ${best ? footballMarketStateConfig(best).className : ""}">
      <div class="football-duel-topbar">
        <span class="football-duel-league">${escapeHtml(match.league.toUpperCase())}</span>
        <span class="football-duel-meta">${escapeHtml(footballMatchMeta(match))}</span>
      </div>
      <div class="football-duel-grid">
        ${renderFootballTeamPanel(match.homeTeam, "Local", "home")}
        ${renderFootballModelPanel(match)}
        ${renderFootballTeamPanel(match.awayTeam, "Visitante", "away")}
      </div>
      <div class="football-duel-actions">
        <button type="button" class="football-stats-toggle" data-action="toggle-football-stats" data-match-id="${escapeHtml(match.id)}">
          ${showStats ? "HIDE" : "VIEW"} STATS
        </button>
        <p class="football-duel-summary">
          ${best ? `Pick principal: ${escapeHtml(best.selection)} | ${escapeHtml(best.verdictLabel || "")}` : "Sin pick principal validado todavia."}
        </p>
      </div>
      ${showStats ? renderFootballDetailedStats(match) : ""}
      <div class="football-market-stack in-match">
        ${match.recommendations
          .map((item) =>
            renderFootballMarketCard(item, {
              featured: item.id === best?.id,
              defaultOpen: item.id === best?.id,
              match,
              showMatchLabel: false,
            })
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderFootballOverviewPanelV2(data) {
  const sessionPick = data.bestPick || data.picks[0] || data.trendPicks[0] || null;
  const featuredMatch = findFootballMatchForPick(data, sessionPick) || data.matches?.[0] || null;
  const providerSummary = data.providers
    .map((provider) => `<span class="chip">${escapeHtml(provider.name)} | ${escapeHtml(provider.status)}</span>`)
    .join("");
  const board = (data.picks.length ? data.picks : data.trendPicks)
    .filter((item) => item.id !== sessionPick?.id)
    .slice(0, 4);

  return `
    <div class="tab-panel football-session-panel">
      <section class="football-session-header">
        <div class="football-session-ribbon">
          <span>ACTIVE MODULE</span>
          <span>FOOTBALL DESK</span>
          <span>${escapeHtml(state.requestedDate || data.date)} | FACTORS ON</span>
        </div>
        <div class="football-session-grid">
          <article class="overview-card football-overview-card">
            <span class="mini-label">Session snapshot</span>
            <h2 class="section-title">Jornada profesional</h2>
            <p>${escapeHtml(data.methodology.principle)}</p>
            <div class="overview-grid">
              <div class="overview-stat">
                <span class="metric-label">Partidos</span>
                <strong>${data.slateSummary.matchesToday ?? data.matches?.length ?? 0}</strong>
              </div>
              <div class="overview-stat">
                <span class="metric-label">Picks listos</span>
                <strong>${data.picks.length}</strong>
              </div>
              <div class="overview-stat">
                <span class="metric-label">Mercados core</span>
                <strong>${data.resultPicks.length + data.goalsPicks.length}</strong>
              </div>
              <div class="overview-stat">
                <span class="metric-label">Props</span>
                <strong>${data.shotsPicks.length + data.playerProps.length}</strong>
              </div>
            </div>
          </article>
          <article class="overview-card football-overview-card">
            <span class="mini-label">Modelo y data</span>
            <h2 class="section-title">Como prioriza el board</h2>
            <p>${escapeHtml(data.methodology.scoring)}</p>
            <p class="section-note">
              Fecha Madrid: ${escapeHtml(data.date)}. Actualizado: ${formatDate(data.generatedAt)}. Odds stale ${data.stalenessMinutes.odds} min.
            </p>
            <div class="module-chip-row">${providerSummary}</div>
          </article>
        </div>
      </section>
      ${
        sessionPick
          ? `
        <section class="football-pick-section">
          <div class="section-header">
            <div>
              <span class="mini-label">Best pick</span>
              <h2 class="section-title">La mejor lectura de la jornada</h2>
            </div>
            <p class="section-note">Mas peso a mercados base, profundidad de precio y evidencia visible del partido antes de elevar una apuesta.</p>
          </div>
          <div class="football-market-stack">
            ${renderFootballMarketCard(sessionPick, {
              featured: true,
              defaultOpen: true,
              match: featuredMatch,
            })}
          </div>
        </section>
      `
          : ""
      }
      ${
        featuredMatch
          ? `
        <section class="football-pick-section">
          <div class="section-header">
            <div>
              <span class="mini-label">Partido destacado</span>
              <h2 class="section-title">${escapeHtml(featuredMatch.homeTeam.name)} vs ${escapeHtml(featuredMatch.awayTeam.name)}</h2>
            </div>
            <p class="section-note">Tarjeta central 1 vs 1 con el mejor mercado del cruce, apoyada en forma, goles, tiros y precio disponible.</p>
          </div>
          ${renderFootballMatchCardV2(featuredMatch)}
        </section>
      `
          : ""
      }
      ${board.length ? renderFootballPickSection("Resto del board", "Mercados utiles de la jornada ordenados con un filtro mas conservador.", board, false, data) : ""}
    </div>
  `;
}

function renderFootballPicksPanelV2(data) {
  const validItems = data.picks || [];
  const watchlist = data.trendPicks || [];

  return `
    <div class="tab-panel football-session-panel">
      <section class="legend-bar football-legend-bar">
        <span class="chip">Core markets first</span>
        <span class="chip">Precio profundo > precio aislado</span>
        <span class="chip">Props con stake mas bajo</span>
      </section>
      ${
        validItems.length
          ? renderFootballPickSection(
              "Picks listos para jugar",
              "Solo llegan arriba los mercados con mejor mezcla de patron, cuota y calidad de evidencia.",
              validItems,
              false,
              data
            )
          : renderFootballPickSection(
              "Board de vigilancia",
              "Hoy no hay verde puro. Estas son las alternativas mejor soportadas por los datos de la sesion.",
              watchlist,
              true,
              data
            )
      }
      ${renderFootballParlaysPanel(data.parlays || [])}
    </div>
  `;
}

function renderFootballMatchesPanelV2(data) {
  const matches = dayEventsForSport(data, "futbol");

  return `
    <div class="tab-panel football-session-panel">
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Partidos del dia</span>
            <h2 class="section-title">Calendario de futbol (Madrid)</h2>
          </div>
          <p class="section-note">Cada tarjeta cruza forma, goles, BTTS, tiros y mercado para decidir un pick principal antes de abrir mercados secundarios.</p>
        </div>
        <div class="matches-grid football-matches-grid">
          ${
            matches.length
              ? matches
                  .map(
                    (match) => `
                      <div class="football-match-wrap">
                        <div class="chip-row">
                          <span class="chip ${isBettableEvent(match, "futbol", data.date) ? "positive" : ""}">
                            ${isBettableEvent(match, "futbol", data.date) ? "Pick jugable" : "Solo lectura"}
                          </span>
                        </div>
                        ${renderFootballMatchCardV2(match)}
                      </div>
                    `
                  )
                  .join("")
              : `<p class="section-note">No hay partidos de futbol cargados para la fecha Madrid ${escapeHtml(data.date)}.</p>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderFootballStackPanel(data) {
  return `
    <div class="tab-panel">
      <section class="top-row">
        <article class="overview-card">
          <span class="mini-label">Coverage</span>
          <h2 class="section-title">Cobertura del modulo</h2>
          <div class="factor-list">
            ${Object.entries(data.coverage)
              .map(
                ([key, value]) => `
                  <div class="factor-chip">
                    <strong>${escapeHtml(key)} <span class="score-positive">${formatCoverage(value)}</span></strong>
                    <p>Porcentaje de la jornada con esta capa de informacion disponible.</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
        <article class="overview-card">
          <span class="mini-label">Methodology</span>
          <h2 class="section-title">Que entra en el score</h2>
          <p>${escapeHtml(data.methodology.scoring)}</p>
          <p class="section-note">El modulo cruza forma real, produccion ofensiva, ritmo de gol, volumen de tiros y el precio de la mejor casa antes de validar una apuesta.</p>
        </article>
      </section>
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Providers</span>
            <h2 class="section-title">Stack de futbol</h2>
          </div>
        </div>
        <div class="provider-grid">
          ${data.providers
            .map(
              (provider) => `
                <article class="${providerClass(provider)}">
                  <span class="provider-status">${escapeHtml(provider.status)}</span>
                  <h3>${escapeHtml(provider.name)}</h3>
                  <p>${escapeHtml(provider.purpose)}</p>
                  ${
                    provider.docs && String(provider.docs).startsWith("http")
                      ? `<p><strong>Docs:</strong> <a href="${escapeHtml(provider.docs)}" target="_blank" rel="noreferrer">${escapeHtml(provider.docs)}</a></p>`
                      : ""
                  }
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderPlaceholderModule(module) {
  const isMlb = module.key === "mlb";
  const title = isMlb ? "MLB blueprint" : "Football blueprint";
  const providerLine = isMlb
    ? "MLB necesitara pitchers probables, lineups confirmados, weather y bullpen freshness."
    : "Futbol necesitara lineups, injuries, travel, xG, rest days y contexto competitivo.";
  const stackItems = isMlb
    ? ["schedule + player news", "weather + park factors", "odds + line movement", "lineup confirmation"]
    : ["fixtures + standings", "lineups + injuries", "odds + market steam", "xG or shot quality layer"];
  const moduleItems = isMlb
    ? ["pitcher form", "bullpen tax", "travel spots", "ballpark profile"]
    : ["lineups", "injury risk", "travel fatigue", "competition context"];

  return `
    <div class="tab-panel">
      <section class="placeholder-grid">
        <article class="placeholder-card feature">
          <span class="mini-label">Next module</span>
          <h2 class="placeholder-title">${title}</h2>
          <p class="placeholder-copy">${providerLine}</p>
          <div class="chip-row">
            ${moduleItems.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
          </div>
        </article>
        <article class="placeholder-card">
          <span class="mini-label">Modular shell</span>
          <h3>El contenedor visual ya esta listo</h3>
          <p class="placeholder-copy">Solo hace falta enchufar providers, normalizadores y scoring propios del deporte. La navegacion, jerarquia y UX ya estan separadas por tabs.</p>
        </article>
      </section>
      <section>
        <div class="section-header">
          <div>
            <span class="mini-label">Data stack</span>
            <h2 class="section-title">${module.label} listo para integrarse</h2>
          </div>
        </div>
        <div class="signal-grid">
          ${stackItems
            .map(
              (item) => `
                <article class="signal-card">
                  <span class="mini-label">${module.label}</span>
                  <h3>${escapeHtml(item)}</h3>
                  <p>Esta shell deja el hueco visual y de navegacion preparado para esta capa de datos.</p>
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderModuleContent(module) {
  const analysis = state.analysisBySport[module.key];
  const error = state.errorBySport[module.key];
  const loading = state.loadingBySport[module.key];

  if (error) {
    return renderErrorCard(`No pude cargar el modulo ${module.label}: ${error.message}`);
  }

  if (!analysis) {
    return renderLoadingCard(`Cargando analisis del modulo ${module.label}...`);
  }

  if (isDataUnavailable(analysis)) {
    return renderUnavailableCard(module, analysis);
  }

  if (module.key === "mlb") {
    const activeTab = state.activeTabBySport.mlb;
    if (activeTab === "board") return renderMlbBoardPanel(analysis);
    if (activeTab === "picks") return renderMlbPicksPanel(analysis);
    if (activeTab === "games") return renderMlbGamesPanel(analysis);
    return renderMlbStackPanel(analysis);
  }

  if (module.key === "futbol") {
    const activeTab = state.activeTabBySport.futbol;
    if (activeTab === "overview") return renderFootballOverviewPanelV2(analysis);
    if (activeTab === "picks") return renderFootballPicksPanelV2(analysis);
    if (activeTab === "matches") return renderFootballMatchesPanelV2(analysis);
    return renderFootballStackPanel(analysis);
  }

  const activeTab = state.activeTabBySport.tennis;
  if (activeTab === "overview") return renderOverviewPanel(analysis);
  if (activeTab === "picks") return renderPicksPanel(analysis);
  if (activeTab === "matches") return renderMatchesPanel(analysis);
  if (activeTab === "providers") return renderProvidersPanel(analysis);
  return renderSignalsPanel();
}

function renderActiveModule(module) {
  const analysis = state.analysisBySport[module.key];
  const meta = getAnalysisMeta(analysis);
  const loading = state.loadingBySport[module.key];

  return `
    <section class="module-panel">
      <div class="module-head">
        <div>
          <span class="mini-label">${module.status === "live" ? "active module" : "expansion module"}</span>
          <h2 class="module-title">${module.title}</h2>
          <p class="module-copy">${moduleHeadline(module)}</p>
        </div>
        <article class="overview-card">
          <span class="mini-label">Session snapshot</span>
          <h3>${escapeHtml(module.label)} desk</h3>
          <p class="section-note">
            Fecha (Madrid): ${escapeHtml(analysis?.date || "Sin fecha")}.
            ${
              module.status === "live" && analysis
                ? `Eventos: ${meta.events}. Picks: ${meta.picks}.`
                : loading
                  ? "Cargando providers y scoring del modulo."
                  : "Esperando providers y scoring especifico del deporte."
            }
          </p>
          <div class="module-chip-row">
            <span class="chip">${module.status === "live" ? "routing live" : "routing staged"}</span>
            <span class="chip">${analysis ? "factors on" : "factors pending"}</span>
            <span class="chip">${loading ? "syncing data" : "docker running"}</span>
          </div>
        </article>
      </div>
      ${renderSubtabs(module)}
      ${renderModuleContent(module)}
    </section>
  `;
}

function renderSurface() {
  const module = MODULES[state.activeSport];
  return `
    <div class="surface">
      ${renderBrandBar(getActiveAnalysis())}
      ${renderHero(getActiveAnalysis())}
      ${renderSportTabs()}
      ${renderActiveModule(module)}
    </div>
  `;
}

function renderApp() {
  const root = document.getElementById("app-shell");
  root.innerHTML = renderSurface();
}

function endpointForSport(sport) {
  const basePath =
    sport === "mlb"
      ? "/api/mlb/analyze"
      : sport === "futbol"
        ? "/api/futbol/analyze"
        : "/api/analyze";

  if (!state.requestedDate) {
    return basePath;
  }

  return `${basePath}?date=${encodeURIComponent(state.requestedDate)}`;
}

async function loadAnalysisForSport(sport) {
  if (!MODULES[sport] || MODULES[sport].status !== "live") return;
  if (state.loadingBySport[sport]) return;
  if (state.analysisBySport[sport]) return;

  state.loadingBySport[sport] = true;
  state.errorBySport[sport] = null;
  renderApp();

  try {
    const response = await fetch(endpointForSport(sport));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    state.analysisBySport[sport] = await response.json();
    state.errorBySport[sport] = null;
  } catch (error) {
    state.errorBySport[sport] = error;
  } finally {
    state.loadingBySport[sport] = false;
    renderApp();
  }
}

document.addEventListener("click", (event) => {
  const tennisMarketTarget = event.target.closest("[data-action='toggle-tennis-market']");
  if (tennisMarketTarget) {
    const marketId = tennisMarketTarget.dataset.marketId;
    const matchId = tennisMarketTarget.dataset.matchId;
    if (state.tennisExpandedMatchId === matchId && state.tennisExpandedMarketId === marketId) {
      state.tennisExpandedMatchId = null;
      state.tennisExpandedMarketId = null;
    } else {
      state.tennisExpandedMatchId = matchId;
      state.tennisExpandedMarketId = marketId;
    }
    renderApp();
    return;
  }

  const tennisLesionTarget = event.target.closest("[data-action='toggle-tennis-lesion']");
  if (tennisLesionTarget) {
    const matchId = tennisLesionTarget.dataset.matchId;
    const side = tennisLesionTarget.dataset.side;
    const key = `${matchId}::${side}`;
    state.tennisLesionOpen[key] = !state.tennisLesionOpen[key];
    renderApp();
    return;
  }

  const footballStatsButton = event.target.closest("[data-action='toggle-football-stats']");
  if (footballStatsButton) {
    const matchId = footballStatsButton.dataset.matchId;
    state.footballShowStatsByMatch[matchId] = !state.footballShowStatsByMatch[matchId];
    renderApp();
    return;
  }

  const footballMarketButton = event.target.closest("[data-action='toggle-football-market']");
  if (footballMarketButton) {
    const marketId = footballMarketButton.dataset.marketId;
    state.footballExpandedMarketId = state.footballExpandedMarketId === marketId ? null : marketId;
    renderApp();
    return;
  }

  const sportButton = event.target.closest("[data-action='select-sport']");
  if (sportButton) {
    const sport = sportButton.dataset.sport;
    state.activeSport = sport;
    renderApp();
    loadAnalysisForSport(sport);
    return;
  }

  const tabButton = event.target.closest("[data-action='select-tab']");
  if (tabButton) {
    const sport = tabButton.dataset.sport;
    const tab = tabButton.dataset.tab;
    state.activeTabBySport[sport] = tab;
    renderApp();
  }
});

renderApp();
loadAnalysisForSport(state.activeSport);
