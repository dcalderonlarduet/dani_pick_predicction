function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatOdds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 1 ? number.toFixed(2) : "N/D";
}

function pickLabel(pick = {}) {
  return pick.selection || pick.seleccion || pick.pick || pick.marketLabel || pick.market || "Sin pick";
}

export function renderTennisMatchCard(match = {}, options = {}) {
  const home = match.home || match.player1 || match.homeTeam?.name || match.participants?.[0]?.name || "Jugador 1";
  const away = match.away || match.player2 || match.awayTeam?.name || match.participants?.[1]?.name || "Jugador 2";
  const tournament = match.tournament || match.league?.name || match.competition || "Tennis";
  const surface = match.surfaceLabel || match.surface || "Pista N/D";
  const status = options.isBettable ? "Disponible" : (match.status || "Programado");
  const picks = [
    ...(Array.isArray(match.picks) ? match.picks : []),
    ...(Array.isArray(match.recommendations) ? match.recommendations : []),
  ].slice(0, 3);

  return `
    <article class="match-row is-tennis-card ${escapeHtml(options.surfaceClass || "")}">
      <div class="match-row-header">
        <div class="match-row-main">
          <span class="match-row-title-tennis">${escapeHtml(home)} vs ${escapeHtml(away)}</span>
          <span class="match-row-topline-tennis">${escapeHtml(tournament)} · ${escapeHtml(surface)} · ${escapeHtml(status)}</span>
        </div>
      </div>
      ${
        picks.length
          ? `<div class="match-key-picks-tennis">
              ${picks.map((pick) => `
                <div class="recommendation-chip">
                  <strong>${escapeHtml(pickLabel(pick))}</strong>
                  <span>Cuota ${escapeHtml(formatOdds(pick.odds || pick.mejor_cuota || pick.bestOdds))}</span>
                </div>
              `).join("")}
            </div>`
          : `<div class="section-note">Sin pick recomendado para este partido.</div>`
      }
    </article>
  `;
}
