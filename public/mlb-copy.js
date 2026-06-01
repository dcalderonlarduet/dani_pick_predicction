/** Etiquetas y ayudas para la interfaz MLB (español claro). */

export const PITCHER_STATS = {
  xFIP: {
    label: "Carreras esperadas (xFIP)",
    help: "Estimación de cuántas carreras debería permitir el pitcher. Más bajo = mejor.",
  },
  WHIP: {
    label: "Basistas por inning (WHIP)",
    help: "Walks + hits por cada inning lanzado. Más bajo = más difícil de batear.",
  },
  K9: {
    label: "Ponches por 9 innings (K/9)",
    help: "Cuántos bateadores poncha de media cada 9 entradas. Más alto = más dominante.",
  },
  rest: {
    label: "Días de descanso",
    help: "Días desde su última salida. Más descanso suele ayudar al brazo.",
  },
  record: {
    label: "Victorias-Derrotas",
    help: "Balance del pitcher en el tramo reciente analizado.",
  },
};

export const TEAM_STATS = {
  scoredRecent: {
    label: "Carreras anotadas (últ. 10)",
    help: "Promedio de carreras que marca el equipo en sus últimos 10 partidos.",
  },
  allowedRecent: {
    label: "Carreras permitidas (últ. 10)",
    help: "Promedio de carreras que le anotan en sus últimos 10 partidos.",
  },
  scoredSeason: {
    label: "Promedio temporada",
    help: "Carreras que anota por partido en toda la temporada.",
  },
  projected: {
    label: "Proyección hoy",
    help: "Carreras que el modelo espera que anote hoy, según pitcher rival, relevo y estadio.",
  },
};

export const LEGEND = {
  valid: "Sí: cuota y estadísticas alineadas",
  lean: "Idea del modelo; revisar cuota o esperar confirmación",
  avoid: "Mejor no apostar en este mercado",
};
