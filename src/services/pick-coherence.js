/**
 * pick-coherence.js
 *
 * Detecta y resuelve contradicciones lógicas entre picks del mismo partido.
 *
 * Problema conocido:
 *   - El modelo genera picks de mercados distintos (game_total, team_total_home,
 *     team_total_away) de forma independiente, sin comprobar si son coherentes
 *     entre sí.
 *   - Ejemplo de contradicción:
 *       Pick A: Over 166.5 total partido (MIN@PHX)
 *       Pick B: Under 84.5 MIN visitante
 *     → Si MIN anota <84.5, PHX necesita >82 para que el Over 166.5 sea válido.
 *       Los dos picks se contradicen en su supuesto de base.
 *
 * Reglas de coherencia implementadas:
 *   1. game_total Over  ↔ team_total Under:
 *      Si Over del partido implica que el otro equipo necesita anotar
 *      mucho más de lo que su propia proyección sugiere → contradicción.
 *   2. game_total Under ↔ team_total Over:
 *      Simétrico al caso anterior.
 *   3. team_total_home Over ↔ team_total_away Under (y viceversa):
 *      Se comprueba que la suma de ambas proyecciones sea coherente con
 *      el resultado del game_total implícito.
 *   4. Moneyline + total: no se contradicen (mercados independientes).
 */

/**
 * Dado un conjunto de picks para un partido, devuelve solo los coherentes.
 * Cuando hay contradicción se queda con el pick de mayor score/confianza
 * y descarta el contradictorio.
 *
 * @param {Array}  picks    - Picks evaluados para el partido (bettable o no)
 * @param {object} ctx      - Contexto del partido (proyecciones del modelo)
 * @returns {{ coherent: Array, removed: Array }}
 */
export function resolvePickCoherence(picks, ctx = {}) {
  if (!Array.isArray(picks) || picks.length < 2) {
    return { coherent: picks ?? [], removed: [] };
  }

  // Indexar por mercado para acceso rápido
  const byMarket = {};
  for (const pick of picks) {
    const key = pick?.market;
    if (!key) continue;
    if (!byMarket[key]) byMarket[key] = [];
    byMarket[key].push(pick);
  }

  const toRemove = new Set();

  // ── Regla 1 & 2: game_total vs team_total_home / team_total_away ──────────
  for (const teamMarket of ["team_total_home", "team_total_away"]) {
    const teamPicks = byMarket[teamMarket];
    const gamePicks = byMarket["game_total"];
    if (!teamPicks?.length || !gamePicks?.length) continue;

    for (const teamPick of teamPicks) {
      for (const gamePick of gamePicks) {
        const contradiction = isGameTotalTeamTotalContradiction(gamePick, teamPick, ctx);
        if (!contradiction) continue;

        const loser = pickWithLowerScore(gamePick, teamPick);
        toRemove.add(loser);
        console.warn(
          `[pick-coherence] Contradicción detectada: ${gamePick.market}(${gamePick.side}) ↔ ${teamPick.market}(${teamPick.side}). ` +
          `Se descarta el de menor score: ${loser.market}(${loser.side}).`
        );
      }
    }
  }

  // ── Regla 3: team_total_home vs team_total_away ───────────────────────────
  const homePicks = byMarket["team_total_home"];
  const awayPicks = byMarket["team_total_away"];
  if (homePicks?.length && awayPicks?.length) {
    for (const homePick of homePicks) {
      for (const awayPick of awayPicks) {
        const contradiction = isTeamTotalsMutualContradiction(homePick, awayPick, ctx);
        if (!contradiction) continue;
        const loser = pickWithLowerScore(homePick, awayPick);
        toRemove.add(loser);
        console.warn(
          `[pick-coherence] Contradicción team totals: home(${homePick.side}) ↔ away(${awayPick.side}). ` +
          `Se descarta: ${loser.market}(${loser.side}).`
        );
      }
    }
  }

  const coherent = picks.filter((p) => !toRemove.has(p));
  const removed = picks.filter((p) => toRemove.has(p));

  return { coherent, removed };
}

// ─── Lógica de contradicción ──────────────────────────────────────────────────

/**
 * Detecta si un pick de game_total y un pick de team_total se contradicen.
 *
 * La contradicción existe cuando, para que el game_total gane, el equipo
 * complementario tendría que anotar más de lo que su proyección permite
 * con probabilidad razonable.
 *
 * Ejemplo:
 *   game_total Over 166.5 → necesita que home + away > 166.5
 *   team_total_away Under 84.5 MIN → MIN (away) anota < 84.5
 *   → PHX (home) necesita > 82 puntos para que el Over gane.
 *   → Si la proyección de PHX es ~83, la línea está en el límite:
 *     baja confianza y las dos apuestas apuntan en dirección opuesta
 *     sobre el mismo resultado.
 *
 * Tolerancia: si la suma de las dos proyecciones difiere de la línea
 * game_total en más de THRESHOLD_PTS, marcamos contradicción.
 */
const CONTRADICTION_THRESHOLD_PTS = 6; // pts de margen antes de declarar contradicción
const CONTRADICTION_PROB_THRESHOLD = 0.35; // si la prob del complementario es < 35%, hay contradicción

