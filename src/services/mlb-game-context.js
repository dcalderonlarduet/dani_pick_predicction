import { clamp, round } from "../utils/math.js";
import { fetchJson } from "../providers/shared/http.js";
import { loadWithCache } from "../providers/shared/resource-cache.js";

/**
 * Coordenadas del estadio y rumbo a CF (grados desde el norte, sentido horario).
 * cfBearing: dirección home plate → center field (para viento salida/entrada).
 */
export const MLB_STADIUM_COORDS = {
  108: { lat: 33.34, lon: -117.91, cfBearing: 15, label: "Angel Stadium" },
  109: { lat: 33.89, lon: -84.47, cfBearing: 10, label: "Truist Park" },
  110: { lat: 39.28, lon: -76.62, cfBearing: 25, label: "Camden Yards" },
  111: { lat: 42.35, lon: -71.05, cfBearing: 30, label: "Fenway Park" },
  112: { lat: 41.95, lon: -87.66, cfBearing: 355, label: "Wrigley Field" },
  113: { lat: 39.1, lon: -84.51, cfBearing: 5, label: "Great American Ball Park" },
  114: { lat: 41.5, lon: -81.69, cfBearing: 15, label: "Progressive Field" },
  115: { lat: 39.76, lon: -104.99, cfBearing: 5, label: "Coors Field" },
  116: { lat: 38.87, lon: -77.01, cfBearing: 20, label: "Nationals Park" },
  117: { lat: 29.76, lon: -95.36, cfBearing: 0, label: "Minute Maid Park" },
  118: { lat: 39.05, lon: -94.48, cfBearing: 10, label: "Kauffman Stadium" },
  119: { lat: 34.07, lon: -118.24, cfBearing: 10, label: "Dodger Stadium" },
  120: { lat: 38.63, lon: -90.2, cfBearing: 5, label: "Busch Stadium" },
  121: { lat: 37.78, lon: -122.39, cfBearing: 22, label: "Oracle Park" },
  133: { lat: 37.75, lon: -122.2, cfBearing: 20, label: "Oakland Coliseum" },
  134: { lat: 47.59, lon: -122.33, cfBearing: 350, label: "T-Mobile Park" },
  135: { lat: 32.71, lon: -117.16, cfBearing: 350, label: "Petco Park" },
  136: { lat: 47.59, lon: -122.33, cfBearing: 350, label: "T-Mobile Park" },
  137: { lat: 37.78, lon: -122.39, cfBearing: 22, label: "Oracle Park" },
  138: { lat: 38.62, lon: -90.19, cfBearing: 5, label: "Busch Stadium" },
  139: { lat: 27.77, lon: -82.65, cfBearing: 0, label: "Tropicana Field" },
  140: { lat: 32.75, lon: -97.08, cfBearing: 0, label: "Globe Life Field" },
  141: { lat: 43.64, lon: -79.39, cfBearing: 355, label: "Rogers Centre" },
  142: { lat: 44.98, lon: -93.28, cfBearing: 20, label: "Target Field" },
  143: { lat: 40.46, lon: -80.01, cfBearing: 340, label: "PNC Park" },
  144: { lat: 39.91, lon: -75.17, cfBearing: 15, label: "Citizens Bank Park" },
  145: { lat: 41.83, lon: -87.63, cfBearing: 0, label: "Guaranteed Rate Field" },
  146: { lat: 25.78, lon: -80.22, cfBearing: 355, label: "loanDepot park" },
  147: { lat: 40.83, lon: -73.93, cfBearing: 25, label: "Yankee Stadium" },
  158: { lat: 43.03, lon: -87.97, cfBearing: 355, label: "American Family Field" },
};

