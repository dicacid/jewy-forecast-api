# JEWY forecast API

The read-only forecast pipeline behind the **JEWY — Estuary Conditions** mobile app, packaged as a
standalone service so the app never depends on a development machine.

This repository is generated from the app project: `src/server/forecast/` and `src/shared/` are
copies of the app's own pipeline, and `src/server/standalone.ts` serves them over plain
`node:http` without the app's auth, database or RPC stack. Re-sync with
`scripts/sync-api-repo.mjs` in the app project rather than editing the copies by hand.

## Live service

<https://jewy-forecast-api.onrender.com> — a Render web service in Singapore on the free plan.
Free instances sleep after about fifteen minutes without traffic, so the first request of the day
can take 30–50 seconds while the instance wakes.

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness plus the supported estuary count |
| `GET /api/forecast?river=Karuah%20River` | The full forecast payload for one estuary |
| `GET /api/forecast?river=...&refresh=1` | Re-checks upstreams (caches and rate-limit waits still apply) |
| `GET /` | Service description and the estuary list |

Responses are cached per estuary for five minutes (one minute when no score could be produced) and
concurrent requests for the same estuary are coalesced. CORS is open: the payload is public,
read-only, contains no cookies and no per-user content.

## Run locally

```sh
npm install
npm run build
PORT=3100 npm start
curl "http://127.0.0.1:3100/api/forecast?river=Karuah%20River"
```

## What it does not do

The percentages are an experimental conditions match against a pressure rule. They are not catch
probability, not a fishing forecast and not validated against catches. Turns without complete
hourly pressure coverage are left unranked rather than scored from partial data.

Tide tables and station observations are published by the Bureau of Meteorology; pressure comes
from Open-Meteo (ECMWF IFS, with NOAA GFS as a labelled cross-check) and MET Norway
(CC BY 4.0) as a backup. Personal, non-commercial pilot.
