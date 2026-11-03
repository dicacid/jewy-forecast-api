import { buildForecast, ForecastError } from "./build";

export type ForecastResult = { status: number; body: string };

/**
 * One cached, coalesced forecast response per estuary, shared by every transport
 * (the in-app Express server and the standalone deployment).
 *
 * Five minutes of cache when a score could be produced, one minute when it could not.
 */
const cache = new Map<string, { expires: number; body: string; status: number }>();
const inflight = new Map<string, Promise<ForecastResult>>();

export function forecastResponse(river: string, refresh = false): Promise<ForecastResult> {
  const cached = cache.get(river);
  if (!refresh && cached && cached.expires > Date.now()) {
    return Promise.resolve({ body: cached.body, status: cached.status });
  }

  const underway = inflight.get(river);
  if (underway) return underway;

  const work = (async (): Promise<ForecastResult> => {
    try {
      const forecast = await buildForecast(river, refresh);
      const body = JSON.stringify(forecast);
      if (cache.size >= 24) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(river, {
        body,
        status: 200,
        expires: Date.now() + (forecast.score === null ? 60000 : 300000),
      });
      return { body, status: 200 };
    } catch (error) {
      const status = error instanceof ForecastError ? error.status : 503;
      const message =
        error instanceof ForecastError ? error.message : "Forecast temporarily unavailable. Please try again.";
      if (!(error instanceof ForecastError)) console.warn("Forecast build failed:", String(error));
      return { body: JSON.stringify({ error: message }), status };
    }
  })();

  inflight.set(river, work);
  work.finally(() => inflight.delete(river));
  return work;
}