function bearingDifference(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

/** Viento meteorológico (desde) vs rumbo CF: salida / entrada / lateral. */
export function windRunFactor(windFromDeg, windMph, cfBearing) {
  if (!Number.isFinite(windFromDeg) || !Number.isFinite(windMph) || windMph < 3 || !Number.isFinite(cfBearing)) {
    return 0;
  }
  const windToDeg = (windFromDeg + 180) % 360;
  const diff = bearingDifference(windToDeg, cfBearing);
  if (diff <= 45) return 0.045 * windMph;
  if (diff >= 135) return -0.038 * windMph;
  return 0.012 * windMph;
}

const DOME_OR_RETRACTABLE = new Set([
  117, 118, 139, 140, 141, 145, 146, 158,
]);

const MLB_WEATHER_CACHE = "mlb-weather-open-meteo";

function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseGameDateParts(iso) {
  const text = String(iso || "");
  const date = text.slice(0, 10);
  const hour = text.length >= 13 ? asInteger(text.slice(11, 13), 18) : 18;
  return { date, hour };
}

export function parseUmpireFromFeed(feed) {
  const officials = feed?.gameData?.officials || feed?.gameData?.umpires || [];
  const list = Array.isArray(officials) ? officials : [];
  const homePlate =
    list.find((entry) => /home|plate|hp/i.test(String(entry?.officialType || entry?.position || ""))) ||
    list[0] ||
    null;
  const name = homePlate?.official?.fullName || homePlate?.fullName || homePlate?.name || null;
  return {
    homePlate: name,
    crewSize: list.length,
    label: name ? `HP: ${name}` : null,
  };
}

export function scoreBullpenFatigue(bullpen = {}) {
  const pitches48 = Number(bullpen.usage48hPitches) || 0;
  const apps48 = Number(bullpen.usage48hAppearances) || 0;
  const era7 = Number(bullpen.era7);
  const innings7 = Number.parseFloat(String(bullpen.innings7 || "0").replace(",", ".")) || 0;

  let score = 0;
  if (pitches48 >= 140) score += 4;
  else if (pitches48 >= 100) score += 3;
  else if (pitches48 >= 70) score += 2;
  else if (pitches48 >= 45) score += 1;

  if (apps48 >= 5) score += 2;
  else if (apps48 >= 3) score += 1;

  if (Number.isFinite(era7)) {
    if (era7 >= 5.5) score += 2;
    else if (era7 >= 4.8) score += 1;
  }

  if (innings7 >= 12) score += 1;

  const tier = score >= 6 ? "alto" : score >= 3 ? "medio" : "bajo";
  return {
    score: clamp(score, 0, 8),
    tier,
    label:
      tier === "alto"
        ? "Bullpen muy castigado (48h)"
        : tier === "medio"
          ? "Bullpen con uso reciente"
          : "Bullpen descansado",
  };
}

export function computeScheduleFatigue(schedulePayload, teamId, gameDate) {
  const games = (schedulePayload?.dates || [])
    .flatMap((block) => block.games || [])
    .filter((game) => game?.status?.abstractGameState === "Final")
    .map((game) => {
      const isHome = String(game?.teams?.home?.team?.id) === String(teamId);
      const team = isHome ? game?.teams?.home : game?.teams?.away;
      const opponent = isHome ? game?.teams?.away : game?.teams?.home;
      return {
        date: game?.officialDate || String(game?.gameDate || "").slice(0, 10),
        isHome,
        runsScored: Number(team?.score) || 0,
        runsAllowed: Number(opponent?.score) || 0,
        innings: Number(game?.linescore?.currentInning) || 9,
        venue: game?.venue?.name || null,
      };
    })
    .sort((left, right) => String(right.date).localeCompare(String(left.date)));

  const last = games[0] || null;
  const last3 = games.slice(0, 3);
  const daysSinceLast = last?.date
    ? Math.max(0, Math.round((new Date(gameDate) - new Date(last.date)) / 86400000))
    : 3;

  let travelBurden = 0;
  let consecutiveRoad = 0;
  let extraInningsYesterday = false;
  let backToBack = daysSinceLast <= 1;

  if (last && last.innings > 9) extraInningsYesterday = true;

  for (const game of games.slice(0, 5)) {
    if (!game.isHome) consecutiveRoad += 1;
    else break;
  }

  if (last3.length >= 2) {
    const cities = new Set(last3.map((g) => g.venue).filter(Boolean));
    if (cities.size >= 3) travelBurden += 2;
    else if (cities.size >= 2) travelBurden += 1;
  }

  if (consecutiveRoad >= 4) travelBurden += 2;
  else if (consecutiveRoad >= 2) travelBurden += 1;

  if (backToBack) travelBurden += 1;
  if (extraInningsYesterday) travelBurden += 1;

  const fatigueScore = clamp(travelBurden + (backToBack ? 1 : 0), 0, 6);
  const tier = fatigueScore >= 4 ? "alto" : fatigueScore >= 2 ? "medio" : "bajo";

  return {
    daysSinceLast,
    backToBack,
    extraInningsYesterday,
    consecutiveRoadGames: consecutiveRoad,
    travelBurden,
    fatigueScore,
    tier,
    label:
      tier === "alto"
        ? "Calendario exigente (viajes/B2B)"
        : tier === "medio"
          ? "Algo de fatiga de calendario"
          : "Calendario normal",
  };
}

export function weatherRunAdjustment(weather, park = {}, teamId = null) {
  if (!weather || weather.indoor) return { homeDelta: 0, awayDelta: 0, totalDelta: 0, runAdjust: 0, note: null };

  const coords = teamId != null ? MLB_STADIUM_COORDS[teamId] : null;
  const cfBearing = coords?.cfBearing ?? null;
  let runAdjust = 0;
  const notes = [];

  if (Number.isFinite(weather.windSpeedMph) && Number.isFinite(weather.windDirectionDeg) && cfBearing != null) {
    const windFactor = windRunFactor(weather.windDirectionDeg, weather.windSpeedMph, cfBearing);
    runAdjust += windFactor;
    if (windFactor > 0.05) notes.push(`Viento de salida ~${Math.round(weather.windSpeedMph)} mph`);
    else if (windFactor < -0.05) notes.push(`Viento de entrada ~${Math.round(weather.windSpeedMph)} mph`);
    else if (Math.abs(windFactor) > 0.02) notes.push(`Viento lateral ~${Math.round(weather.windSpeedMph)} mph`);
  } else if (Number.isFinite(weather.windSpeedMph) && weather.windSpeedMph >= 12) {
    const fallback = weather.windHelpsOffense ? 0.04 * weather.windSpeedMph : weather.windHurtsOffense ? -0.03 * weather.windSpeedMph : 0;
    runAdjust += fallback;
    if (fallback > 0) notes.push(`Viento a favor del bateo (~${Math.round(weather.windSpeedMph)} mph)`);
    else if (fallback < 0) notes.push(`Viento en contra (~${Math.round(weather.windSpeedMph)} mph)`);
  }

  if (Number.isFinite(weather.temperatureF)) {
    const tempFactor = (weather.temperatureF - 72) * 0.012;
    runAdjust += tempFactor;
    if (tempFactor >= 0.08) notes.push(`Calor ${Math.round(weather.temperatureF)}°F`);
    else if (tempFactor <= -0.08) notes.push(`Frío ${Math.round(weather.temperatureF)}°F`);
  }

  if (Number.isFinite(park.elevation) && park.elevation >= 3000) {
    runAdjust += 0.25;
    notes.push("Alta altitud");
  }

  runAdjust = clamp(runAdjust, -0.35, 1.15);
  const totalDelta = round(runAdjust, 3);

  return {
    homeDelta: totalDelta / 2,
    awayDelta: totalDelta / 2,
    totalDelta,
    runAdjust,
    note: notes.length ? notes.join(" · ") : null,
  };
}

async function fetchOpenMeteoHour(lat, lon, date, hourUtcApprox) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", "temperature_2m,windspeed_10m,winddirection_10m,precipitation");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);

  const payload = await loadWithCache(
    MLB_WEATHER_CACHE,
    url.toString(),
    { ttlMs: 3 * 60 * 60 * 1000, staleMs: 12 * 60 * 60 * 1000 },
    () => fetchJson(url.toString(), { provider: "open-meteo", timeoutMs: 12000 })
  );

  const times = payload?.hourly?.time || [];
  const idx = Math.min(Math.max(hourUtcApprox, 0), Math.max(0, times.length - 1));
  const tempC = payload?.hourly?.temperature_2m?.[idx];
  const windKmh = payload?.hourly?.windspeed_10m?.[idx];
  const windDir = payload?.hourly?.winddirection_10m?.[idx];
  const precip = payload?.hourly?.precipitation?.[idx];

  return {
    temperatureC: Number.isFinite(tempC) ? tempC : null,
    windSpeedKmh: Number.isFinite(windKmh) ? windKmh : null,
    windDirectionDeg: Number.isFinite(windDir) ? windDir : null,
    precipitationMm: Number.isFinite(precip) ? precip : null,
  };
}

