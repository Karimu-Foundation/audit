// IndexedDB-backed local storage for the Karimu Field Audit app.
//
// Replaces localStorage (2026-09-28) — a hard ~5-10MB ceiling per origin in
// most browsers — after field volunteers kept hitting "no space for
// photos" even right after syncing. The earlier fixes (shrinking new
// photos, swapping a synced audit's local copies for their Blob URL) all
// helped, but the actual wall was localStorage itself: any volunteer who
// builds up a backlog of not-yet-synced, photo-heavy audits between rare
// connectivity windows can still fill a few MB before ever getting to
// Sync. IndexedDB's quota is a share of the device's free disk space
// instead — typically hundreds of MB to several GB, not a fixed cap.
//
// Schema: one object store "audits" keyed by each audit's own `id` (one
// row per audit, not one giant blob — so persisting a change to one audit
// doesn't re-serialize every other audit on the device), and one object
// store "prefs" keyed by pref name. Version 2 (2026-11-10) adds "media":
// recorded videos as Blobs keyed by their own id, kept out of the audit
// rows so saving an audit never re-writes megabytes of video.

const DB_NAME = "karimu-field-audit";
const DB_VERSION = 2;
const AUDITS_STORE = "audits";
const PREFS_STORE = "prefs";
const MEDIA_STORE = "media";

let dbPromise = null;
function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDITS_STORE)) db.createObjectStore(AUDITS_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PREFS_STORE)) db.createObjectStore(PREFS_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: let it, and reopen next time.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}
/** Opening can fail now and then right after the app starts (seen on
 * phones); a short retry beats treating the device as empty. A failure
 * isn't cached, so the next call tries again. */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await openOnce(); }
      catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
    }
    throw lastErr;
  })().catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

export async function getAllAudits() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(AUDITS_STORE, "readonly").objectStore(AUDITS_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Replace the entire audits table with `list` in one transaction — clear
 * then bulk-put, so an audit removed from `list` (deleted on this device)
 * actually disappears instead of a plain put loop leaving it behind. */
export async function putAllAudits(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(AUDITS_STORE, "readwrite");
    const store = t.objectStore(AUDITS_STORE);
    store.clear();
    list.forEach((a) => store.put(a));
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAllPrefs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PREFS_STORE, "readonly").objectStore(PREFS_STORE).getAll();
    req.onsuccess = () => {
      const out = {};
      (req.result || []).forEach((row) => { out[row.key] = row.value; });
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putPref(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PREFS_STORE, "readwrite").objectStore(PREFS_STORE).put({ key, value });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/** One-time move from the old localStorage-backed version. Safe to call
 * on every boot — it only does anything the first time, gated by a
 * migrated flag written as an ordinary pref once done. Clears the legacy
 * keys afterward, since reclaiming that space is the whole point. */
export async function migrateFromLocalStorage(legacyAuditsKey, legacyPrefsKey) {
  const prefs = await getAllPrefs().catch(() => ({}));
  if (prefs.__migratedFromLocalStorage) return;

  let legacyAudits = [];
  let legacyPrefs = {};
  try { legacyAudits = JSON.parse(localStorage.getItem(legacyAuditsKey) || "[]"); } catch (e) { /* corrupt or absent — nothing to migrate */ }
  try { legacyPrefs = JSON.parse(localStorage.getItem(legacyPrefsKey) || "{}"); } catch (e) { /* corrupt or absent — nothing to migrate */ }

  if (legacyAudits.length) await putAllAudits(legacyAudits);
  for (const k of Object.keys(legacyPrefs)) await putPref(k, legacyPrefs[k]);
  await putPref("__migratedFromLocalStorage", true);

  try { localStorage.removeItem(legacyAuditsKey); } catch (e) { /* best-effort space reclaim */ }
  try { localStorage.removeItem(legacyPrefsKey); } catch (e) { /* best-effort space reclaim */ }
}

export async function wipeAll() {
  const db = await openDB();
  await Promise.all([AUDITS_STORE, PREFS_STORE, MEDIA_STORE].map((name) => new Promise((resolve, reject) => {
    const t = db.transaction(name, "readwrite");
    t.objectStore(name).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  })));
}

/** {usage, quota} in bytes, or null if the API isn't available (older
 * Safari) — informational only, used for the "MB on device" tile. */
export async function estimateUsage() {
  if (!(navigator.storage && navigator.storage.estimate)) return null;
  try { return await navigator.storage.estimate(); } catch (e) { return null; }
}

/** Asks the browser not to evict this origin's storage under pressure.
 * Not supported everywhere (notably not on iOS Safari) — best-effort. */
export async function requestPersistence() {
  if (!(navigator.storage && navigator.storage.persist)) return false;
  try { return await navigator.storage.persist(); } catch (e) { return false; }
}

/* ---------- media (recorded videos, 2026-11-10) ---------- */

export async function putMedia(id, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(MEDIA_STORE, "readwrite");
    t.objectStore(MEDIA_STORE).put({ id, blob });
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getMedia(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(MEDIA_STORE, "readonly").objectStore(MEDIA_STORE).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

/** Deletes the given ids, or — with `keep` — every id NOT in it (videos
 * left behind by audits deleted from the device). */
export async function deleteMedia({ ids, keep }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(MEDIA_STORE, "readwrite");
    const store = t.objectStore(MEDIA_STORE);
    if (ids) ids.forEach((id) => store.delete(id));
    if (keep) {
      const req = store.getAllKeys();
      req.onsuccess = () => (req.result || []).forEach((id) => { if (!keep.has(id)) store.delete(id); });
    }
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
