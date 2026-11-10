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
import { put, list, del, get } from "@vercel/blob";

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

// A photo that is already an http(s) URL was uploaded by an earlier sync
// of the same audit (the client swaps its base64 copies for these URLs
// once a sync succeeds), so it's kept as it is. Videos are only ever URLs
// here: the phone uploads them itself (see app/api/upload). Decoding such a URL as
// base64 and uploading the result is what overwrote 5 photos from the
// 2026-09 mission with ~90 bytes of junk when their audits were re-sent.
const isUploaded = (photo) => /^https?:\/\//.test(photo);

const keptVideos = (videos) => (videos || [])
  .filter((v) => v && isUploaded(v.url))
  .map((v) => ({ filename: String(v.filename || decodeURIComponent(v.url.split("/").pop())), url: v.url }));

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
  /** One photo -> {filename, url}, uploaded unless it already is a URL. */
  async function store(photo, filename) {
    if (isUploaded(photo)) return { filename: decodeURIComponent(photo.split("/").pop()), url: photo };
    const { buffer, mimeType } = dataUrlToBuffer(photo);
    const blob = await put(`photos/${audit.id}/${filename}`, buffer, {
      access: "public",
      contentType: mimeType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    photosUploaded++;
    return { filename, url: blob.url };
  }

  const checklist = [];
  for (const item of audit.checklist || []) {
    const photos = item.photos || [];
    const uploaded = [];
    for (let i = 0; i < photos.length; i++) {
      uploaded.push(await store(photos[i], photoFilename(audit.id, item.section, item.group, i)));
    }
    checklist.push({ ...item, photos: uploaded, videos: keptVideos(item.videos) });
  }

  // A validation visit (see lib/incidents.js) has no checklist: one answer
  // per earlier issue, keyed by that issue's ref, with the "after" photos.
  const validations = [];
  for (const v of audit.validations || []) {
    const photos = v.photos || [];
    const uploaded = [];
    for (let i = 0; i < photos.length; i++) {
      uploaded.push(await store(photos[i], `${audit.id}_validation_${slug(v.ref)}_${i + 1}.jpg`));
    }
    validations.push({ ...v, photos: uploaded, videos: keptVideos(v.videos) });
  }

  // The one-off "site photo" (e.g. a clean water point with no issues to
  // report) isn't a checklist item — same upload, its own field.
  const sitePhotoUrl = audit.sitePhoto ? (await store(audit.sitePhoto, `${audit.id}_site.jpg`)).url : null;

  const record = { ...audit, checklist, sitePhoto: sitePhotoUrl, syncedAt: new Date().toISOString() };
  if (audit.validations) record.validations = validations;
  await put(`audits/${audit.id}.json`, JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  const issues = checklist.filter((c) => c.value === "issue");
  // Index-aligned with the `checklist` array the client sent (see
  // auditRecord() in lib/engine.js) so the client can swap each item's
  // heavy base64 photos for these tiny URLs once they're safely stored
  // here — otherwise the base64 payload never leaves localStorage even
  // after a successful sync.
  const photosByItem = checklist.map((c) => c.photos.map((p) => p.url));
  // Same swap for a validation visit's photos, index-aligned with the
  // `validations` array the client sent.
  const photosByValidation = validations.map((v) => v.photos.map((p) => p.url));
  return { syncedAt: record.syncedAt, findingsWritten: issues.length, photosUploaded, photosByItem, photosByValidation, sitePhotoUrl };
}

// Fetched in parallel, FETCH_CONCURRENCY at a time. One at a time (the
// original approach) took ~30-60s+ for the ~317 audits of the 2026-09
// mission and hit the 60s function limit on the Hobby plan, so the admin
// page and the Sheets export both failed ("Could not load data").
const FETCH_CONCURRENCY = 24;

// The audits are also kept together in one snapshot blob (2026-11-10).
// Fetching ~360 small files on every export — two hourly Apps Scripts, the
// sheet's IMPORTDATA formulas, the admin page — was ~30,000 CDN requests a
// day, on course for the Hobby plan's 1,000,000 a month (and 360 fetches
// is what made some exports time out). Now an export reads the snapshot;
// it's rebuilt at most once per `maxAgeMs`, with one list() and only the
// audits added or re-synced since — matched by each blob's uploadedAt.
const SNAPSHOT = "cache/audits-snapshot.json";
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

async function readSnapshot() {
  try {
    const res = await get(SNAPSHOT, { access: "public" });
    if (!res || res.statusCode !== 200) return null;
    const snap = JSON.parse(await new Response(res.stream).text());
    return snap && snap.entries ? snap : null;
  } catch {
    return null; // unreadable: rebuild it
  }
}

/** Every synced audit, newest first. `maxAgeMs: 0` forces a fresh look
 * (the admin page, the sheet's "Sync now" menu); otherwise a snapshot up
 * to an hour old is fine for the hourly scripts. */
export async function listAudits({ maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  const snap = await readSnapshot();
  const sorted = (entries) => Object.values(entries).map((e) => e.audit)
    .sort((a, b) => (b.syncedAt || "").localeCompare(a.syncedAt || ""));
  if (snap && Date.now() - Date.parse(snap.builtAt) < maxAgeMs) return sorted(snap.entries);

  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: "audits/", cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.cursor;
  } while (cursor);

  const old = (snap && snap.entries) || {};
  const entries = {};
  const todo = [];
  for (const b of blobs) {
    const uploadedAt = new Date(b.uploadedAt).toISOString();
    if (old[b.pathname] && old[b.pathname].uploadedAt === uploadedAt) entries[b.pathname] = old[b.pathname];
    else todo.push({ b, uploadedAt });
  }
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const { b, uploadedAt } = todo[next++];
      try {
        const res = await fetch(b.url);
        if (res.ok) entries[b.pathname] = { uploadedAt, audit: await res.json() };
      } catch {
        // one bad/unreachable blob shouldn't take down the whole list
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, todo.length) }, worker));

  await put(SNAPSHOT, JSON.stringify({ builtAt: new Date().toISOString(), entries }), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  }).catch((err) => console.error("snapshot write failed", err)); // still return the fresh list
  return sorted(entries);
}

