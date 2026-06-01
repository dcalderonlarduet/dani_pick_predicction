// ─────────────────────────────────────────────────────────────────────────────
// MLB Park Factors — promedio 2022-2024
// Fuente: FanGraphs Multi-Year Park Factors + Baseball Reference Park Factors
// ─────────────────────────────────────────────────────────────────────────────
//
// POR QUÉ SOLO HASTA 2024:
//   El knowledge cutoff del modelo de IA que generó estos datos es agosto 2025.
//   La temporada 2025 terminó en octubre 2025 (fuera del cutoff) y la 2026
//   está en curso — no existen datos confiables de esas temporadas en este archivo.
//
// CAMBIOS CONOCIDOS DE 2025 (antes del cutoff):
//   • Oakland A's → jugaron en Sutter Health Park (Sacramento, Triple-A).
//     Factores desconocidos para ese parque. Marcado como neutro provisional.
//   • El resto de los 29 parques no tuvieron renovaciones físicas significativas.
//
// CÓMO ACTUALIZAR CADA TEMPORADA:
//   1. Ir a https://www.fangraphs.com/guts.aspx?type=pf&teamid=0&season=YYYY
//   2. Copiar los valores de "R" (Runs) → runFactor y "HR" → hrFactor
//      divididos por 100 (FanGraphs usa base 100, aquí base 1.0)
//   3. Promediar con los 2 años anteriores para suavizar varianza de muestra.
//   4. Actualizar el campo `dataSeasons` de cada entrada.
//
// runFactor > 1.0  → favorece bateo  (más carreras esperadas)
// runFactor < 1.0  → favorece pitcheo (menos carreras esperadas)
// ─────────────────────────────────────────────────────────────────────────────
export const MLB_BALLPARKS = {

  // ── FAVORECEN MUCHO EL BATEO (runFactor > 1.10) ─────────────────────────────

  "coors field": {
    teamId: 115, team: "Colorado Rockies",
    city: "Denver, CO", dataSeasons: "2022-2024",
    category: "Favorece bateo (extremo)",
    runFactor: 1.21, hrFactor: 1.30,
    elevation: 5183, surface: "grass",
    note: "El parque más extremo de la MLB. Altitud de 1580 m reduce resistencia del aire. Promedio 2022-2024: ~121. Siempre considerar over en totales.",
  },
  "great american ball park": {
    teamId: 113, team: "Cincinnati Reds",
    city: "Cincinnati, OH", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.12, hrFactor: 1.16,
    elevation: 490, surface: "grass",
    note: "Jardines cortos y vallas bajas. Promedio FanGraphs 2022-2024: ~112. Segundo más hitter-friendly de la NL.",
  },
  "yankee stadium": {
    teamId: 147, team: "New York Yankees",
    city: "New York, NY", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.10, hrFactor: 1.19,
    elevation: 55, surface: "grass",
    note: "Línea izquierda corta (318 pies) infla HRs de zurdos. Promedio 2022-2024: ~110. Efecto especialmente fuerte para power hitters.",
  },
  "camden yards": {
    teamId: 110, team: "Baltimore Orioles",
    city: "Baltimore, MD", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.09, hrFactor: 1.13,
    elevation: 42, surface: "grass",
    note: "Jardines asimétricos y dimensiones medias-cortas. Promedio 2022-2024: ~109.",
  },
  "american family field": {
    teamId: 158, team: "Milwaukee Brewers",
    city: "Milwaukee, WI", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.07, hrFactor: 1.09,
    elevation: 634, surface: "grass",
    note: "Domo retráctil (antes Miller Park). Promedio 2022-2024: ~107. Ligero descenso vs años anteriores.",
  },
  "minute maid park": {
    teamId: 117, team: "Houston Astros",
    city: "Houston, TX", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.06, hrFactor: 1.08,
    elevation: 50, surface: "grass",
    note: "Domo retráctil, línea izquierda corta (315 pies). Promedio 2022-2024: ~106. El calor de Houston amplifica carry cuando está abierto.",
  },
  "globe life field": {
    teamId: 140, team: "Texas Rangers",
    city: "Arlington, TX", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.05, hrFactor: 1.07,
    elevation: 551, surface: "grass",
    note: "Inaugurado 2020. Factor ha ido bajando a medida que los datos se acumulan. Promedio 2022-2024: ~105.",
  },
  "fenway park": {
    teamId: 111, team: "Boston Red Sox",
    city: "Boston, MA", dataSeasons: "2022-2024",
    category: "Favorece bateo",
    runFactor: 1.05, hrFactor: 1.04,
    elevation: 21, surface: "grass",
    note: "Green Monster convierte extra-bases en singles. Promedio 2022-2024: ~105. Efecto neto pro-bateo.",
  },

  // ── LIGERAMENTE PRO-BATEO (runFactor 1.02 – 1.05) ───────────────────────────

  "citizens bank park": {
    teamId: 143, team: "Philadelphia Phillies",
    city: "Philadelphia, PA", dataSeasons: "2022-2024",
    category: "Favorece bateo leve",
    runFactor: 1.05, hrFactor: 1.07,
    elevation: 40, surface: "grass",
    note: "Promedio 2022-2024: ~105. Ha subido respecto a temporadas previas; la renovación del jardín no redujo el factor como se esperaba.",
  },
  "wrigley field": {
    teamId: 112, team: "Chicago Cubs",
    city: "Chicago, IL", dataSeasons: "2022-2024",
    category: "Neutro / Bateo según viento",
    runFactor: 1.03, hrFactor: 1.05,
    elevation: 594, surface: "grass",
    note: "Promedio 2022-2024: ~103. Muy volátil: con viento de salida es top-5 hitter; con viento de entrada, pitcher-friendly.",
  },
  "guaranteed rate field": {
    teamId: 145, team: "Chicago White Sox",
    city: "Chicago, IL", dataSeasons: "2022-2024",
    category: "Neutro / Bateo leve",
    runFactor: 1.04, hrFactor: 1.06,
    elevation: 594, surface: "grass",
    note: "Promedio 2022-2024: ~104. Dimensiones medias, ligeramente pro-bateo.",
  },
  "busch stadium": {
    teamId: 138, team: "St. Louis Cardinals",
    city: "St. Louis, MO", dataSeasons: "2022-2024",
    category: "Neutro / Bateo leve",
    runFactor: 1.02, hrFactor: 1.01,
    elevation: 466, surface: "grass",
    note: "Promedio 2022-2024: ~102. El calor de St. Louis en verano puede elevar levemente el factor.",
  },
  "truist park": {
    teamId: 144, team: "Atlanta Braves",
    city: "Cumberland, GA", dataSeasons: "2022-2024",
    category: "Neutro / Bateo leve",
    runFactor: 1.02, hrFactor: 1.02,
    elevation: 1010, surface: "grass",
    note: "Promedio 2022-2024: ~102. Elevación moderada de Georgia. Estable en el rango neutro.",
  },

  // ── NEUTROS (runFactor 0.97 – 1.02) ─────────────────────────────────────────

  "pnc park": {
    teamId: 134, team: "Pittsburgh Pirates",
    city: "Pittsburgh, PA", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 1.00, hrFactor: 1.01,
    elevation: 730, surface: "grass",
    note: "Promedio 2022-2024: ~100. Ha convergido a neutro tras años de ligero pro-bateo. Jardines amplios equilibran el efecto.",
  },
  "nationals park": {
    teamId: 120, team: "Washington Nationals",
    city: "Washington, DC", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 0.99, hrFactor: 0.98,
    elevation: 25, surface: "grass",
    note: "Promedio 2022-2024: ~99. Ha bajado de 2021 (hitter-friendly) a neutro. Parque amplio a nivel del mar.",
  },
  "chase field": {
    teamId: 109, team: "Arizona Diamondbacks",
    city: "Phoenix, AZ", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 1.00, hrFactor: 1.01,
    elevation: 1082, surface: "grass",
    note: "Domo retráctil que neutraliza la altitud de Phoenix (~330 m). Promedio 2022-2024: ~100.",
  },
  "citi field": {
    teamId: 121, team: "New York Mets",
    city: "New York, NY", dataSeasons: "2022-2024",
    category: "Neutro / Pitcheo leve",
    runFactor: 0.99, hrFactor: 0.96,
    elevation: 55, surface: "grass",
    note: "Promedio 2022-2024: ~99. Jardines amplios suprimen HRs. Neutro en runs totales.",
  },
  "progressive field": {
    teamId: 114, team: "Cleveland Guardians",
    city: "Cleveland, OH", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 0.99, hrFactor: 0.97,
    elevation: 653, surface: "grass",
    note: "Promedio 2022-2024: ~99. Dimensiones medias-grandes. Ligero sesgo pitcher.",
  },
  "kauffman stadium": {
    teamId: 118, team: "Kansas City Royals",
    city: "Kansas City, MO", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 0.98, hrFactor: 0.95,
    elevation: 909, surface: "grass",
    note: "Promedio 2022-2024: ~98. Jardines amplios, parque clásico. Leve ventaja para pitchers.",
  },
  "target field": {
    teamId: 142, team: "Minnesota Twins",
    city: "Minneapolis, MN", dataSeasons: "2022-2024",
    category: "Neutro",
    runFactor: 0.98, hrFactor: 0.99,
    elevation: 830, surface: "grass",
    note: "Promedio 2022-2024: ~98. Vientos variables de Minnesota. Neutro con ligero sesgo pitcher.",
  },
  "comerica park": {
    teamId: 116, team: "Detroit Tigers",
    city: "Detroit, MI", dataSeasons: "2022-2024",
    category: "Neutro / Pitcheo leve",
    runFactor: 0.97, hrFactor: 0.92,
    elevation: 600, surface: "grass",
    note: "Promedio 2022-2024: ~97. Uno de los jardines más grandes de la MLB (420 pies al centro). Suprime HRs significativamente.",
  },
  "t-mobile park": {
    teamId: 136, team: "Seattle Mariners",
    city: "Seattle, WA", dataSeasons: "2022-2024",
    category: "Neutro / Pitcheo leve",
    runFactor: 0.97, hrFactor: 0.95,
    elevation: 175, surface: "grass",
    note: "Promedio 2022-2024: ~97. Domo retráctil con aire marino del Puget Sound. Ligera ventaja para pitchers.",
  },
  "tropicana field": {
    teamId: 139, team: "Tampa Bay Rays",
    city: "St. Petersburg, FL", dataSeasons: "2022-2024",
    category: "Neutro / Pitcheo leve",
    runFactor: 0.97, hrFactor: 0.96,
    elevation: 43,
    surface: "artificial",
    note: "Domo cerrado con techo de cúpula. Superficie artificial y aire controlado. Ligeramente pitcher-friendly.",
  },

  // ── FAVORECEN EL PITCHEO (runFactor < 0.97) ─────────────────────────────────

  "rogers centre": {
    teamId: 141, team: "Toronto Blue Jays",
    city: "Toronto, ON", dataSeasons: "2022-2024",
    category: "Neutro / Pitcheo leve",
    runFactor: 0.96, hrFactor: 0.94,
    elevation: 250, surface: "artificial",
    note: "Promedio 2022-2024: ~96. Domo con superficie artificial. Pitcher-friendly leve, especialmente para HRs.",
  },
  "angel stadium": {
    teamId: 108, team: "Los Angeles Angels",
    city: "Anaheim, CA",
    category: "Favorece pitcheo",
    runFactor: 0.95, hrFactor: 0.93,
    dataSeasons: "2022-2024",
    elevation: 157, surface: "grass",
    note: "Promedio 2022-2024: ~95. Jardines amplios y brisa del Pacífico reducen carry. Consistentemente pro-pitcher.",
  },
  "dodger stadium": {
    teamId: 119, team: "Los Angeles Dodgers",
    city: "Los Angeles, CA", dataSeasons: "2022-2024",
    category: "Favorece pitcheo",
    runFactor: 0.93, hrFactor: 0.90,
    elevation: 515, surface: "grass",
    note: "Promedio 2022-2024: ~93. Aire fresco de las colinas de Chavez Ravine y jardines amplios. Uno de los mejores pitcher's parks de la NL.",
  },
  "oakland coliseum": {
    teamId: 133, team: "Oakland Athletics",
    city: "Oakland, CA", dataSeasons: "2022-2024",
    category: "Favorece pitcheo",
    runFactor: 0.93, hrFactor: 0.89,
    elevation: 43, surface: "grass",
    note: "Promedio 2022-2024: ~93. Aire marino del Pacífico y fosas abiertas. Los A's abandonaron el Coliseum tras la temporada 2024.",
  },
  "petco park": {
    teamId: 135, team: "San Diego Padres",
    city: "San Diego, CA", dataSeasons: "2022-2024",
    category: "Favorece pitcheo",
    runFactor: 0.91, hrFactor: 0.87,
    elevation: 62, surface: "grass",
    note: "Promedio 2022-2024: ~91. Brisa marina y jardín central profundo (396 pies). Referente pitcher-friendly de la MLB.",
  },
  "loandepot park": {
    teamId: 146, team: "Miami Marlins",
    city: "Miami, FL", dataSeasons: "2022-2024",
    category: "Favorece pitcheo",
    runFactor: 0.91, hrFactor: 0.89,
    elevation: 16, surface: "grass",
    note: "Promedio 2022-2024: ~91. Domo retráctil con AC. Suprime carry significativamente.",
  },
  "oracle park": {
    teamId: 137, team: "San Francisco Giants",
    city: "San Francisco, CA", dataSeasons: "2022-2024",
    category: "Favorece pitcheo",
    runFactor: 0.90, hrFactor: 0.83,
    elevation: 55, surface: "grass",
    note: "Promedio 2022-2024: ~90. Viento frío de la Bahía + jardín derecho profundo (420+ pies al centro). El pitcher's park más extremo de la NL.",
  },
  "sutter health park": {
    teamId: 133, team: "Oakland Athletics (2025, transitorio)",
    city: "Sacramento, CA", dataSeasons: "2025-provisional",
    category: "Neutro (provisional)",
    runFactor: 1.00, hrFactor: 1.00,
    elevation: 30, surface: "grass",
    note: "Parque Triple-A donde los A's jugaron en 2025 antes de mudarse a Las Vegas. Sin datos MLB suficientes — factor neutro provisional. ACTUALIZAR cuando haya datos completos de 2025.",
  },

  // ── ALIASES ALTERNATIVOS (nombres que pueden llegar de distintas APIs) ────────

  "marlins park": {
    teamId: 146, team: "Miami Marlins",
    city: "Miami, FL", dataSeasons: "alias-loandepot",
    category: "Favorece pitcheo",
    runFactor: 0.91, hrFactor: 0.89,
    elevation: 16, surface: "grass",
    note: "Nombre anterior de loanDepot Park (hasta 2021). Mismos factores.",
  },
  "american family field (miller park)": {
    teamId: 158, team: "Milwaukee Brewers",
    city: "Milwaukee, WI", dataSeasons: "alias-american-family",
    category: "Favorece bateo",
    runFactor: 1.07, hrFactor: 1.09,
    elevation: 634, surface: "grass",
    note: "Alias 'Miller Park' (hasta 2021). Renombrado American Family Field. Mismos factores.",
  },
  "globe life park": {
    teamId: 140, team: "Texas Rangers (hasta 2019)",
    city: "Arlington, TX", dataSeasons: "hasta-2019",
    category: "Favorece bateo",
    runFactor: 1.10, hrFactor: 1.13,
    elevation: 551, surface: "grass",
    note: "Parque exterior cerrado en 2020. Factor histórico más alto que Globe Life Field (techado). Solo aplica para partidos de esa era.",
  },
  "sbc park": {
    teamId: 137, team: "San Francisco Giants",
    city: "San Francisco, CA",
    category: "Favorece pitcheo",
    runFactor: 0.90,
    hrFactor: 0.84,
    elevation: 55,
    surface: "grass",
    note: "Alias histórico de Oracle Park.",
  },
  "at&t park": {
    teamId: 137, team: "San Francisco Giants",
    city: "San Francisco, CA",
    category: "Favorece pitcheo",
    runFactor: 0.90,
    hrFactor: 0.84,
    elevation: 55,
    surface: "grass",
    note: "Alias histórico de Oracle Park.",
  },
};

/**
 * Busca un parque por nombre con normalización flexible.
 * @param {string} name Nombre del parque o estadio
 * @returns {object|null} Datos del parque o null si no se encuentra
 */
function normalizeParkName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lookupBallpark(name) {
  if (!name) return null;
  const normalized = normalizeParkName(name);

  // Búsqueda exacta con ambos lados normalizados
  for (const [key, park] of Object.entries(MLB_BALLPARKS)) {
    if (normalizeParkName(key) === normalized) return park;
  }

  // Búsqueda por inclusión parcial (ambos lados normalizados)
  for (const [key, park] of Object.entries(MLB_BALLPARKS)) {
    const normKey = normalizeParkName(key);
    if (normalized.includes(normKey) || normKey.includes(normalized)) return park;
  }

  // Búsqueda por token: al menos 2 palabras significativas coinciden
  const tokens = normalized.split(" ").filter((t) => t.length > 3);
  for (const [key, park] of Object.entries(MLB_BALLPARKS)) {
    const keyTokens = normalizeParkName(key).split(" ");
    const matches = tokens.filter((t) => keyTokens.includes(t)).length;
    if (matches >= 2) return park;
  }

  return null;
}
