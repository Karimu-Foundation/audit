// Synced-audit storage using Vercel Blob — the backend for "Sync" once an
// audit is complete, and the data source the admin page (and the daily
// Drive-photo routine) reads from.
//
// Why Blob and not Google Sheets/Drive directly: writing straight into
// Sheets/Drive from this server needs a Google Cloud service account
// (project, enabled APIs, a JSON key, sharing the target files with it) —
// real IT setup that isn't happening for this project (2026-08-26 decision).
// Vercel Blob needs none of that: enable it once in the Vercel dashboard
// (Storage tab → create a Blob store → connect to this project) and
// `BLOB_READ_WRITE_TOKEN` is injected automatically. See README's
// "Admin page and reporting" section for the full setup and for how data
// gets from here into an actual Google Sheet + Drive folder (short answer:
// a human — or Claude, asked in a chat — reads it from here and writes it
// there; nothing on this server talks to Google directly anymore).
//
// Layout:
//   audits/{auditId}.json   — one full audit record (see shape below),
//                              overwritten in place on every re-sync of
//                              the same audit (addRandomSuffix: false), so
//                              syncing twice never creates duplicates.
//   photos/{auditId}/{filename} — one blob per photo, filename chosen so
//                              it's identifiable on its own once copied
//                              into a Google Drive folder later — see
//                              photoFilename() below.
import { put, list, del } from "@vercel/blob";

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

/** Same naming scheme wherever a photo needs to be identified on its own —
 * this exact filename is what a human (or the daily routine) should also
 * use as the filename when copying the photo into Google Drive, so a
 * spreadsheet row and a Drive file can always be matched up by name alone,
 * with no database or live link required in between. */
function photoFilename(auditId, section, group, index) {
  return `${auditId}_${slug(section)}_${slug(group)}_${index + 1}.jpg`;
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const mimeType = meta.split(";")[0] || "image/jpeg";
  const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
  return { buffer, mimeType };
}

/**
 * Save one completed audit. Uploads each photo as its own blob (dropping
 * the base64 payload from the JSON afterward — those add up fast) and
 * writes the audit record itself as one JSON blob, keyed by audit id so
 * re-syncing overwrites cleanly instead of duplicating.
 */
export async function saveAudit(audit) {
  let photosUploaded = 0;
  const checklist = [];
  for (const item of audit.checklist || []) {
    const photos = item.photos || [];
    const uploaded = [];
    for (let i = 0; i < photos.length; i++) {
      const filename = photoFilename(audit.id, item.section, item.group, i);
      const { buffer, mimeType } = dataUrlToBuffer(photos[i]);
      const blob = await put(`photos/${audit.id}/${filename}`, buffer, {
        access: "public",
        contentType: mimeType,
        addRandomSuffix: false,
      });
      uploaded.push({ filename, url: blob.url });
      photosUploaded++;
    }
    checklist.push({ ...item, photos: uploaded });
  }

  const record = { ...audit, checklist, syncedAt: new Date().toISOString() };
  await put(`audits/${audit.id}.json`, JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });

  const issues = checklist.filter((c) => c.value === "issue");
  return { syncedAt: record.syncedAt, findingsWritten: issues.length, photosUploaded };
}

/** Every synced audit, newest first. Each blob is a small JSON file, fetched
 * over plain HTTPS — fine at the scale this project runs at (see README if
 * that ever stops being true). */
export async function listAudits() {
  const audits = [];
  let cursor;
  do {
    const page = await list({ prefix: "audits/", cursor, limit: 1000 });
    for (const b of page.blobs) {
      try {
        const res = await fetch(b.url);
        if (res.ok) audits.push(await res.json());
      } catch {
        // one bad/unreachable blob shouldn't take down the whole list
      }
    }
    cursor = page.cursor;
  } while (cursor);
  audits.sort((a, b) => (b.syncedAt || "").localeCompare(a.syncedAt || ""));
  return audits;
}

/**
 * Delete every synced audit and every photo — the whole "audits/" and
 * "photos/" prefixes, wiped clean. For starting a fresh round of testing
 * (or a fresh mission) without any old test data lingering in the admin
 * page, the Google Sheet export, or the daily Drive-photo routine.
 * There's no undo: once a blob is deleted here it's gone from Blob
 * storage for good (any copy already uploaded to Google Drive by the
 * daily routine is untouched, since that's a separate copy).
 */
export async function deleteAll() {
  let deleted = 0;
  for (const prefix of ["audits/", "photos/"]) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      if (page.blobs.length) {
        await del(page.blobs.map((b) => b.url));
        deleted += page.blobs.length;
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return { deleted };
}

/** Findings ("occurrences"): one row per issue, flattened out of every
 * synced audit, with the exact photo filename(s) a human should look for
 * once they're copied into Drive (see photoFilename() above). */
export function findingsFrom(audits) {
  const rows = [];
  for (const a of audits) {
    for (const item of a.checklist || []) {
      if (item.value !== "issue") continue;
      rows.push({
        syncedAt: a.syncedAt, auditId: a.id,
        school: a.school || "", unit: a.unit || "",
        ward: a.ward || "", village: a.village || "", subVillage: a.subVillage || "", assetTag: a.assetTag || "",
        section: item.section, group: item.group, statement: item.statement, note: item.note || "",
        photoFilenames: (item.photos || []).map((p) => p.filename).join(", "),
        photoUrls: (item.photos || []).map((p) => p.url).join(", "),
      });
    }
  }
  return rows;
}
