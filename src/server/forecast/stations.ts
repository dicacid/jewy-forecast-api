import type { StationAudit, StationNetwork, StationWeather } from "../../shared/forecast";
import { distanceKm } from "../../shared/estuaries";
import { BOM_HEADERS, fetchJson, fetchText } from "./http";
import { observation, pressureTrend, recentWindShift } from "./signals";

/**
 * Nearby BOM station checks. Discovery comes from the NSW/ACT IDN60920 directory;
 * every discovered station within 120 km is checked against its own 72-hour JSON feed.
 * There is no station ranking published by BOM — these are the pilot's own recent-data
 * checks (explicit MSL pressure, freshness, six hourly history bins, time-matched
 * neighbours and distance), and a disagreement is a review flag, not a fault diagnosis.
 * Station readings are never blended.
 */

type Station = { name: string; lat: number; lon: number; bomProduct: string };
type Row = Record<string, unknown>;

const INTERVAL = 10 * 60000;

const FALLBACK_STATIONS: Station[] = [
  { name: "Sydney Observatory Hill", lat: -33.86, lon: 151.2, bomProduct: "IDN60801.94768" },
  { name: "Sydney Airport", lat: -33.95, lon: 151.18, bomProduct: "IDN60801.94767" },
  { name: "Sydney Olympic Park", lat: -33.83, lon: 151.07, bomProduct: "IDN60801.95765" },
  { name: "Newcastle Nobbys", lat: -32.92, lon: 151.79, bomProduct: "IDN60801.94774" },
  { name: "Williamtown RAAF", lat: -32.79, lon: 151.84, bomProduct: "IDN60801.94776" },
  { name: "Terrey Hills", lat: -33.68, lon: 151.23, bomProduct: "IDN60801.94759" },
  { name: "Norah Head", lat: -33.28, lon: 151.57, bomProduct: "IDN60801.95784" },
  { name: "Taree Airport", lat: -31.89, lon: 152.51, bomProduct: "IDN60801.95784" },
];

const decode = (value: string) =>
  value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function parseStationDirectory(xml: string): Station[] {
  if (!xml.includes("<identifier>IDN60920</identifier>") || !xml.includes("Australian Government Bureau of Meteorology")) {
    throw new Error("Unexpected station directory");
  }
  const result = new Map<string, Station>();
  for (const match of xml.matchAll(/<station\b([^>]+)>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((pair) => [pair[1], decode(pair[2])]));
    const lat = Number(attributes.lat);
    const lon = Number(attributes.lon);
    const id = attributes["wmo-id"];
    if (!attributes.lat || !attributes.lon || !/^\d{5}$/.test(id ?? "") || !attributes["stn-name"]) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -38 || lat > -27 || lon < 140 || lon > 154) continue;
    result.set(id, { name: attributes.description || attributes["stn-name"], lat, lon, bomProduct: `IDN60801.${id}` });
  }
  if (!result.size) throw new Error("Empty station directory");
  return [...result.values()];
}

let directory: { at: number; stations: Station[] } | undefined;
let directoryPending: Promise<Station[]> | undefined;
let directoryRetry = 0;
const histories = new Map<string, { at: number; rows: Row[] }>();
const pendingHistories = new Map<string, Promise<Row[]>>();

async function directoryStations(now: number): Promise<{ stations: Station[]; complete: boolean }> {
  if (directory && now - directory.at < INTERVAL) return { stations: directory.stations, complete: true };
  if (now < directoryRetry) return { stations: directory?.stations ?? FALLBACK_STATIONS, complete: false };
  try {
    directoryPending ??= (async () => {
      const xml = await fetchText("https://www.bom.gov.au/fwo/IDN60920.xml", { headers: BOM_HEADERS });
      const found = parseStationDirectory(xml);
      directory = { at: now, stations: found };
      return found;
    })();
    return { stations: await directoryPending, complete: true };
  } catch {
    directoryRetry = now + INTERVAL;
    return { stations: directory?.stations ?? FALLBACK_STATIONS, complete: false };
  } finally {
    directoryPending = undefined;
  }
}

async function history(station: Station, now: number): Promise<Row[]> {
  const cached = histories.get(station.bomProduct);
  if (cached && now - cached.at < INTERVAL) return cached.rows;
  const underway = pendingHistories.get(station.bomProduct);
  if (underway) return underway;
  const work = (async () => {
    try {
      const { data } = await fetchJson<{ observations?: { data?: Row[] } }>(
        `https://www.bom.gov.au/fwo/IDN60801/${station.bomProduct}.json`,
        { headers: BOM_HEADERS },
      );
      const rows = data?.observations?.data;
      if (!Array.isArray(rows)) throw new Error("Invalid history");
      histories.set(station.bomProduct, { at: now, rows });
      return rows;
    } catch {
      histories.set(station.bomProduct, { at: now, rows: [] });
      return [] as Row[];
    }
  })();
  pendingHistories.set(station.bomProduct, work);
  try {
    return await work;
  } finally {
    pendingHistories.delete(station.bomProduct);
  }
}

