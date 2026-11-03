/**
 * The eleven pilot NSW estuaries. Coordinates are the pilot's sampling points; the
 * tide reference is resolved on the server so a locality correction never gets
 * applied to a whole river.
 */
export type Estuary = {
  name: string;
  label: string;
  lat: number;
  lon: number;
};

export const ESTUARIES: Estuary[] = [
  { name: "Karuah River", label: "Karuah River", lat: -32.66, lon: 151.96 },
  { name: "Hawkesbury River", label: "Hawkesbury River", lat: -33.55, lon: 151.22 },
  { name: "Parramatta River", label: "Parramatta River", lat: -33.82, lon: 151.05 },
  { name: "Georges River", label: "Georges River", lat: -33.98, lon: 151.02 },
  { name: "Hunter River", label: "Hunter River — Newcastle", lat: -32.92, lon: 151.78 },
  { name: "Hunter River - Hexham", label: "Hunter River — Hexham", lat: -32.81767, lon: 151.68144 },
  {
    name: "Hunter River - Raymond Terrace",
    label: "Hunter River — Raymond Terrace",
    lat: -32.75338,
    lon: 151.74418,
  },
  { name: "Hunter River - Morpeth", label: "Hunter River — Morpeth", lat: -32.72396, lon: 151.6297 },
  { name: "Shoalhaven River", label: "Shoalhaven River", lat: -34.88, lon: 150.6 },
  { name: "Clarence River", label: "Clarence River", lat: -29.43, lon: 153.35 },
  { name: "Richmond River", label: "Richmond River", lat: -28.87, lon: 153.57 },
];

export const DEFAULT_ESTUARY = "Karuah River";

export function estuaryLabel(name: string): string {
  return ESTUARIES.find((estuary) => estuary.name === name)?.label ?? name;
}

/** Great-circle distance in kilometres, matching the pilot's haversine helper. */
export function distanceKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const radians = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * radians) / 2) ** 2 +
    Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin(((bLon - aLon) * radians) / 2) ** 2;
  return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Nearest supported estuary within `limitKm`, or null. GPS never verifies the waterway. */
export function nearestEstuary(lat: number, lon: number, limitKm = 75) {
  const ranked = ESTUARIES.map((estuary) => ({
    estuary,
    km: distanceKm(lat, lon, estuary.lat, estuary.lon),
  })).sort((a, b) => a.km - b.km);
  const nearest = ranked[0];
  return nearest && nearest.km <= limitKm ? nearest : null;
}
