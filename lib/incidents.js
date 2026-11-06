// Findings in the layout of Karimu's official incidents sheet
// ("Incidents - Water Project", tab "Current Incidents") — added
// 2026-11-03 so Emanuel Matika can copy rows from our parallel sheet
// straight into the official one, which the village and the Water
// Committee work from. Served by /api/admin/export?tab=incidents and
// written into the "Incidents" tab of the parallel sheet by the Apps
// Script in apps-script/Incidents.gs (which also swaps the photo links
// for Google Drive copies and translates the description to English).
//
// Columns A-AI are the official header row, character for character
// (trailing spaces included). In the official sheet, D-J (Asset Type ...
// Type) are lookups from the Asset tag, and AD, AE, AG and AH are per-row
// formulas; AI is one array formula in the header. Here D-J carry the
// same values from our copy of the Water Assets register, and the Apps
// Script writes the official AD/AE/AG/AH formulas into each row, so a
// pasted row behaves like one typed in by hand. AI stays empty: a value
// there would block the official sheet's array formula.
//
// Two stages, as Emanuel Matika asked on 2026-11-06: an inspection fills
// A-R and V (the issue's picture); a later validation visit (an audit of
// type "validation", see the app's "Validate fixes" screens) fills S-AC
// except V, merged into the same row by its ref. W (Notes) belongs to the
// validation, so the app's own bookkeeping goes in `appNotes` instead.
// Also imported by the field app (lib/engine.js), hence the relative path.
import { findAsset, STRUCTURE_LABELS } from "./waterAssets";

export const INCIDENT_COLUMNS = [
  "#", "Date", "Asset tag", "Asset Type", "Ward", "Village", "Sub-Village", "Location (Place)",
  "Ownership", "Type", "Item \n(e.g., valve chamber)", "Description of issue", "Issue identified by",
  "KAHESO REP witnessed issue", "SUB-VILLAGE REP. witnessed", "Date when issue was notified",
  "Planned Resolution", "Resolution to be done by", "Date when was resolved",
  "Sub-village Rep witnessed  ", "KAHESO REP witnessed ", "Picture of the Issue", "Notes",
  "Description of resolution", "Picture of issue resolved", "Validation date",
  "Name of person who validated", "Name of Karimu Person who verified", "Date of verification",
  "Opening to resolution", "Resolution to verification", "", "Year", "Days issue open", "Data complete",
];
const COL = Object.fromEntries(INCIDENT_COLUMNS.map((c, i) => [c, i]));

// The official sheet's "Item" vocabulary (Current Incidents uses Fence,
// DP, Faucet, Leach Hole, Valve Chamber, Tank, Pipe, Plaque; "DP" is the
// water point itself). Our checklist groups map onto it like this;
// anything not listed keeps its own group name.
const WATER_POINT_ITEMS = {
  "Water Point": "DP", "Ground around": "DP", "Concrete Column": "DP", "Bucket Support Base": "DP",
  "Drain": "DP", "Surrounding Walls": "DP", "Leach Hole": "Leach Hole", "Valve Chamber": "Valve Chamber",
  "Mainline Pipe": "Pipe", "Faucets": "Faucet", "Asset Tag": "Asset Tag", "Plaque": "Plaque", "Fence": "Fence",
};
const TANK_ITEMS = {
  "Foundations": "Tank", "Walls": "Tank", "Roof": "Tank", "Inside": "Tank", "Terrain": "Tank",
  "Source Pipes (from river to tank)": "Pipe", "Distributions Pipes (from tank to Gajal, Dareda, Haysam tank)": "Pipe",
  "Cleaning Pipes": "Pipe", "Overflow Pipes": "Pipe",
  "Source Valve Chambers": "Valve Chamber", "Distribution Valve Chambers": "Valve Chamber",
  "Cleaning Valve Chambers": "Valve Chamber", "Fencing": "Fence", "Asset Tag": "Asset Tag", "Karimu Plaque": "Plaque",
};
export function incidentItem(audit, group) {
  if (audit.type === "pipeline") return "Pipe";
  // "Water Tank" in synced records, "T" on the device (see auditRecord()).
  const isTank = audit.assetType === "Water Tank" || audit.assetType === "T";
  return (isTank ? TANK_ITEMS : WATER_POINT_ITEMS)[group] || group;
}

// "Issue identified by" and "Resolution to be done by", with the official
// sheet's spelling. Who fixes it follows how they're filled in by hand: the
// Water Committee for the network itself (valves, pipes, tanks), the
// community around the water point for the rest. Staff can change both per
// issue in the app; volunteers' audits get these defaults.
export const IDENTIFIED_BY = ["Karimu", "Both", "Water Committee"];
export const RESOLVE_BY = ["Community Around", "WC"];
const WC_ITEMS = new Set(["Valve Chamber", "Pipe", "Tank"]);
export function defaultResolveBy(audit, group) {
  return WC_ITEMS.has(incidentItem(audit, group)) ? "WC" : "Community Around";
}

// What a validation visit can find, per issue. "notyet" leaves the issue
// open (nothing is written to the sheet) so it comes back on the next visit.
export const VALIDATION_STATUSES = ["fixed", "refused", "notyet"];
export const closesIncident = (v) => !!v && (v.status === "fixed" || v.status === "refused");

/** "Emanuel Matika" -> "Emanuel", the way names are written in the sheet. */
export function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

/** yyyy-mm-dd one calendar month later (Jan 31 -> Feb 28): the planned
 * resolution date, as it's filled in by hand. */
