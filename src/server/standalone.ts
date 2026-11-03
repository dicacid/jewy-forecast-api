/**
 * Standalone forecast API.
 *
 * The mobile app only ever needs one public read-only endpoint, so this server carries the
 * forecast pipeline without the starter's auth, database or tRPC stack. It is what the
 * permanent deployment runs, and it can be started locally with:
 *
 *   npx esbuild server/standalone.ts --bundle --platform=node --format=esm --outfile=dist/api.mjs
 *   PORT=3100 node dist/jewy-api.mjs
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ESTUARIES } from "../shared/estuaries";
import { forecastResponse } from "./forecast/respond";

const PORT = Number(process.env.PORT ?? 3100);
const STARTED = new Date().toISOString();

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": "600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, JSON.stringify({ error: "Only GET is supported." }));
    return;
  }

  if (url.pathname === "/api/health" || url.pathname === "/health") {
    send(res, 200, JSON.stringify({ ok: true, startedAt: STARTED, estuaries: ESTUARIES.length }));
    return;
  }

  if (url.pathname === "/api/forecast") {
    const river = url.searchParams.get("river")?.trim() || "Karuah River";
    const refresh = url.searchParams.get("refresh") === "1";
    const result = await forecastResponse(river, refresh);
    send(res, result.status, result.body);
    return;
  }

  if (url.pathname === "/") {
    send(
      res,
      200,
      JSON.stringify(
        {
          service: "JEWY forecast API",
          experimental: true,
          endpoints: ["/api/health", "/api/forecast?river=<name>&refresh=1"],
          estuaries: ESTUARIES.map((estuary) => estuary.name),
          sources: [
            "Bureau of Meteorology tide tables and station observations",
            "Open-Meteo (ECMWF IFS, NOAA GFS)",
            "MET Norway Locationforecast (backup)",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }

  send(res, 404, JSON.stringify({ error: "Not found." }));
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("Unhandled request failure:", error);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: "Unexpected server error." }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`JEWY forecast API listening on ${PORT} (${ESTUARIES.length} estuaries)`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
