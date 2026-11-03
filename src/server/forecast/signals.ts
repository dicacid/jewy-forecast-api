import type { PressureContext, StationWeather, TideKind } from "../../shared/forecast";

/**
 * The pilot's experimental scoring engine, ported unchanged.
 *
 * It describes pressure behaviour around a tide turn — not fish activity. No complete
 * six-hour session means no score; a missing score is never zero.
 */

export const pressureValid = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 850 && value <= 1100;

export type PressurePoint = { time: number; pressure: number };

export function pressureAt(series: PressurePoint[], instant: number): number | null {
  if (!Number.isFinite(instant)) return null;
  const index = series.findIndex((point) => point.time >= instant);
  if (index < 0) return null;
  const next = series[index];
  if (next.time === instant) return pressureValid(next.pressure) ? next.pressure : null;
  if (index === 0) return null;
  const previous = series[index - 1];
  if (next.time - previous.time !== 3600) return null;
  if (!pressureValid(previous.pressure) || !pressureValid(next.pressure)) return null;
  return previous.pressure + ((next.pressure - previous.pressure) * (instant - previous.time)) / (next.time - previous.time);
}

/**
 * Three hours before through three hours after the turn. The session refuses to bridge
 * a missing hour, so a gap leaves the window unranked.
 */
export function pressureSession(
  series: PressurePoint[],
  instant: number,
  beforeHours = 6,
  afterHours = 3,
): PressureContext | null {
  const start = instant - beforeHours * 3600;
  const end = instant + afterHours * 3600;
  const pressure = pressureAt(series, instant);
  const first = pressureAt(series, start);
  const last = pressureAt(series, end);
  if (pressure === null || first === null || last === null) return null;
  const points = [
    { time: start, pressure: first },
    ...series.filter((point) => point.time > start && point.time < end),
    { time: end, pressure: last },
  ].sort((a, b) => a.time - b.time);
  if (points.some((point, index) => !pressureValid(point.pressure) || (index > 0 && point.time - points[index - 1].time > 3600))) {
    return null;
  }
  const values = points.map((point) => point.pressure);
  // Every three-hour interval is checked, including fractional boundaries, so a fall
  // followed by a recovery cannot hide inside a small net change.
  const starts = [start, end - 10800, ...points.flatMap((point) => [point.time, point.time - 10800])].filter(
    (time) => time >= start && time + 10800 <= end,
  );
  const maxFall3h = Math.max(
    0,
    ...starts.map((time) => (pressureAt(series, time) ?? pressure) - (pressureAt(series, time + 10800) ?? pressure)),
  );
  const change3h = pressureAt(series, instant - 3 * 3600);
  return {
    pressure,
    change6h: last - first,
    range6h: Math.max(...values) - Math.min(...values),
    change3h: change3h === null ? null : pressure - change3h,
    sessionRangeHpa: Math.max(...values) - Math.min(...values),
    minimumPressure: Math.min(...values),
    maxFall3h,
  };
}

/**
 * Trial calibration: steady pressure is the priority, with a soft preference near
 * 1020 hPa inside the 1015–1025 hPa band. Penalties are gradual, never a cliff, and
 * nothing here is validated fisheries science.
 */
export function scoreWindow(context: PressureContext | null): number | null {
  if (!context) return null;
  const { pressure, change6h, range6h } = context;
  if (!pressureValid(pressure) || change6h === null || range6h === null) return null;
  // A change is signed, so only plausibility is checked here — not the pressure range.
  if (!Number.isFinite(change6h) || !Number.isFinite(range6h) || range6h < 0) return null;
  for (const value of [context.sessionRangeHpa, context.minimumPressure, context.maxFall3h]) {
    if (!Number.isFinite(value)) return null;
  }
  if (context.sessionRangeHpa < 0 || context.maxFall3h < 0) return null;
  const minimum = context.minimumPressure;
  if (minimum < 850 || minimum > pressure || minimum > 1100) return null;

  const swing = Math.max(range6h, Math.abs(change6h), context.sessionRangeHpa);
  const penalty = (value: number, minor: number, strong: number) => {
    if (value <= minor) return (0.1 * value) / minor;
    if (value <= strong) return 0.1 + (0.5 * (value - minor)) / (strong - minor);
    return Math.min(0.8, 0.6 + (0.2 * (value - strong)) / strong);
  };
  const recent = context.change3h;
  if (recent !== null && !Number.isFinite(recent)) return null;
  const reduction = Math.max(
    penalty(swing, 2, 5),
    recent !== null && Number.isFinite(recent) ? penalty(Math.abs(recent), 2, 3) : 0,
    penalty(context.maxFall3h, 2, 3),
  );
  const preference = 0.75 + 0.25 * Math.max(0, 1 - Math.abs(pressure - 1020) / 5);
  // Local trough-impact proxy, not a meteorological trough classifier.
  const lowPressureFactor = Math.max(0.2, 1 - Math.max(0, 1015 - minimum) / 25);
  return Math.round(100 * (1 - reduction) * preference * lowPressureFactor);
}

export type ParsedTideRow = { kind: TideKind; time: string; height: string };

