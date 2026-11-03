// School findings in the layout of Karimu's official schools incidents
// sheet ("Incidents - Schools", tab "Current Incidents") — added
// 2026-11-03, the school counterpart of lib/incidents.js. Served by
// /api/admin/export?tab=school_incidents and written into the
// "Incidents" tab of the schools' parallel sheet by the Apps Script in
// apps-script/SchoolIncidents.gs, so Emanuel Matika can copy rows from
// there straight into the official sheet.
//
// Columns A-AB are the official header row (row 3), character for
// character — "picture ot issue resolved" and the two "Notes" columns
// included. In the official sheet, C (Year), Y and Z are per-row formulas
// and AB is one array formula in the header; the Apps Script writes the
// same per-row formulas, and AB stays empty so it doesn't block the
// official array formula. Ward, School and Type match the official
// spelling (see SCHOOL_LIST), because the Dashboard summary tab counts
// incidents by Year + School + Type.
import { findSchool, BATHROOM_UNITS } from "@/lib/checklists";

export const SCHOOL_INCIDENT_COLUMNS = [
  "#", "Date", "Year", "Ward", "School", "Type", "Item \n(e.g door,window)", "Description of issue",
  "Issue identified by", "Picture", "KAHESO REP witnessed", "Name of person notified",
  "Date when issue was notified", "Notes", "Date when was resolved", "KAHESO witness", "Resolved by",
  "Description of resolution", "picture ot issue resolved", "Notes", "Validation date",
  "Name of person who validated", "Name of Karimu Person who verified", "Date of verification",
  "Avg days to fix", "Avg day issue open", "", "Data complete",
];

// The official "Item" column says where in the school the problem is
// ("Boys' toilet", "Kiboko block room 2", "Kitchen"); the checklist item
// itself goes in the description.
const BATHROOM_ITEMS = {
  girls: "Girls' bathroom", female_teachers: "Female teachers' bathroom", girls_hostel: "Girls' hostel bathroom",
  boys: "Boys' bathroom", male_teachers: "Male teachers' bathroom", boys_hostel: "Boys' hostel bathroom",
  handwashing: "Handwashing sink",
};
function schoolItem(audit, item) {
  // Farm, garden and trees are school-level, not about the building.
  if (item.section === "School farm, garden and trees") return item.group;
  if (audit.type === "school_bathroom") {
    const unit = BATHROOM_UNITS.find((u) => u.label === audit.unit);
    return (unit && BATHROOM_ITEMS[unit.id]) || audit.unit || "";
  }
  return audit.unit || "";
}

/** One row per issue across all synced school audits, oldest first, as
 * {ref, auditId, syncedAt, date, description, photoUrls, photoFilenames,
 * values} — `values` lines up with SCHOOL_INCIDENT_COLUMNS. Same shape as
 * incidentsFrom() in lib/incidents.js; `ref` (audit id + the item's
 * position in its checklist) is stable across re-syncs. */
export function schoolIncidentsFrom(audits) {
  const rows = [];
  const sorted = audits
    .filter((a) => a.type === "school_building" || a.type === "school_bathroom")
    .slice()
    .sort((a, b) => (a.syncedAt || "").localeCompare(b.syncedAt || ""));
  for (const a of sorted) {
    const school = findSchool(a.school);
    (a.checklist || []).forEach((item, i) => {
      if (item.value !== "issue") return;
      const photos = item.photos || [];
      const description = (item.note || "").trim() || `${item.group}: ${item.statement}`;
      const notes = [
        `Checklist: ${item.section} > ${item.group} - ${item.statement}`,
        a.gps ? `GPS ${Number(a.gps.lat).toFixed(6)}, ${Number(a.gps.lon).toFixed(6)}` : "",
        `Karimu audit app, ${a.inspector || "?"}, audit ${a.id}`,
      ].filter(Boolean).join(" · ");

      const v = new Array(SCHOOL_INCIDENT_COLUMNS.length).fill("");
      v[1] = a.date || "";
      v[3] = school ? school.ward : "";
      v[4] = school ? school.name : a.school || "";
      v[5] = school ? school.level : "";
      v[6] = schoolItem(a, item);
      v[7] = description;
      v[8] = "Karimu";
      v[9] = photos.map((p) => p.url).join("\n");
      v[13] = notes;

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
