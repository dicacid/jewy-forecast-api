import { ESTUARIES, type Estuary } from "../../shared/estuaries";
import type { TideSite } from "../../shared/forecast";

/**
 * A tide correction belongs to a named locality, never to an entire river. The
 * pilot's Transport for NSW 2026–2027 corrections are timed offsets from Fort
 * Denison, so no local heights exist for those localities.
 */
type TideLocation = TideSite;

const TIDE_TABLE_SOURCE =
  "https://www.nsw.gov.au/sites/default/files/noindex/2026-04/tide-tables-2026-2027-for-nsw.pdf";
const BOM_TIDE_SOURCE = "https://www.bom.gov.au/australia/tides/";

const karuah: TideLocation = {
  id: "karuah-town",
  name: "Karuah (Karuah River)",
  referenceId: "NSW_TP007",
  referenceName: "Sydney (Fort Denison)",
  method: "official-offset",
  highMinutes: 75,
  lowMinutes: 45,
  sourceUrl: TIDE_TABLE_SOURCE,
  validThrough: "2027-06-30",
};

const hunter: Record<string, TideLocation> = {
  "Hunter River - Hexham": { ...karuah, id: "hunter-hexham", name: "Hexham (Hunter River)", highMinutes: 70, lowMinutes: 60 },
  "Hunter River - Raymond Terrace": {
    ...karuah,
    id: "hunter-raymond-terrace",
    name: "Raymond Terrace (Hunter River)",
    highMinutes: 110,
    lowMinutes: 115,
  },
  "Hunter River - Morpeth": { ...karuah, id: "hunter-morpeth", name: "Morpeth (Hunter River)", highMinutes: 190, lowMinutes: 210 },
};

const referencePorts: Record<string, { tideId: string; tideName: string }> = {
  "Hawkesbury River": { tideId: "NSW_TP034", tideName: "Dangar Island" },
  "Parramatta River": { tideId: "NSW_TP007", tideName: "Sydney (Fort Denison)" },
  "Georges River": { tideId: "NSW_TP001", tideName: "Botany Bay" },
  "Hunter River": { tideId: "NSW_TP004", tideName: "Newcastle" },
  "Shoalhaven River": { tideId: "NSW_TP027", tideName: "Crookhaven Heads" },
  "Clarence River": { tideId: "NSW_TP008", tideName: "Yamba" },
  "Richmond River": { tideId: "NSW_TP009", tideName: "Ballina" },
};

export function findEstuary(name: string | null | undefined): Estuary | null {
  return ESTUARIES.find((estuary) => estuary.name === name) ?? null;
}

export function tideSiteFor(estuary: Estuary): TideLocation {
  if (estuary.name === "Karuah River") return karuah;
  const hunterSite = hunter[estuary.name];
  if (hunterSite) return hunterSite;
  const port = referencePorts[estuary.name] ?? {
    tideId: "NSW_TP007",
    tideName: "Sydney (Fort Denison)",
  };
  return {
    id: port.tideId,
    name: port.tideName,
    referenceId: port.tideId,
    referenceName: port.tideName,
    method: "reference-port",
    highMinutes: 0,
    lowMinutes: 0,
    sourceUrl: BOM_TIDE_SOURCE,
  };
}