export async function deleteAll() {
  let deleted = 0;
  for (const prefix of ["audits/", "photos/", "videos/", "cache/"]) {
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
        videoFilenames: (item.videos || []).map((v) => v.filename).join(", "),
        videoUrls: (item.videos || []).map((v) => v.url).join(", "),
      });
    }
  }
  return rows;
}

/** A video has been copied to Google Drive (by the parallel sheet's Apps
 * Script): point the audit record at the Drive copy, then delete the
 * video from Blob storage. Record first, so a failure never leaves the
 * audit pointing at nothing. */
export async function archiveVideo(auditId, url, driveUrl) {
  const res = await get(`audits/${auditId}.json`, { access: "public" });
  if (!res || res.statusCode !== 200) throw new Error(`No synced audit ${auditId}.`);
  const record = JSON.parse(await new Response(res.stream).text());
  let changed = 0;
  const swap = (videos) => (videos || []).map((v) => {
    if (v.url !== url) return v;
    changed++;
    return { ...v, url: driveUrl, archivedAt: new Date().toISOString() };
  });
  record.checklist = (record.checklist || []).map((c) => ({ ...c, videos: swap(c.videos) }));
  if (record.validations) record.validations = record.validations.map((v) => ({ ...v, videos: swap(v.videos) }));
  if (changed) {
    await put(`audits/${auditId}.json`, JSON.stringify(record), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }
  // Nothing to change means it was archived before (the export can lag
  // behind by up to an hour): the video is already gone.
  if (changed) await del(url);
  return { updated: changed };
}
