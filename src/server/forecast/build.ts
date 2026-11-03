import type { Forecast, TideWindow } from "../../shared/forecast";
import { ESTUARIES } from "../../shared/estuaries";
import { dayKey } from "../../shared/sydney";
import { findEstuary, tideSiteFor } from "./locations";
import { fetchTideTurns, localTideTurns } from "./tides";
import { forecastSeries, localPressureForecast, pressureCoverage } from "./pressure";
import { pressureSession, pressureValid, scoreWindow, type PressurePoint } from "./signals";
import { nearbyStationNetwork } from "./stations";

/** An error the route can turn into a status code and a readable message. */
export class ForecastError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "ForecastError";
    this.status = status;
  }
}

const EXPERIMENTAL_RULE =
  "Experimental rule: steady pressure is the priority, with preference near 1020 hPa in the 1015–1025 hPa band. Stability checks three hours before through three hours after each tide turn, including the largest three-hour fall. Small changes have a mild effect; a 5 hPa session swing has a stronger gradual effect. Pressure below 1015 hPa reduces the index progressively, using the lowest pressure across that window. This is a local pressure proxy for trough impact, not automatic trough or front identification. Pressure alone does not zero the index. Tide turns identify candidate times, not local slack water. Not validated against catches.";

export async function buildForecast(riverName: string | null, refresh = false): Promise<Forecast> {
  const river = findEstuary(riverName ?? "Karuah River");
  if (!river) throw new ForecastError("River not supported. Choose a listed estuary.", 400);

  const now = Date.now();
  const warnings: string[] = [];
  const site = tideSiteFor(river);

  const [tideResult, pressureResult, stationResult] = await Promise.allSettled([
    fetchTideTurns(site, now),
    localPressureForecast(river.lat, river.lon, refresh),
    nearbyStationNetwork(river.lat, river.lon, now),
  ]);

  const referenceTurns = tideResult.status === "fulfilled" ? tideResult.value.turns : [];
  let windowsBase = localTideTurns(referenceTurns, site);

  if (site.validThrough && dayKey(now) > site.validThrough) {
    windowsBase = [];
    warnings.push("Local tide correction needs an updated official source. No local tide times or scores are supplied.");
  }
  if (!windowsBase.length) warnings.push("Tide reference unavailable. No fishing scores can be calculated.");
  if (tideResult.status === "fulfilled" && tideResult.value.failed > 0) {
    warnings.push("Part of the BOM tide table could not be retrieved. Only the available days are listed.");
  }

  const pressure = pressureResult.status === "fulfilled" ? pressureResult.value : null;
  const hourly = pressure?.hourly ?? null;
  if (!hourly?.time?.length) {
    warnings.push("Exact-location pressure forecast unavailable.");
    if (pressureResult.status === "rejected") {
      const reason = String(pressureResult.reason);
      console.warn("Local pressure forecast failed:", reason);
      if (/rate-limit/i.test(reason)) {
        warnings.push("Pressure forecast provider is rate-limited. Retrying after its waiting period; no percentage is available yet.");
      }
    }
  }
  if (pressure?.source.includes("MET Norway")) {
    warnings.push("Using MET Norway’s ECMWF backup pressure forecast. Only windows with complete hourly coverage are ranked; later six-hour data are not filled in.");
  }
  let coverage = null as Forecast["pressureCoverage"];
  if (pressure) {
    coverage = pressureCoverage(pressure, now);
    if (coverage.stale) {
      warnings.push("Pressure provider update failed. Showing the last successful forecast with its original retrieval time; it may be out of date.");
    }
    if (!coverage.complete) {
      warnings.push(`Seven-day pressure coverage incomplete: ${coverage.availableHours} of 168 upcoming hourly readings available. Missing hours are not invented.`);
    }
  }

  const series: PressurePoint[] = (hourly?.time ?? []).flatMap((time, index) =>
    pressureValid(hourly?.pressure_msl?.[index]) ? [{ time, pressure: hourly!.pressure_msl[index] as number }] : [],
  );

  warnings.push(EXPERIMENTAL_RULE);

  const windows: TideWindow[] = windowsBase
    .filter((window) => Date.parse(window.time) > now)
    .map((window) => {
      const context = pressureSession(series, Date.parse(window.time) / 1000, 3, 3);
      return { ...window, pressureContext: context, score: scoreWindow(context) };
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const best =
    windows
      .filter((window) => window.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Date.parse(a.time) - Date.parse(b.time))[0] ?? null;
  const score = best?.score ?? null;

  const network = stationResult.status === "fulfilled" ? stationResult.value : null;
  const selected = network?.selected ?? null;
  if (network && !network.directoryComplete) {
    warnings.push("BOM statewide station discovery unavailable. Checking a limited fallback station list; coverage is incomplete.");
  }
  if (!selected) warnings.push("No fresh pressure observation within 120 km. Future scores use model forecasts only.");
  warnings.push(
    site.method === "official-offset"
      ? `${site.name} estimated tides: Transport for NSW 2026–2027 corrections from Fort Denison, +${site.highMinutes} min high water and +${site.lowMinutes} min low water. These are approximate tide-level turns, not measured tides or slack current. Local heights and other river reaches are not calibrated.`
      : `Reference-port prediction at ${site.referenceName} only. Other spots within this estuary need their own local prediction or verified correction; local slack water may differ.`,
  );
  if (windows.some((window) => window.score === null)) {
    warnings.push("Some turns lack complete pressure coverage across the full session and have no score.");
  }

  return {
    river: river.name,
    rivers: ESTUARIES.map((estuary) => estuary.name),
    station: selected ? { name: selected.candidate.name, distanceKm: Math.round(selected.candidate.distanceKm) } : null,
    weather: selected?.weather ?? null,
    tideSite: site,
    windows,
    bestWindow: best,
    score,
    verdict: score === null ? "Waiting for data" : score >= 82 ? "Promising conditions" : score >= 68 ? "Worth a look" : "Weaker conditions",
    generatedAt: new Date().toISOString(),
    warnings,
    forecastSource: pressure?.source ?? "Pressure forecast unavailable",
    pressureFetchedAt: pressure?.fetchedAt ?? null,
    pressureCoverage: coverage,
    pressureSeries: pressure ? forecastSeries(pressure, now) : [],
    comparison: pressure?.comparison ?? null,
    stationNetwork: network
      ? {
          source: network.source,
          checkedAt: network.checkedAt,
          radiusKm: network.radiusKm,
          directoryComplete: network.directoryComplete,
          stations: network.stations,
          note: network.note,
        }
      : null,
    experimental: true,
  };
}