type Assessed = {
  candidate: Station & { distanceKm: number };
  audit: StationAudit;
  weather: StationWeather | null;
};

export function assessStation(candidate: Station & { distanceKm: number }, rows: Row[], now: number): Assessed {
  // Compare only explicit MSL values. QNH or unspecified pressure is never substituted.
  const readings = rows
    .filter((row) => typeof row.press_msl === "number")
    .flatMap((row) => {
      // observation() derives the row's own timestamp and rejects anything stale.
      const reading = observation(row, now);
      return reading && reading.pressureBasis === "mean sea level" ? [{ row, reading }] : [];
    })
    .sort((a, b) => Date.parse(b.reading.updatedAt) - Date.parse(a.reading.updatedAt));

  const latest = readings[0];
  const audit: StationAudit = {
    name: candidate.name,
    distanceKm: Math.round(candidate.distanceKm),
    status: latest ? "usable" : "unavailable",
    observedAt: latest?.reading.updatedAt ?? null,
    pressure: latest?.reading.pressure ?? null,
    historyHours: 0,
    peerCount: 0,
    flags: [],
    selected: false,
  };
  if (!latest) {
    audit.flags.push("No fresh, valid mean-sea-level pressure");
    return { candidate, audit, weather: null };
  }

  const at = Date.parse(latest.reading.updatedAt);
  const buckets = new Set<number>();
  for (const row of rows) {
    if (typeof row.press_msl !== "number") continue;
    const stamp = String(row.aifstime_utc ?? "");
    if (!/^\d{14}$/.test(stamp)) continue;
    const time = Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
    );
    const reading = observation(row, time);
    if (reading && time <= at && at - time <= 6 * 3600000) buckets.add(Math.floor((at - time) / 3600000));
  }
  audit.historyHours = Math.min(6, [...buckets].filter((hour) => hour < 6).length);
  if (now - at > 45 * 60000) audit.flags.push("Reading older than 45 minutes");
  if (audit.historyHours < 6) audit.flags.push("Incomplete recent six-hour history");

  const weather: StationWeather = {
    ...latest.reading,
    windShift: recentWindShift(rows, latest.reading),
    trend: pressureTrend(rows, latest.reading),
  };
  return { candidate, audit, weather };
}

export async function nearbyStationNetwork(lat: number, lon: number, now = Date.now()): Promise<StationNetwork & { selected: Assessed | null }> {
  const discovered = await directoryStations(now);
  const nearby = discovered.stations
    .map((station) => ({ ...station, distanceKm: distanceKm(lat, lon, station.lat, station.lon) }))
    .filter((station) => station.distanceKm <= 120)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const results: Assessed[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, nearby.length) }, async () => {
    while (next < nearby.length) {
      const candidate = nearby[next++];
      results.push(assessStation(candidate, await history(candidate, now), now));
    }
  });
  await Promise.all(workers);

  for (const item of results) {
    if (!item.weather) continue;
    const reading = item.weather;
    const peers = results.filter(
      (peer) =>
        peer !== item &&
        peer.weather &&
        distanceKm(item.candidate.lat, item.candidate.lon, peer.candidate.lat, peer.candidate.lon) <= 50 &&
        Math.abs(Date.parse(peer.weather.updatedAt) - Date.parse(reading.updatedAt)) <= 30 * 60000,
    );
    item.audit.peerCount = peers.length;
    // A spatial disagreement is a review flag, not proof that an instrument is wrong.
    if (peers.length >= 2) {
      const values = peers.map((peer) => peer.weather!.pressure).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      if (Math.abs(reading.pressure - median) > 3) {
        item.audit.flags.push("Differs by over 3 hPa from nearby time-matched stations");
      }
    }
    item.audit.status = item.audit.flags.length ? "review" : "usable";
  }

  const usable = results
    .filter((item) => item.weather)
    .sort(
      (a, b) =>
        a.audit.flags.length - b.audit.flags.length ||
        Math.floor((now - Date.parse(a.weather!.updatedAt)) / 1800000) - Math.floor((now - Date.parse(b.weather!.updatedAt)) / 1800000) ||
        b.audit.historyHours - a.audit.historyHours ||
        a.candidate.distanceKm - b.candidate.distanceKm,
    );
  const selected = usable[0] ?? null;
  if (selected) selected.audit.selected = true;

  return {
    selected,
    source: "Bureau of Meteorology",
    checkedAt: new Date(now).toISOString(),
    radiusKm: 120,
    directoryComplete: discovered.complete,
    stations: results.map((item) => item.audit).sort((a, b) => a.distanceKm - b.distanceKm),
    note: "Recent data checks, not certification of instrument accuracy. No station pressures are blended. Checks refresh every ten minutes while the server runs; free-service sleep can pause scans.",
  };
}
