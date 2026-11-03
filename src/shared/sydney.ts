/**
 * Australia/Sydney time helpers without Intl time-zone data.
 *
 * Hermes ships without full ICU zone data, and the server runs with full ICU. Both
 * sides use this single implementation so day grouping and labels cannot drift.
 * NSW daylight saving starts the first Sunday of October at 02:00 standard time and
 * ends the first Sunday of April at 03:00 daylight time; both boundaries are
 * 16:00 UTC on the preceding Saturday.
 */

const HOUR = 3600000;
const DAY = 86400000;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function firstSundayUtc(year: number, monthIndex: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = first.getUTCDay();
  return Date.UTC(year, monthIndex, 1 + ((7 - offset) % 7), 16, 0, 0);
}

function isDaylightSaving(instant: number): boolean {
  const year = new Date(instant).getUTCFullYear();
  // A daylight-saving window runs from October of one year to April of the next,
  // so test the neighbouring candidate years as well.
  for (const candidate of [year - 1, year, year + 1]) {
    const start = firstSundayUtc(candidate, 9);
    const end = firstSundayUtc(candidate + 1, 3);
    if (instant >= start && instant < end) return true;
  }
  return false;
}

export function sydneyOffsetMs(instant: number): number {
  return isDaylightSaving(instant) ? 11 * HOUR : 10 * HOUR;
}

export type SydneyParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

export function sydneyParts(instant: number): SydneyParts {
  const shifted = new Date(instant + sydneyOffsetMs(instant));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local calendar day key, e.g. `2026-11-04`. */
export function dayKey(instant: number | string): string {
  const value = typeof instant === "string" ? Date.parse(instant) : instant;
  if (!Number.isFinite(value)) return "";
  const parts = sydneyParts(value);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** UTC instant of local midnight for a day key. */
export function dayStartUtc(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = guess - sydneyOffsetMs(guess);
  // Re-evaluate once: midnight can sit on either side of a DST boundary.
  instant = guess - sydneyOffsetMs(instant);
  return instant;
}

export function addDays(key: string, days: number): string {
  return dayKey(dayStartUtc(key) + days * DAY);
}

export function dayKeysFrom(instant: number, count: number): string[] {
  const start = dayKey(instant);
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

/** `6:26 am` */
export function clockLabel(instant: number | string): string {
  const value = typeof instant === "string" ? Date.parse(instant) : instant;
  if (!Number.isFinite(value)) return "—";
  const { hour, minute } = sydneyParts(value);
  const suffix = hour < 12 ? "am" : "pm";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${pad(minute)} ${suffix}`;
}

/** `Tue 4 Nov` */
export function dayShort(key: string): string {
  const parts = sydneyParts(dayStartUtc(key) + 12 * HOUR);
  return `${WEEKDAYS_SHORT[parts.weekday]} ${parts.day} ${MONTHS_SHORT[parts.month - 1]}`;
}

/** `Tuesday, 4 Nov` */
export function dayLong(key: string): string {
  const parts = sydneyParts(dayStartUtc(key) + 12 * HOUR);
  return `${WEEKDAYS_LONG[parts.weekday]}, ${parts.day} ${MONTHS_SHORT[parts.month - 1]}`;
}

/** `Tue 4 Nov, 6:26 am` */
export function stampLabel(instant: number | string): string {
  const value = typeof instant === "string" ? Date.parse(instant) : instant;
  if (!Number.isFinite(value)) return "an unavailable time";
  return `${dayShort(dayKey(value))}, ${clockLabel(value)}`;
}

/** Minutes since local midnight, used to place tide turns on the day chart. */
export function minutesIntoDay(instant: number): number {
  const { hour, minute } = sydneyParts(instant);
  return hour * 60 + minute;
}

export function hoursAgoLabel(instant: number | string, now = Date.now()): string {
  const value = typeof instant === "string" ? Date.parse(instant) : instant;
  if (!Number.isFinite(value)) return "";
  const minutes = Math.max(0, Math.round((now - value) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}
