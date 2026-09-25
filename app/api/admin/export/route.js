import { isAuthorized } from "@/lib/adminAuth";
import { isConfigured, listAudits, findingsFrom } from "@/lib/blobStore";

export const runtime = "nodejs";
export const maxDuration = 60;

// Machine-facing export: used by the admin page's own tables, by Claude
// fetching on Edu's behalf when asked to refresh the Google Sheet, and —
// as plain CSV — directly by a Google Sheets =IMPORTDATA(...) formula
// (see README's "Admin page and reporting" section for the exact formula
// text). That last use is *why* auth here also accepts a plain `?key=`
// query param: Sheets' IMPORTDATA can't send a cookie or an Authorization
// header, only fetch a URL.

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n");
}

const AUDIT_COLUMNS = [
  "syncedAt", "id", "type", "typeLabel", "school", "unit",
  "ward", "village", "subVillage", "assetTag", "assetType", "location",
  "inspector", "date", "gpsLat", "gpsLon",
  "answeredCount", "totalCount", "issueCount", "comment", "sitePhoto",
];
const FINDING_COLUMNS = [
  "syncedAt", "auditId", "school", "unit",
  "ward", "village", "subVillage", "assetTag",
  "section", "group", "statement", "note", "photoFilenames","photoUrls",
];

export async function GET(request) {
  if (!isAuthorized(request)) {
    return new Response("Not authorized.", { status: 401 });
  }
  if (!isConfigured()) {
    return new Response("Blob storage isn't set up yet (missing BLOB_READ_WRITE_TOKEN).", { status: 503 });
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "audits" ? "audits" : "findings";
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

  const audits = await listAudits();

  if (tab === "audits") {
    const rows = audits.map((a) => ({
      ...a,
      gpsLat: a.gps ? a.gps.lat : "",
      gpsLon: a.gps ? a.gps.lon : "",
    }));
    if (format === "csv") {
      return new Response(toCsv(rows, AUDIT_COLUMNS), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
    }
    return Response.json({ ok: true, audits: rows });
  }

  const findings = findingsFrom(audits);
  if (format === "csv") {
    return new Response(toCsv(findings, FINDING_COLUMNS), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
  }
  return Response.json({ ok: true, findings });
}
