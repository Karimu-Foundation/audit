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
import { findAsset, STRUCTURE_LABELS } from "@/lib/waterAssets";

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
  const map = audit.assetType === "Water Tank" ? TANK_ITEMS : WATER_POINT_ITEMS;
  return map[group] || group;
}

/** One row per issue across all synced water audits, oldest first, as
 * {ref, auditId, syncedAt, date, description, photoUrls, photoFilenames,
 * values} — `values` lines up with INCIDENT_COLUMNS. `ref` (audit id +
 * the item's position in its checklist) is stable across re-syncs, so the
 * Apps Script can tell which rows it has already written. */
export function incidentsFrom(audits) {
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
      const notes = [
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
      v[COL["Issue identified by"]] = "Karimu";
      v[COL["Picture of the Issue"]] = photos.map((p) => p.url).join("\n");
      v[COL["Notes"]] = notes;

      rows.push({
        ref: `${a.id}#${i}`, auditId: a.id, syncedAt: a.syncedAt || "", date: a.date || "",
        description,
        photoUrls: photos.map((p) => p.url), photoFilenames: photos.map((p) => p.filename),
        values: v,
      });
    });
  }
  return rows;
}