export function plusOneMonth(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

/** The latest validation that closed each incident, by incident ref:
 * {...the validation's answer, visit: the validation audit}. */
function closingValidations(audits) {
  const byRef = {};
  audits
    .filter((a) => a.type === "validation")
    .sort((a, b) => (a.syncedAt || "").localeCompare(b.syncedAt || ""))
    .forEach((visit) => (visit.validations || []).forEach((v) => {
      if (closesIncident(v)) byRef[v.ref] = { ...v, visit };
    }));
  return byRef;
}

/** One row per issue across all synced water audits, oldest first, as
 * {ref, auditId, syncedAt, date, description, photoUrls, photoFilenames,
 * appNotes, assetTag, ward, village, subVillage, item, validation,
 * values} — `values` lines up with INCIDENT_COLUMNS. `ref` (audit id +
 * the item's position in its checklist) is stable across re-syncs, so the
 * Apps Script can tell which rows it has already written. `validation` is
 * null until a validation visit closes the issue, then {auditId, syncedAt,
 * photoUrls, photoFilenames} and S-AC are filled in. */
export function incidentsFrom(audits) {
  const validated = closingValidations(audits);
  const rows = [];
  const sorted = audits
    .filter((a) => a.type === "water_point" || a.type === "pipeline")
    .slice()
    .sort((a, b) => (a.syncedAt || "").localeCompare(b.syncedAt || ""));
  for (const a of sorted) {
    const asset = findAsset(a.assetTag);
    const isTank = a.assetType === "Water Tank";
    (a.checklist || []).forEach((item, i) => {
      if (item.value !== "issue") return;
      const photos = item.photos || [];
      const description = (item.note || "").trim() || `${item.group}: ${item.statement}`;
      const appNotes = [
        a.type === "pipeline" ? `Pipeline problem near ${a.assetTag}` : `Checklist: ${item.group} - ${item.statement}`,
        a.gps ? `GPS ${Number(a.gps.lat).toFixed(6)}, ${Number(a.gps.lon).toFixed(6)}` : "",
        `Karimu audit app, ${a.inspector || "?"}, audit ${a.id}`,
      ].filter(Boolean).join(" · ");

      const v = new Array(INCIDENT_COLUMNS.length).fill("");
      v[COL["Date"]] = a.date || "";
      v[COL["Asset tag"]] = a.assetTag || "";
      v[COL["Asset Type"]] = a.assetType || "";
      v[COL["Ward"]] = a.ward || "";
      v[COL["Village"]] = a.village || "";
      v[COL["Sub-Village"]] = a.subVillage || (asset && asset.sub) || "";
      v[COL["Location (Place)"]] = (asset && asset.loc) || a.location || "";
      v[COL["Ownership"]] = asset ? (asset.public ? "Public" : "Private") : "";
      v[COL["Type"]] = isTank ? "N/A" : (asset && STRUCTURE_LABELS[asset.structure]) || "";
      v[COL["Item \n(e.g., valve chamber)"]] = incidentItem(a, item.group);
      v[COL["Description of issue"]] = description;
      v[COL["Issue identified by"]] = item.identifiedBy || "Karimu";
      v[COL["KAHESO REP witnessed issue"]] = firstName(a.inspector);
      v[COL["SUB-VILLAGE REP. witnessed"]] = a.subVillageRep || "";
      v[COL["Date when issue was notified"]] = a.date || "";
      v[COL["Planned Resolution"]] = plusOneMonth(a.date);
      v[COL["Resolution to be done by"]] = item.resolveBy || defaultResolveBy(a, item.group);
      v[COL["Picture of the Issue"]] = photos.map((p) => p.url).join("\n");

      const ref = `${a.id}#${i}`;
      const val = validated[ref];
      if (val) {
        const visit = val.visit;
        v[COL["Date when was resolved"]] = val.resolvedDate || visit.date || "";
        v[COL["Sub-village Rep witnessed  "]] = visit.subVillageRep || "";
        v[COL["KAHESO REP witnessed "]] = visit.kahesoRep || "";
        v[COL["Notes"]] = (val.note || "").trim();
        v[COL["Description of resolution"]] = (val.resolution || "").trim() || (val.status === "refused" ? "Refusal to Fix Issues" : "");
        v[COL["Picture of issue resolved"]] = (val.photos || []).map((p) => p.url).join("\n");
        v[COL["Validation date"]] = visit.date || "";
        v[COL["Name of person who validated"]] = visit.validatedBy || "";
        v[COL["Name of Karimu Person who verified"]] = visit.verifiedBy || "";
        v[COL["Date of verification"]] = visit.verifiedDate || "";
      }

      rows.push({
        ref, auditId: a.id, syncedAt: a.syncedAt || "", date: a.date || "",
        description, appNotes,
        photoUrls: photos.map((p) => p.url), photoFilenames: photos.map((p) => p.filename),
        assetTag: a.assetTag || "", ward: a.ward || "", village: a.village || "", subVillage: a.subVillage || "",
        item: v[COL["Item \n(e.g., valve chamber)"]],
        validation: val ? {
          auditId: val.visit.id, syncedAt: val.visit.syncedAt || "",
          photoUrls: (val.photos || []).map((p) => p.url), photoFilenames: (val.photos || []).map((p) => p.filename),
        } : null,
        values: v,
      });
    });
  }
  return rows;
}

/** The issues still waiting for a validation visit, for the app's
 * "Validate fixes" list — small on purpose, the phone keeps a copy for
 * working offline. */
export function openIncidents(audits) {
  return incidentsFrom(audits).filter((r) => !r.validation).map((r) => ({
    ref: r.ref, assetTag: r.assetTag, ward: r.ward, village: r.village, subVillage: r.subVillage,
    item: r.item, description: r.description, date: r.date, photoUrl: r.photoUrls[0] || "",
  }));
}
