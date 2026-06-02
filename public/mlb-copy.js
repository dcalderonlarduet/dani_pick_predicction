/** Etiquetas y ayudas para la interfaz MLB en espanol claro. */

export const PITCHER_STATS = {
  xFIP: {
    label: "Carreras esperadas (xFIP)",
    help: "Estimacion de cuantas carreras deberia permitir el pitcher. Mas bajo = mejor.",
  },
  WHIP: {
    label: "Basistas por inning (WHIP)",
    help: "Walks + hits por cada inning lanzado. Mas bajo = mas dificil de batear.",
  },
  K9: {
    label: "Ponches por 9 innings (K/9)",
    help: "Cuantos bateadores poncha de media cada 9 entradas. Mas alto = mas dominante.",
  },
  rest: {
    label: "Dias de descanso",
    help: "Dias desde su ultima salida. Mas descanso suele ayudar al brazo.",
  },
  record: {
    label: "Victorias-Derrotas",
    help: "Balance del pitcher en el tramo reciente analizado.",
  },
};

export const TEAM_STATS = {
  scoredRecent: {
    label: "Carreras anotadas (ult. 10)",
    help: "Promedio de carreras que marca el equipo en sus ultimos 10 partidos.",
  },
  allowedRecent: {
    label: "Carreras permitidas (ult. 10)",
    help: "Promedio de carreras que le anotan en sus ultimos 10 partidos.",
  },
  scoredSeason: {
    label: "Promedio temporada",
    help: "Carreras que anota por partido en toda la temporada.",
  },
  projected: {
    label: "Proyeccion hoy",
    help: "Carreras que el modelo espera que anote hoy segun pitcher rival, relevo y estadio.",
  },
};

export const LEGEND = {
  valid: "Si: cuota y estadisticas alineadas",
  lean: "Idea del modelo; revisar cuota o esperar confirmacion",
  avoid: "Mejor no apostar en este mercado",
};