/**
 * Clima vía Open-Meteo (gratis, sin API key). Si falla, devuelve null.
 */
export async function loadGameWeather(teamId, gameStartIso, park = {}) {
  const coords = MLB_STADIUM_COORDS[teamId];
  if (!coords) return null;

  const indoor = DOME_OR_RETRACTABLE.has(teamId) || /dome|retractable|roof|tropicana|globe life/i.test(park.note || "");
  if (indoor) {
    return {
      source: "open-meteo",
      indoor: true,
      label: "Estadio cubierto / domo — clima neutralizado",
      totalDelta: 0,
    };
  }

  const { date, hour } = parseGameDateParts(gameStartIso);
  try {
    const hourData = await fetchOpenMeteoHour(coords.lat, coords.lon, date, hour);
    const tempF = Number.isFinite(hourData.temperatureC) ? hourData.temperatureC * 1.8 + 32 : null;
    const windMph = Number.isFinite(hourData.windSpeedKmh) ? hourData.windSpeedKmh * 0.621371 : null;

    return {
      source: "open-meteo",
      indoor: false,
      temperatureF: tempF != null ? round(tempF, 0) : null,
      windSpeedMph: windMph != null ? round(windMph, 1) : null,
      windDirectionDeg: hourData.windDirectionDeg,
      precipitationMm: hourData.precipitationMm,
      windHelpsOffense:
        Number.isFinite(windMph) &&
        Number.isFinite(hourData.windDirectionDeg) &&
        windRunFactor(hourData.windDirectionDeg, windMph, coords?.cfBearing ?? 0) > 0.03,
      windHurtsOffense:
        Number.isFinite(windMph) &&
        Number.isFinite(hourData.windDirectionDeg) &&
        windRunFactor(hourData.windDirectionDeg, windMph, coords?.cfBearing ?? 0) < -0.03,
      label: [
        tempF != null ? `${round(tempF, 0)}°F` : null,
        windMph != null ? `viento ${round(windMph, 0)} mph` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  } catch {
    return null;
  }
}