/** Read high/low turns from the published BOM tide table HTML. */
export function parseTideRows(html: string): ParsedTideRow[] {
  const rows: ParsedTideRow[] = [];
  const pattern =
    /<th\b[^>]*class="instance (high|low)-tide"[^>]*>[\s\S]*?<\/th>\s*<td\b[^>]*data-time-utc="([^"]+)"[^>]*>[\s\S]*?<\/td>\s*<\/tr>\s*<tr>\s*<td\b[^>]*class="height \1-tide"[^>]*>([^<]+)<\/td>/g;
  for (const match of html.matchAll(pattern)) {
    if (!Number.isFinite(Date.parse(match[2]))) continue;
    rows.push({ kind: match[1] as TideKind, time: match[2], height: match[3].trim() });
  }
  return rows;
}

const DIRECTION_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const DIRECTION_LABELS = [
  "North",
  "North-northeast",
  "Northeast",
  "East-northeast",
  "East",
  "East-southeast",
  "Southeast",
  "South-southeast",
  "South",
  "South-southwest",
  "Southwest",
  "West-southwest",
  "West",
  "West-northwest",
  "Northwest",
  "North-northwest",
];

export type StationWind = {
  speed: number | null;
  gust: number | null;
  direction: string | null;
  degrees: number | null;
};

type Row = Record<string, unknown>;

export function stationWind(row: Row): StationWind {
  const speed =
    typeof row.wind_spd_kt === "number" && Number.isFinite(row.wind_spd_kt) && row.wind_spd_kt >= 0 && row.wind_spd_kt <= 200
      ? row.wind_spd_kt
      : null;
  const gust =
    typeof row.gust_kt === "number" && Number.isFinite(row.gust_kt) && row.gust_kt >= 0 && row.gust_kt <= 250 ? row.gust_kt : null;
  const raw = String(row.wind_dir ?? "").trim().toUpperCase();
  const degrees =
    typeof row.wind_dir_deg === "number" && Number.isFinite(row.wind_dir_deg) && row.wind_dir_deg >= 0 && row.wind_dir_deg <= 360
      ? row.wind_dir_deg % 360
      : null;
  const index = degrees !== null ? Math.round(degrees / 22.5) % 16 : DIRECTION_POINTS.indexOf(raw);
  const calm = speed === 0;
  return {
    speed,
    gust,
    direction: calm ? "Calm" : index >= 0 ? DIRECTION_LABELS[index] : null,
    degrees: calm || index < 0 ? null : degrees ?? index * 22.5,
  };
}

export function bomObservationTime(row: Row): number | null {
  const stamp = String(row.aifstime_utc ?? "");
  if (!/^\d{14}$/.test(stamp)) return null;
  return Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14)),
  );
}

/** A usable observation is fresh (within 90 min), explicit and plausible. */
export function observation(row: Row, now: number): Omit<StationWeather, "trend" | "windShift"> | null {
  const time = bomObservationTime(row);
  if (time === null) return null;
  const pressure = row.press_msl ?? row.press;
  if (!pressureValid(pressure) || pressure < 900 || pressure > 1100) return null;
  if (time > now + 300000 || now - time > 5400000) return null;
  const wind = stationWind(row);
  return {
    pressure,
    pressureBasis: pressureValid(row.press_msl) ? "mean sea level" : "unspecified",
    windKt: wind.speed,
    windGustKt: wind.gust,
    windDirection: wind.direction,
    windDegrees: wind.degrees,
    updatedAt: new Date(time).toISOString(),
  };
}

/** Same-station trend against a reading roughly three hours earlier; ±0.5 hPa is steady. */
export function pressureTrend(rows: Row[], latest: { pressure: number; updatedAt: string }) {
  const at = Date.parse(latest.updatedAt);
  const prior = rows
    .map((row) => {
      const time = bomObservationTime(row);
      if (time === null) return null;
      if (Math.abs(at - time - 10800000) > 1800000) return null;
      if (typeof row.press_msl !== "number") return null;
      const reading = observation(row, time);
      return reading ? { ...reading, time } : null;
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => Math.abs(at - a.time - 10800000) - Math.abs(at - b.time - 10800000))[0];
  if (!prior) return null;
  const change = latest.pressure - prior.pressure;
  const direction = change > 0.5 ? "rising" : change < -0.5 ? "falling" : "steady";
  return { direction, changeHpa: change, hours: (at - prior.time) / 3600000 } as const;
}

/** A direction change 45–90 minutes before the latest reading. */
export function recentWindShift(rows: Row[], latest: { updatedAt: string; windDirection: string | null }) {
  if (!latest.windDirection || latest.windDirection === "Calm") return null;
  const at = Date.parse(latest.updatedAt);
  const candidates = rows
    .flatMap((row) => {
      const time = bomObservationTime(row);
      if (time === null) return [];
      const minutes = (at - time) / 60000;
      if (minutes < 45 || minutes > 90) return [];
      const wind = stationWind(row);
      return wind.speed !== null && wind.speed > 0 && wind.direction ? [{ direction: wind.direction, minutes: Math.round(minutes) }] : [];
    })
    .sort((a, b) => Math.abs(a.minutes - 60) - Math.abs(b.minutes - 60));
  const prior = candidates[0];
  return prior && prior.direction !== latest.windDirection ? prior : null;
}
