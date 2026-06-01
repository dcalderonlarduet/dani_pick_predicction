/**
 * Precios oficiales La Quiniela (Loterías y Apuestas del Estado).
 * @see https://juegos.loteriasyapuestas.es/jugar/la-quiniela/apuesta/
 *
 * - Cada apuesta (combinación) = 0,75 € (14 partidos + pleno al 15 en el boleto estándar).
 * - Mínimo por boleto: 2 apuestas → 1,50 € (2 columnas sencillas o 1 doble = 2 combinaciones).
 * - Apuesta múltiple en un bloque: combinaciones = 2^dobles × 3^triples (pleno al 15 aparte si marcas cuádruples).
 */

export const QUINIELA_PRICE_PER_BET_EUR = 0.75;
export const QUINIELA_MIN_BETS = 2;
export const QUINIELA_MIN_COST_EUR = QUINIELA_MIN_BETS * QUINIELA_PRICE_PER_BET_EUR;
export const QUINIELA_OFFICIAL_PLAY_URL =
  "https://juegos.loteriasyapuestas.es/jugar/la-quiniela/apuesta/?access=subhome&lang=es";

export function countQuinielaCombinations({ doubles = 0, triples = 0 } = {}) {
  const d = Math.max(0, Math.min(14, Number(doubles) || 0));
  const t = Math.max(0, Math.min(14, Number(triples) || 0));
  return Math.pow(2, d) * Math.pow(3, t);
}

/**
 * Coste apuesta múltiple (un bloque / una columna con dobles y triples).
 */
export function calculateQuinielaDirectCost({
  doubles = 0,
  triples = 0,
  columns = 1,
  elige8 = false,
} = {}) {
  const combosPerColumn = countQuinielaCombinations({ doubles, triples });
  const effectiveColumns = Math.max(1, Number(columns) || 1);
  const rawCombinations = combosPerColumn * effectiveColumns;
  const billedCombinations = Math.max(rawCombinations, QUINIELA_MIN_BETS);
  const elige8Cost = elige8 ? 0.5 * effectiveColumns : 0;
  const baseCost = billedCombinations * QUINIELA_PRICE_PER_BET_EUR;
  const costEur = Math.round((baseCost + elige8Cost) * 100) / 100;

  return {
    doubles: Number(doubles) || 0,
    triples: Number(triples) || 0,
    columns: effectiveColumns,
    combinationsPerColumn: combosPerColumn,
    rawCombinations,
    billedCombinations,
    costPerBetEur: QUINIELA_PRICE_PER_BET_EUR,
    minimumCostEur: QUINIELA_MIN_COST_EUR,
    elige8,
    elige8CostEur: elige8Cost,
    costEur,
    isAtMinimum: billedCombinations === QUINIELA_MIN_BETS && rawCombinations < QUINIELA_MIN_BETS,
    formula:
      rawCombinations < QUINIELA_MIN_BETS
        ? `mínimo ${QUINIELA_MIN_BETS} apuestas × ${QUINIELA_PRICE_PER_BET_EUR}€`
        : `${rawCombinations} comb. × ${QUINIELA_PRICE_PER_BET_EUR}€`,
  };
}

export function countTypesFromProposalRows(rows = []) {
  let doubles = 0;
  let triples = 0;
  let fijos = 0;
  for (const row of rows) {
    const tipo = String(row?.tipo || "").toLowerCase();
    if (tipo === "doble") doubles += 1;
    else if (tipo === "triple") triples += 1;
    else fijos += 1;
  }
  return { fijos, doubles, triples, total: rows.length };
}

export function buildMinimalProposalRows(rows = []) {
  return rows.map((row) => {
    const tipo = String(row?.tipo || "").toLowerCase();
    if (tipo !== "doble" && tipo !== "triple") {
      return { ...row, tipo: "fijo" };
    }

    const favorito =
      row?.favoritoSign ||
      String(row?.opcionFijo || row?.pick || "1")
        .charAt(0)
        .toUpperCase();
    const pick = favorito === "2" ? "2" : favorito === "X" ? "X" : "1";

    return {
      ...row,
      tipo: "fijo",
      pick,
      categoriaBoleto: "fijo_natural",
      fijoForzadoPorCupo: false,
      explicacion: `${row.explicacion || ""} Versión económica: fijo ${pick} (sin doble).`.trim(),
    };
  });
}

export function buildQuinielaPricingFromRows(
  rows = [],
  { columns = 1, elige8 = false, minimalRows: minimalRowsOverride = null } = {}
) {
  const counts = countTypesFromProposalRows(rows);
  const direct = calculateQuinielaDirectCost({
    doubles: counts.doubles,
    triples: counts.triples,
    columns,
    elige8,
  });

  const minimalRows = Array.isArray(minimalRowsOverride) && minimalRowsOverride.length
    ? minimalRowsOverride
    : buildMinimalProposalRows(rows);
  const minimalCounts = countTypesFromProposalRows(minimalRows);
  const minimal = calculateQuinielaDirectCost({
    doubles: minimalCounts.doubles,
    triples: minimalCounts.triples,
    columns,
    elige8,
  });

  const savingsEur = Math.max(0, Math.round((direct.costEur - minimal.costEur) * 100) / 100);

  return {
    officialPlayUrl: QUINIELA_OFFICIAL_PLAY_URL,
    pricePerBetEur: QUINIELA_PRICE_PER_BET_EUR,
    minimumCostEur: QUINIELA_MIN_COST_EUR,
    counts,
    direct,
    minimal: {
      ...minimal,
      counts: minimalCounts,
      rows: minimalRows,
    },
    savingsEur,
    note:
      "En la web oficial el boleto exige al menos 1,50€ (2 apuestas de 0,75€). Un doble multiplica ×2 las combinaciones; 4 dobles = 16 comb. = 12,00€.",
  };
}
