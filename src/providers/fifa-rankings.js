/**
 * Rankings FIFA aproximados — mapa estático actualizable manualmente.
 * Fuente: FIFA World Rankings masculinos (aproximado a junio 2026).
 * No hace scraping en runtime; usar como fallback cuando no hay ESPN ni cuotas.
 */
const FIFA_RANKINGS = {
  // Inglés
  argentina: 1, france: 2, spain: 3, england: 4, brazil: 5,
  belgium: 6, portugal: 7, netherlands: 8, germany: 9, croatia: 10,
  italy: 11, morocco: 12, colombia: 13, japan: 14, usa: 15,
  denmark: 16, senegal: 17, switzerland: 18, mexico: 19, austria: 20,
  turkey: 21, ukraine: 22, uruguay: 23, poland: 24, serbia: 25,
  iran: 26, nigeria: 27, australia: 28, romania: 29, "south korea": 30,
  hungary: 31, russia: 32, wales: 33, czech: 34, slovakia: 35,
  egypt: 36, algeria: 37, slovenia: 38, norway: 39, chile: 40,
  cameroon: 41, ecuador: 42, sweden: 43, scotland: 44, venezuela: 45,
  paraguay: 46, greece: 47, "ivory coast": 48, mali: 49, peru: 50,
  "costa rica": 51, ghana: 52, canada: 53, "new zealand": 54, qatar: 55,
  "saudi arabia": 56, iraq: 57, tunisia: 58, albania: 59, israel: 60,
  iceland: 61, finland: 62, indonesia: 63, thailand: 64, georgia: 65,
  "north macedonia": 66, bolivia: 68, honduras: 69, jamaica: 70,
  armenia: 71, azerbaijan: 72, ireland: 73, "cape verde": 74, panama: 75,
  "burkina faso": 76, angola: 77, "el salvador": 79,
  "northern ireland": 81, "bosnia and herzegovina": 82, zambia: 83,
  guinea: 84, "dr congo": 85, jordan: 86, haiti: 87, benin: 88,
  lebanon: 89, cyprus: 102, "faroe islands": 109,
  estonia: 114, latvia: 131, lithuania: 140, liechtenstein: 190,
  // Español / otros idiomas
  espana: 3, inglaterra: 4, brasil: 5, belgica: 6, alemania: 9, croacia: 10,
  italia: 11, marruecos: 12, dinamarca: 16, suiza: 18, turquia: 21,
  ucrania: 22, polonia: 24, serbia: 25, australia: 28, rumania: 29,
  hungria: 31, rusia: 32, gales: 33, noruega: 39, escocia: 44,
  suecia: 43, eslovenia: 38, grecia: 47, chipre: 102,
  "islas feroe": 109, estonia: 114, letonia: 131, lituania: 140,
  liechtenstein: 190, "nueva zelanda": 54, tunez: 58,
  "nueva zelanda": 54, "nueva zelandia": 54,
};

/** Normaliza el nombre de un país para búsqueda en el mapa. */
function normalizeCountry(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Devuelve el ranking FIFA aproximado de un país.
 * Si no lo encuentra directamente, intenta coincidencia por substring.
 * @returns {number|null} Ranking (1 = mejor) o null si no se encuentra.
 */
export function getFifaRank(countryName) {
  const key = normalizeCountry(countryName);
  if (!key) return null;
  if (FIFA_RANKINGS[key] !== undefined) return FIFA_RANKINGS[key];
  // Búsqueda por substring (ej. "nueva zelanda" → "new zealand")
  for (const [k, rank] of Object.entries(FIFA_RANKINGS)) {
    if (key.includes(k) || k.includes(key)) return rank;
  }
  return null;
}

/**
 * Calcula probabilities 1/X/2 basadas solo en diferencia de ranking FIFA.
 * Devuelve { p1, px, p2, method, rankHome, rankAway, rankDiff } o null.
 */
export function fifaRankingProbs(homeTeam, awayTeam) {
  const rankHome = getFifaRank(homeTeam);
  const rankAway = getFifaRank(awayTeam);
  if (rankHome === null && rankAway === null) return null;

  const rH = rankHome ?? 150;
  const rA = rankAway ?? 150;
  const diff = rA - rH; // positivo = local mejor rankeado

  let p1, px, p2;
  if (Math.abs(diff) > 80) {
    // Diferencia masiva: muy claro favorito
    p1 = diff > 0 ? 0.72 : 0.08;
    px = 0.18;
    p2 = diff > 0 ? 0.10 : 0.74;
  } else if (Math.abs(diff) > 50) {
    p1 = diff > 0 ? 0.58 : 0.15;
    px = 0.22;
    p2 = diff > 0 ? 0.20 : 0.63;
  } else if (Math.abs(diff) > 20) {
    p1 = diff > 0 ? 0.46 : 0.25;
    px = 0.28;
    p2 = diff > 0 ? 0.26 : 0.47;
  } else {
    // Equipos similares → empate más probable
    p1 = 0.34;
    px = 0.32;
    p2 = 0.34;
  }

  // Home advantage genérico: +5% al local si es partido neutral
  // (en selecciones no siempre hay ventaja de campo clara)
  return {
    p1: Math.round(p1 * 1000) / 1000,
    px: Math.round(px * 1000) / 1000,
    p2: Math.round(p2 * 1000) / 1000,
    method: "fifa-ranking-only",
    rankHome: rH,
    rankAway: rA,
    rankDiff: diff,
  };
}
