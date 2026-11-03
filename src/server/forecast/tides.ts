import type { TideSite, TideWindow } from "../../shared/forecast";
import { dayKey } from "../../shared/sydney";
import { BOM_HEADERS, fetchText } from "./http";
import { parseTideRows, type ParsedTideRow } from "./signals";

/**
 * Reference-port tide turns from the Bureau of Meteorology tide tables, converted to a
 * locality by its published timing correction. The correction supplies time only, so
 * reference-port heights are never relabelled as local heights.
 */

export function tideRequestDates(now: number, site: TideSite): Array<{ date: string; days: string }> {
  const today = dayKey(now);
  const dates = [today];
  // A previous-day reference tide may occur after midnight at the local site.
  if (site.method === "official-offset") {
    dates.push(dayKey(Date.parse(`${today}T12:00:00Z`) - 86400000));
  }
  return dates.map((date, index) => ({ date: date.split("-").reverse().join("-"), days: index === 0 ? "7" : "1" }));
}

export type TideResult = { turns: ParsedTideRow[]; requested: number; failed: number };

export async function fetchTideTurns(site: TideSite, now = Date.now()): Promise<TideResult> {
  const expected = site.referenceName.replace(/&/g, "&amp;");
  const requests = tideRequestDates(now, site).map(async ({ date, days }) => {
    const query = new URLSearchParams({
      type: "tide",
      aac: site.referenceId,
      date,
      days,
      region: "NSW",
      offset: "false",
      offsetName: "",
      tz: "Australia/Sydney",
      tz_js: "AEST",
    });
    const html = await fetchText(`https://www.bom.gov.au/australia/tides/scripts/getTidesTable.php?${query}`, {
      headers: BOM_HEADERS,
    });
    return html.includes(`>${expected}, NSW`) ? parseTideRows(html) : [];
  });
  const settled = await Promise.allSettled(requests);
  const turns: ParsedTideRow[] = [];
  let failed = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") turns.push(...result.value);
    else failed += 1;
  }
  const unique = [...new Map(turns.map((turn) => [`${turn.kind}:${turn.time}`, turn])).values()];
  return { turns: unique, requested: settled.length, failed };
}

export function localTideTurns(turns: ParsedTideRow[], site: TideSite): TideWindow[] {
  return turns
    .flatMap((turn) => {
      if (!["high", "low"].includes(turn.kind) || !Number.isFinite(Date.parse(turn.time))) return [];
      if (site.method === "reference-port") {
        return [{ kind: turn.kind, time: turn.time, height: turn.height, score: null, pressureContext: null } as TideWindow];
      }
      const offset = turn.kind === "high" ? site.highMinutes : site.lowMinutes;
      const time = new Date(Date.parse(turn.time) + offset * 60000).toISOString();
      if (site.validThrough && dayKey(time) > site.validThrough) return [];
      // The official correction supplies time only; do not relabel Sydney heights.
      return [{ kind: turn.kind, time, height: "—", score: null, pressureContext: null } as TideWindow];
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
