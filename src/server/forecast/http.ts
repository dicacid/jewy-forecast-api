/**
 * Upstream HTTP helpers.
 *
 * The Bureau of Meteorology refuses non-browser clients with a 403 scrape notice, so
 * requests carry a desktop browser identity and the referrer of the public page the
 * data belongs to. Nothing here impersonates a logged-in session or bypasses a quota:
 * each provider keeps its own cache, back-off and rate-limit wait.
 */

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BOM_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.bom.gov.au/australia/tides/",
};

export class UpstreamError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export async function fetchText(
  url: string,
  options: { headers?: Record<string, string>; timeout?: number } = {},
): Promise<string> {
  const response = await fetch(url, {
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeout ?? 12000),
  });
  if (!response.ok) {
    throw new UpstreamError(`Data provider unavailable (${response.status})`, response.status);
  }
  return response.text();
}

export async function fetchJson<T>(
  url: string,
  options: { headers?: Record<string, string>; timeout?: number } = {},
): Promise<{ data: T; headers: Headers; status: number }> {
  const response = await fetch(url, {
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeout ?? 12000),
  });
  if (!response.ok) {
    throw new UpstreamError(`Data provider unavailable (${response.status})`, response.status);
  }
  const data = (await response.json()) as T;
  return { data, headers: response.headers, status: response.status };
}

/** Parse a Retry-After header (seconds or HTTP date) into a wait in milliseconds. */
export function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? at - Date.now() : 0;
}
