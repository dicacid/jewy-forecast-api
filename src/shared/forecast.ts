/**
 * Payload contract shared by the JEWY API server and the app.
 *
 * These are the pilot's public fields: an experimental conditions match, never a
 * catch probability. Missing coverage is represented as `null`, never as zero.
 */

export type TideKind = "high" | "low";

export type PressureContext = {
  pressure: number;
  change6h: number | null;
  range6h: number | null;
  change3h: number | null;
  sessionRangeHpa: number;
  minimumPressure: number;
  maxFall3h: number;
};

export type TideWindow = {
  kind: TideKind;
  time: string;
  height: string;
  score: number | null;
  pressureContext: PressureContext | null;
};

export type StationReading = {
  name: string;
  distanceKm: number;
};

export type StationWeather = {
  pressure: number;
  pressureBasis?: string;
  windKt: number | null;
  windGustKt: number | null;
  windDirection: string | null;
  windDegrees: number | null;
  windShift: { direction: string; minutes: number } | null;
  updatedAt: string;
  trend: { direction: "rising" | "falling" | "steady"; changeHpa: number; hours: number } | null;
};

export type TideSite = {
  name: string;
  id: string;
  method: "official-offset" | "reference-port";
  referenceName: string;
  referenceId: string;
  highMinutes: number;
  lowMinutes: number;
  sourceUrl?: string;
  validThrough?: string;
};

export type StationAudit = {
  name: string;
  distanceKm: number;
  status: string;
  observedAt: string | null;
  pressure: number | null;
  historyHours: number;
  peerCount: number;
  flags: string[];
  selected: boolean;
};

export type StationNetwork = {
  source: string;
  checkedAt: string;
  radiusKm: number;
  directoryComplete: boolean;
  stations: StationAudit[];
  note: string;
};

export type PressurePoint = { time: number; pressure: number | null };

export type Coverage = {
  expectedHours: number;
  availableHours: number;
  complete: boolean;
  stale: boolean;
};

export type Forecast = {
  river: string;
  rivers: string[];
  station: StationReading | null;
  weather: StationWeather | null;
  tideSite: TideSite;
  windows: TideWindow[];
  bestWindow: TideWindow | null;
  score: number | null;
  verdict: string;
  generatedAt: string;
  warnings: string[];
  forecastSource: string;
  pressureFetchedAt: string | null;
  pressureCoverage: Coverage | null;
  pressureSeries: PressurePoint[];
  comparison: { source: string; series: PressurePoint[] } | null;
  stationNetwork: StationNetwork | null;
  experimental: true;
};

export type ForecastError = { error: string };