function isGameTotalTeamTotalContradiction(gamePick, teamPick, ctx) {
  if (!gamePick?.line || !teamPick?.line) return false;

  const gameLine = Number(gamePick.line);
  const teamLine = Number(teamPick.line);
  if (!Number.isFinite(gameLine) || !Number.isFinite(teamLine)) return false;

  // El mercado del teamPick determina cuál es el equipo complementario
  const isTeamHome = teamPick.market === "team_total_home";
  const rivalProjection = isTeamHome
    ? ctx?.away?.projectedPts ?? ctx?.awayProjectedPts
    : ctx?.home?.projectedPts ?? ctx?.homeProjectedPts;

  if (!Number.isFinite(rivalProjection)) {
    // Sin proyección del rival, usamos solo la aritmética de líneas
    return checkLineArithmeticContradiction(gamePick, teamPick, gameLine, teamLine);
  }

  // Si game Over Y team Under → ¿puede el rival compensar?
  if (gamePick.side === "over" && teamPick.side === "under") {
    const minRivalNeeded = gameLine - teamLine;           // rival necesita al menos esto
    const surplus = minRivalNeeded - rivalProjection;     // cuánto le falta al rival
    if (surplus > CONTRADICTION_THRESHOLD_PTS) {
      return true;
    }
  }

  // Si game Under Y team Over → ¿puede el total mantenerse bajo?
  if (gamePick.side === "under" && teamPick.side === "over") {
    const maxRivalAllowed = gameLine - teamLine;          // rival puede anotar hasta esto
    const deficit = rivalProjection - maxRivalAllowed;    // cuánto se pasa el rival
    if (deficit > CONTRADICTION_THRESHOLD_PTS) {
      return true;
    }
  }

  return false;
}

/**
 * Fallback cuando no hay proyección del rival: comprueba si las líneas
 * son aritméticamente incompatibles.
 */
function checkLineArithmeticContradiction(gamePick, teamPick, gameLine, teamLine) {
  // over game + under team → el rival necesita más de (gameLine - teamLine)
  // Si (gameLine - teamLine) > gameLine * 0.55 → el rival necesita más del 55%
  // del total → inverosímil y contradictorio
  if (gamePick.side === "over" && teamPick.side === "under") {
    const rivalNeeded = gameLine - teamLine;
    if (rivalNeeded / gameLine > 0.54) return true;  // rival necesita >54% del total
  }
  if (gamePick.side === "under" && teamPick.side === "over") {
    const rivalAllowed = gameLine - teamLine;
    if (rivalAllowed / gameLine < 0.40) return true; // rival puede anotar solo <40%
  }
  return false;
}

/**
 * Detecta si dos picks de team_total (home vs away) apuntan en dirección
 * opuesta de forma que implican un total de partido incoherente.
 *
 * home Over X + away Under Y  con X+Y muy cercano/mayor que la línea de
 * game_total conocida → el over home sólo gana si el total sube, pero el
 * under away lo frena.
 */
function isTeamTotalsMutualContradiction(homePick, awayPick, ctx) {
  const homeLine = Number(homePick.line);
  const awayLine = Number(awayPick.line);
  if (!Number.isFinite(homeLine) || !Number.isFinite(awayLine)) return false;

  // over home + under away → suma implicada: entre awayLine y homeLine+awayLine
  // Si las dos proyecciones apuntan en sentido opuesto Y sus líneas son cercanas
  // a las proyecciones, hay contradicción.
  if (homePick.side === "over" && awayPick.side === "under") {
    const homeProj = ctx?.home?.projectedPts ?? ctx?.homeProjectedPts;
    const awayProj = ctx?.away?.projectedPts ?? ctx?.awayProjectedPts;
    if (Number.isFinite(homeProj) && Number.isFinite(awayProj)) {
      // El under away solo gana si away < awayLine → total = home + away < homeProj_high + awayLine
      // El over home solo gana si home > homeLine → total = homeLine + away > homeLine + awayProj_low
      // Contradicción si los dos supuestos no pueden ser simultáneamente ciertos
      const maxTotalForUnderAway = homeProj + CONTRADICTION_THRESHOLD_PTS + awayLine;
      const minTotalForOverHome = homeLine + awayProj - CONTRADICTION_THRESHOLD_PTS;
      if (minTotalForOverHome > maxTotalForUnderAway) return true;
    }
  }

  // under home + over away → simétrico
  if (homePick.side === "under" && awayPick.side === "over") {
    const homeProj = ctx?.home?.projectedPts ?? ctx?.homeProjectedPts;
    const awayProj = ctx?.away?.projectedPts ?? ctx?.awayProjectedPts;
    if (Number.isFinite(homeProj) && Number.isFinite(awayProj)) {
      const maxTotalForUnderHome = homeLine + awayProj + CONTRADICTION_THRESHOLD_PTS;
      const minTotalForOverAway = homeProj - CONTRADICTION_THRESHOLD_PTS + awayLine;
      if (minTotalForOverAway > maxTotalForUnderHome) return true;
    }
  }

  return false;
}

/** Devuelve el pick con menor score (el que se descarta). */
function pickWithLowerScore(pickA, pickB) {
  const scoreA = pickA?.score_final ?? pickA?.score ?? 0;
  const scoreB = pickB?.score_final ?? pickB?.score ?? 0;
  return scoreA >= scoreB ? pickB : pickA;
}

/**
 * Enriquece el contexto del partido con las proyecciones de puntos
 * para que resolvePickCoherence pueda usarlas.
 * Se llama desde wnba-odds-policy.js y nba-odds-policy.js al construir cada pick.
 */
export function buildCoherenceCtx(ctx, homeProjectedPts, awayProjectedPts) {
  return {
    ...ctx,
    homeProjectedPts: Number.isFinite(homeProjectedPts) ? homeProjectedPts : null,
    awayProjectedPts: Number.isFinite(awayProjectedPts) ? awayProjectedPts : null,
    home: {
      ...ctx?.home,
      projectedPts: Number.isFinite(homeProjectedPts) ? homeProjectedPts : ctx?.home?.projectedPts,
    },
    away: {
      ...ctx?.away,
      projectedPts: Number.isFinite(awayProjectedPts) ? awayProjectedPts : ctx?.away?.projectedPts,
    },
  };
}