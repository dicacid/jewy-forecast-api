import type { Coverage, PressurePoint } from "../../shared/forecast";
import { fetchJson, retryAfterMs, UpstreamError } from "./http";
import { pressureValid } from "./signals";
import { metNorwayPressure } from "./metNorway";

/**
 * Exact-location mean-sea-level pressure. ECMWF IFS is the primary provider; NOAA GFS
 * is requested alongside it only as a labelled cross-check. MET Norway's global
 * forecast is the independent backup. One provider supplies a whole session — series
 * are never blended and missing hours are never invented.
 */

export type PressureForecast = {
  hourly: { time: number[]; pressure_msl: (number | null)[] };
  fetchedAt: string;
  source: string;
  stale?: boolean;
  comparison: { source: string; series: PressurePoint[] } | null;
};

type OpenMeteoResponse = {
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: number[];
    pressure_msl_ecmwf_ifs?: (number | null)[];
    pressure_msl_gfs_global?: (number | null)[];
  };
};

const CACHE_TTL = 3 * 3600000;
const FAILURE_WAIT = 60 * 60000;
const cache = new Map<string, { value: PressureForecast; expires: number }>();
const pending = new Map<string, Promise<PressureForecast>>();
const failures = new Map<string, number>();
let retryAfter = 0;

export function pressureBackoff(): boolean {
  return Date.now() < retryAfter;
}

export function notePressureRateLimit(header: string | null): void {
  const wait = retryAfterMs(header);
  retryAfter = Math.max(retryAfter, Date.now() + Math.max(60 * 60000, wait));
}

function seriesFrom(times: number[], values: (number | null)[] | undefined): PressurePoint[] {
  if (!values) return [];
  return times.map((time, index) => ({
    time,
    pressure: pressureValid(values[index]) ? (values[index] as number) : null,
  }));
}

export async function primaryPressureForecast(lat: number, lon: number, refresh = false): Promise<PressureForecast> {
  const key = `${lat},${lon}`;
  const now = Date.now();
  const saved = cache.get(key);
  if (saved && saved.expires > now && (now - Date.parse(saved.value.fetchedAt) < 60 * 60000 || pressureBackoff() || !refresh)) {
    // A cache hit is not a failure: the value is only ever marked stale by
    // localPressureForecast when a requested refresh could not reach the provider.
    return saved.value;
  }
  const underway = pending.get(key);
  if (underway) return underway;
  const blockedUntil = failures.get(key) ?? 0;
  if (blockedUntil > now) throw new UpstreamError("Pressure forecast update failed; waiting before retrying.");
  if (pressureBackoff()) throw new UpstreamError("Pressure forecast provider is rate-limited; waiting before retrying.");

  const work = (async () => {
    const query = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: "pressure_msl",
      models: "ecmwf_ifs,gfs_global",
      timezone: "UTC",
      timeformat: "unixtime",
      past_days: "1",
      forecast_days: "8",
    });
    let result: Awaited<ReturnType<typeof fetchJson<OpenMeteoResponse>>>;
    try {
      result = await fetchJson<OpenMeteoResponse>(`https://api.open-meteo.com/v1/ecmwf?${query}`, { timeout: 9000 });
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 429) {
        notePressureRateLimit(null);
        throw new UpstreamError("Pressure forecast provider is rate-limited (429).", 429);
      }
      throw error;
    }
    const data = result.data;
    const hourly = data?.hourly;
    if (
      !Number.isFinite(data.latitude) ||
      !Number.isFinite(data.longitude) ||
      Math.abs((data.latitude as number) - lat) > 0.5 ||
      Math.abs((data.longitude as number) - lon) > 0.5
    ) {
      throw new UpstreamError("Pressure forecast location mismatch.");
    }
    const times = hourly?.time;
    const pressure = hourly?.pressure_msl_ecmwf_ifs;
    if (
      !Array.isArray(times) ||
      times.length < 24 ||
      times.length !== pressure?.length ||
      times.some((time, index) => typeof time !== "number" || !Number.isFinite(time) || (index > 0 && time - times[index - 1] !== 3600)) ||
      !pressure?.some(pressureValid)
    ) {
      throw new UpstreamError("Pressure forecast coverage unavailable.");
    }
    const comparisonSeries = seriesFrom(times, hourly?.pressure_msl_gfs_global);
    const value: PressureForecast = {
      hourly: { time: times, pressure_msl: pressure },
      fetchedAt: new Date().toISOString(),
      source: "ECMWF IFS HRES 9 km via Open-Meteo",
      comparison: comparisonSeries.some((point) => point.pressure !== null)
        ? { source: "NOAA GFS via Open-Meteo", series: comparisonSeries }
        : null,
    };
    failures.delete(key);
    if (cache.size >= 32) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { value, expires: Date.now() + CACHE_TTL });
    return value;
  })();

  pending.set(key, work);
  try {
    return await work;
  } catch (error) {
    failures.set(key, Date.now() + FAILURE_WAIT);
    console.warn("Primary pressure request failed:", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    pending.delete(key);
  }
}

/** Primary provider, then a retained older forecast, then the MET Norway backup. */
export async function localPressureForecast(lat: number, lon: number, refresh = false): Promise<PressureForecast> {
  try {
    return await primaryPressureForecast(lat, lon, refresh);
  } catch (primary) {
    const saved = cache.get(`${lat},${lon}`);
    if (saved && saved.expires > Date.now()) return { ...saved.value, stale: true };
    try {
      return await metNorwayPressure(lat, lon);
    } catch (backup) {
      if (
        saved &&
        Date.now() - Date.parse(saved.value.fetchedAt) <= 12 * 3600000 &&
        saved.value.hourly.time.some((time, index) => time > Date.now() / 1000 && pressureValid(saved.value.hourly.pressure_msl[index]))
      ) {
        return { ...saved.value, stale: true };
      }
      throw new UpstreamError(`${String(primary)} ${String(backup)}`);
    }
  }
}

export function pressureCoverage(forecast: PressureForecast, now = Date.now()): Coverage {
  const first = Math.ceil(now / 3600000) * 3600;
  const valid = new Set(forecast.hourly.time.filter((time, index) => pressureValid(forecast.hourly.pressure_msl[index])));
  const hours = Array.from({ length: 168 }, (_, index) => first + index * 3600);
  return {
    expectedHours: 168,
    availableHours: hours.filter((time) => valid.has(time)).length,
    complete: hours.every((time) => valid.has(time)),
    stale: forecast.stale === true,
  };
}

/** The seven-day hourly series handed to the app for its pressure chart. */
export function forecastSeries(forecast: PressureForecast, now = Date.now()): PressurePoint[] {
  const from = Math.floor((now - 6 * 3600000) / 1000);
  const to = Math.floor((now + 7 * 86400000) / 1000);
  return forecast.hourly.time.flatMap((time, index) =>
    time >= from && time <= to ? [{ time, pressure: pressureValid(forecast.hourly.pressure_msl[index]) ? (forecast.hourly.pressure_msl[index] as number) : null }] : [],
  );
}
