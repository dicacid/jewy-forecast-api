import type { PressurePoint } from "../../shared/forecast";
import { fetchJson, retryAfterMs } from "./http";
import { pressureValid } from "./signals";
import type { PressureForecast } from "./pressure";

/**
 * MET Norway Locationforecast 2.0 compact, used only when the primary provider is
 * unavailable or rate-limited. MET Norway's global source is ECMWF, so the data are
 * labelled as a backup rather than as an independent model. Terms require an
 * identifying User-Agent: https://docs.api.met.no/doc/TermsOfService
 * Data: MET Norway, CC BY 4.0.
 */

const USER_AGENT = "JEWY-Mobile/1.0 (experimental NSW estuary pilot; contact: app owner)";

type MetResponse = {
  geometry?: { coordinates?: number[] };
  properties?: {
    meta?: { units?: { air_pressure_at_sea_level?: string } };
    timeseries?: Array<{ time: string; data?: { instant?: { details?: { air_pressure_at_sea_level?: number } } } }>;
  };
};

type Saved = { value: PressureForecast; expires: number; lastModified: string | null };

const cache = new Map<string, Saved>();
const pending = new Map<string, Promise<PressureForecast>>();
let retryAfter = 0;

function parseMetPressure(data: MetResponse, lat: number, lon: number): PressureForecast["hourly"] {
  const coordinates = data?.geometry?.coordinates;
  if (
    !Array.isArray(coordinates) ||
    Math.abs((coordinates[0] ?? 0) - lon) > 0.001 ||
    Math.abs((coordinates[1] ?? 0) - lat) > 0.001 ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1])
  ) {
    throw new Error("Backup pressure location mismatch.");
  }
  if (data?.properties?.meta?.units?.air_pressure_at_sea_level !== "hPa") {
    throw new Error("Backup pressure unit unavailable.");
  }
  const rows = data?.properties?.timeseries;
  if (!Array.isArray(rows) || rows.length < 7) throw new Error("Backup pressure coverage unavailable.");
  const time = rows.map((row) => Date.parse(row.time) / 1000);
  const pressure_msl = rows.map((row) => {
    const value = row?.data?.instant?.details?.air_pressure_at_sea_level;
    return pressureValid(value) ? (value as number) : null;
  });
  if (time.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= time[index - 1]))) {
    throw new Error("Invalid backup pressure series.");
  }
  if (!pressure_msl.some(pressureValid)) throw new Error("Invalid backup pressure series.");
  // Six-hour steps and missing values are preserved; the engine refuses incomplete sessions.
  return { time, pressure_msl };
}

export async function metNorwayPressure(lat: number, lon: number): Promise<PressureForecast> {
  const key = `${lat},${lon}`;
  const saved = cache.get(key);
  const now = Date.now();
  if (saved && saved.expires > now) return saved.value;
  const underway = pending.get(key);
  if (underway) return underway;
  if (now < retryAfter) throw new Error("Backup pressure service is waiting before retrying.");

  const work = (async () => {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
    if (saved?.lastModified) headers["If-Modified-Since"] = saved.lastModified;
    const query = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4) });
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?${query}`;
    let result: Awaited<ReturnType<typeof fetchJson<MetResponse>>>;
    try {
      result = await fetchJson<MetResponse>(url, { headers, timeout: 9000 });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429) {
        retryAfter = Date.now() + Math.max(10 * 60000, retryAfterMs(null));
        throw new Error("Backup pressure service is rate-limited.");
      }
      throw error;
    }
    const expires = Math.max(Date.now() + 3 * 3600000, Date.parse(result.headers.get("expires") ?? "") || 0);
    const value: PressureForecast = {
      hourly: parseMetPressure(result.data, lat, lon),
      fetchedAt: new Date().toISOString(),
      source: "ECMWF global forecast via MET Norway (backup)",
      comparison: null,
    };
    if (cache.size >= 32) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { value, expires, lastModified: result.headers.get("last-modified") });
    return value;
  })();

  pending.set(key, work);
  try {
    return await work;
  } catch (error) {
    retryAfter = Math.max(retryAfter, Date.now() + 60 * 60000);
    throw error;
  } finally {
    pending.delete(key);
  }
}

export type { PressurePoint };
