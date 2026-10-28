// Karimu Field Audit — core app engine.
// Ported from the original single-file prototype: same screens, same
// offline-first localStorage model, same checklist logic. The only
// change from the Artifact version is how Sync leaves the device:
// it now POSTs to /api/sync (a real serverless function on this same
// deployment) instead of asking the Artifact runtime to save a file.

import {
  SCHOOLS, BUILDING_NAMES, BUILDING_TYPES, TEACHING_SPACES, COOKING_SPACES,
  BATHROOM_UNITS, SCHOOL_BUILDING, SCHOOL_BATHROOM, AUDIT_TYPES,
  groupApplies, buildItems, sectionsFor, slug, prefillPlan,
} from "./checklists";
import {
  getWards, getVillages, getSubVillages, getAssets, findAsset,
  getGroupRoute,
} from "./waterAssets";
import { LANGUAGES, setLang, getLang, tr, ui, noun } from "./i18n";
import {
  getAllAudits, putAllAudits, getAllPrefs, putPref,
  migrateFromLocalStorage, wipeAll, estimateUsage, requestPersistence,
} from "./idbStore";
import L from "leaflet";


/* ==================================================================
   STORAGE  (offline-first: everything lives on the device until sync)
   Backed by IndexedDB (see idbStore.js) as of 2026-09-28 — localStorage's
   ~5-10MB ceiling was the actual wall behind "no space for photos", not
   anything about compression or sync cleanup. `audits` and `prefsCache`
   stay in-memory and synchronous for every existing call site (dozens of
   them read pref() or mutate `audits` directly); only the persistence
   underneath is now async, fired-and-forgotten from save()/pref().
   ================================================================== */
const KEY = "karimu.audits.v2";   // legacy localStorage key, migration source only
const PREF = "karimu.prefs.v1";   // legacy localStorage key, migration source only

let audits = [];
let prefsCache = {};
let state = {screen:"home", id:null};

function save(list){
  putAllAudits(list).catch((err) => {
    console.error("persist failed", err);
    alert(ui("storageFull"));
  });
  return true;
}
function pref(k, v){
  if(v === undefined) return prefsCache[k];
  prefsCache[k] = v;
  putPref(k, v).catch((err) => console.error("pref persist failed", err));
  return v;
}

/** Runs once, awaited at the top of mount() before anything reads
 * `audits`/prefsCache — see idbStore.migrateFromLocalStorage for the
 * one-time move off the old localStorage keys. */
async function boot(){
  try{ await migrateFromLocalStorage(KEY, PREF); }
  catch(e){ console.error("migration failed, continuing with whatever IndexedDB already has", e); }
  try{ audits = await getAllAudits(); }catch(e){ audits = []; }
  try{ prefsCache = await getAllPrefs(); }catch(e){ prefsCache = {}; }
  reclaimSyncedPhotoSpace();
  requestPersistence().catch(() => {});
}

/** Retroactive companion to the post-sync photo swap in doSync(): any
 * audit with syncedAt already set had every one of its photos uploaded to
 * Blob storage at sync time (see blobStore.saveAudit), whether that sync
 * happened before or after this cleanup existed. Devices that synced
 * audits before 2026-09-24 never got their local base64 copies swapped
 * out, so they're still sitting in localStorage taking up space that's
 * fully recoverable right now — this just needed someone to say so on
 * next load, not a fresh sync. Doesn't touch draft/pending audits (not
 * yet synced — those photos are the only copy until Sync runs). */
function reclaimSyncedPhotoSpace(){
  let changed = false;
  audits.forEach(a => {
    if(!a.syncedAt) return;
    Object.values(a.answers || {}).forEach(ans => {
      if(!ans || !ans.photos || !ans.photos.length) return;
      const kept = ans.photos.filter(p => !(typeof p === "string" && p.startsWith("data:")));
      if(kept.length !== ans.photos.length){ ans.photos = kept; changed = true; }
    });
    // Same idea for the one-off site photo — synced means it's already
    // uploaded, but there's no stored URL to fall back to from before this
    // field existed, so just drop the local copy rather than leave it.
    if(a.sitePhoto && typeof a.sitePhoto === "string" && a.sitePhoto.startsWith("data:")){
      a.sitePhoto = null;
      changed = true;
    }
  });
  if(changed) persist();
}

function uid(){
  return "KA-" + Date.now().toString(36).toUpperCase() + "-" +
         Math.random().toString(36).slice(2,6).toUpperCase();
}
function current(){ return audits.find(a => a.id === state.id); }
function persist(){ save(audits); }

/* ==================================================================
   TEST MODE (added 2026-10-02) — for trying the app without touching
   production. Every audit started while it's on carries test:true for
   life: it's never sent to the server (doSync simulates it locally, and
   /api/sync refuses to store one as a second guard), even after test mode
   is turned off again. While test mode is on, Sync sends nothing at all —
   real audits waiting on the device just stay queued. Route badges and
   "resume this stop" only look at audits of the current mode, so a test
   run never makes a real stop look done (or vice versa).
   ================================================================== */
function testMode(){ return !!pref("testMode"); }
function inCurrentMode(a){ return !!a.test === testMode(); }

/* ==================================================================
   AUDITOR SIGN-IN (added 2026-10-28) — replaces picking a name from a
   fixed list. Accounts are created on the admin page; the first time,
   an auditor opens their invite link (/?invite=…) and sets a password.
   The device then keeps a long-lived token (see lib/auditorAuth.js) and
   the auditor's assigned groups, so it works offline for the whole
   mission after signing in once with signal. Both are refreshed from
   /api/me whenever the app is online.
   ================================================================== */
function authUser(){ const a = pref("auth"); return a && a.user ? a.user : null; }
function authToken(){ const a = pref("auth"); return a && a.token ? a.token : null; }
function assignments(){ return pref("assignments") || []; }
function signIn(body){
  pref("auth", {token: body.token, user: {id: body.user.id, name: body.user.name, email: body.user.email}});
  pref("assignments", body.assignments || []);
}
function signOut(){
  pref("auth", null);
  pref("assignments", []);
  pref("routeGroup", null);
}
/** Called on boot and when opening My route, online only. Never blocks
 * the UI; a 401 means the account was deactivated or the password reset,
 * so the device is signed out (its audits stay on it, untouched). */
async function refreshMe(){
  if(!authToken() || !navigator.onLine) return;
  try{
    const res = await fetch("/api/me", {headers: {Authorization: "Bearer " + authToken()}});
    if(res.status === 401){ signOut(); state = {screen:"login", id:null}; render(); return; }
    const body = await res.json();
    if(body.ok){
      pref("auth", {token: authToken(), user: {id: body.user.id, name: body.user.name, email: body.user.email}});
      pref("assignments", body.assignments || []);
      if(state.screen === "home" || state.screen === "route" || state.screen === "routegroup") render();
    }
  }catch(e){ /* offline or flaky — keep the cached assignments */ }
}
/** Invite token from the link this page was opened with, if any — read
 * once at boot and removed from the address bar. */
let pendingInvite = null;
let inviteInfo = null;   // {name, email} | {invalid:true} once looked up
let authError = "";

/* ==================================================================
   PRE-FILL (water points) — see PREFILL_RULES in lib/checklists.js.
   Re-derived from the audit's current facts every time one of them
   changes (water yes/no, which asset), so it's safe to call repeatedly:
   it only fills items that are empty, only clears items it filled itself
   (ans.auto) that no longer apply, and never touches an answer the
   auditor gave — setAnswer() drops `auto` the moment they tap one.
   ================================================================== */
function applyPrefill(a){
  const plan = prefillPlan(a, findAsset(a.assetTag));
  const planned = new Set(plan.map(p => p.key));
  a.answers = a.answers || {};
  Object.entries(a.answers).forEach(([key, ans]) => {
    if(!ans || !ans.auto || planned.has(key)) return;
    ans.value = "";
    if(ans.autoNote && ans.note === ans.autoNote) ans.note = "";
    delete ans.auto; delete ans.autoNote;
  });
  plan.forEach(p => {
    const cur = a.answers[p.key] = a.answers[p.key] || {};
    if(cur.value && !cur.auto) return;
    cur.value = p.value; cur.auto = p.reason;
    if(p.note && !(cur.note || "").trim()){ cur.note = p.note; cur.autoNote = p.note; }
  });
  a.updatedAt = new Date().toISOString();
}
const unanswered = v => v === undefined || v === null;
function needsPrecheck(a){
  return a.type === "water_point" && a.assetType !== "T" && (unanswered(a.hasWater) || unanswered(a.hasValveKey));
}
/** Where "open the checklist" should land: the before-the-checklist
 * questions (water, valve key) first, if any is still unanswered — e.g.
 * an audit started before the valve-key question existed gets asked just
 * that one, with its earlier water answer already selected. */
function checklistScreenFor(a){ return needsPrecheck(a) ? "precheck" : "check"; }

/* ==================================================================
   GPS vs. the register (added 2026-10-02)
   ================================================================== */
const GPS_WARN_METERS = 50;
function distanceMeters(lat1, lon1, lat2, lon2){
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat/2) ** 2 + Math.cos(lat1*rad) * Math.cos(lat2*rad) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Meters between the captured GPS fix and this water point's coordinates
 * in the register, or null if either side is missing (30 of the 332
 * Public Water Points have no coordinates on file). */
function gpsDistanceToAsset(a){
  if(!a.gps || a.type !== "water_point") return null;
  const asset = findAsset(a.assetTag);
  if(!asset || asset.lat == null || asset.lon == null) return null;
  return Math.round(distanceMeters(a.gps.lat, a.gps.lon, asset.lat, asset.lon));
}

/* ==================================================================
   HELPERS
   ================================================================== */
const $ = sel => document.querySelector(sel);
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function today(){
  const d = new Date(), p = n => String(n).padStart(2,"0");
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate());
}
/* Canonical English unit name — this is what gets stored and synced.
   Never route this through tr()/ui(); use unitNameDisplay() for UI. */
function unitName(a){
  if(a.type === "water_point") return a.assetTag || "—";
  if(a.type === "school_bathroom"){
    const u = BATHROOM_UNITS.find(x => x.id === a.unitId);
    return u ? u.label : "—";
  }
  return a.unitName || "—";
}
/* Display-only translated version, for screens. */
function unitNameDisplay(a){
  if(a.type === "water_point") return a.assetTag || "—";
  if(a.type === "school_bathroom"){
    const u = BATHROOM_UNITS.find(x => x.id === a.unitId);
    return u ? tr(u.label) : "—";
  }
  return a.unitName || "—";
}
/* Ward / Village / Sub-Village breadcrumb — the water_point equivalent
   of "school" as the top-level location label shown on cards/headers.
   Place names are never translated (same rule as SCHOOLS). */
function locationLabel(a){
  if(a.type === "water_point"){
    return [a.ward, a.village, a.subVillage].filter(Boolean).join(" · ") || "—";
  }
  return a.school || "—";
}
function auditStats(a){
  const items = buildItems(a);
  let answered = 0, issues = 0;
  items.forEach(it => {
    const v = (a.answers || {})[it.key];
    if(v && v.value){ answered++; if(v.value === "issue") issues++; }
  });
  return {total:items.length, answered, issues, items};
}
function statusOf(a){
  if(a.syncedAt) return "synced";
  if(a.completedAt) return "ready";
  return "draft";
}
function statusLabel(st){
  return st === "synced" ? ui("statusSynced") : st === "ready" ? ui("statusReady") : ui("statusDraft");
}

/** Best-known status of a water point's audit, by Asset Tag — for the
 * small badge on each stop in "My route": "synced" (done and off the
 * device), "ready" (done, waiting to sync), or null (not started/finished
 * yet). If more than one audit exists for the same tag (e.g. a redo),
 * the most complete one wins, since that's the one that matters. */
function auditStatusForTag(tag){
  const matches = audits.filter(a => a.type === "water_point" && a.assetTag === tag && inCurrentMode(a));
  if(!matches.length) return null;
  if(matches.some(a => a.syncedAt)) return "synced";
  if(matches.some(a => a.completedAt)) return "ready";
  return null;
}

const STOP_STATUS_SVG = {
  synced: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.5"/></svg>',
  ready: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.3v5l3.3 1.9"/></svg>',
  none: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/></svg>',
};
/** Small status badge for one stop on the route list — see
 * auditStatusForTag() for what the three states mean. */
function stopStatusBadge(tag){
  const st = auditStatusForTag(tag) || "none";
  const label = st === "synced" ? ui("stopSynced") : st === "ready" ? ui("stopReadyToSync") : ui("stopNotDone");
  return `<span class="stop-status stop-status-${st}" title="${esc(label)}" aria-label="${esc(label)}">${STOP_STATUS_SVG[st]}</span>`;
}

/* ==================================================================
   NET STATE + SYNC PILL
   ================================================================== */
function pendingList(){ return audits.filter(a => a.completedAt && !a.syncedAt); }

/** Delete one audit straight from the home list — fully offline, no need
 * to open it first. The confirm message is tailored to what would be lost
 * (a draft, a finished-but-unsynced audit, or just the local copy of one
 * already synced), since the stakes are very different. */
function deleteAuditFromHome(id){
  const a = audits.find(x => x.id === id);
  if(!a) return;
  const st = statusOf(a);
  const msg = st === "synced" ? ui("confirmDeleteSynced")
            : st === "ready"  ? ui("confirmDeleteReady")
            : ui("confirmDeleteDraft");
  if(confirm(msg)){
    audits = audits.filter(x => x.id !== id);
    persist();
    render();
  }
}

function renderChrome(){
  const online = navigator.onLine;
  const pend = pendingList().length;
  $("#netDot").className = "dot " + (online ? "online" : "offline");
  $("#brandSub").textContent = online ? ui("onlineText") : ui("offlineText");
  const pill = $("#syncPill");
  pill.classList.toggle("has-pending", pend > 0);
  $("#syncLabel").innerHTML = pend > 0
    ? esc(ui("syncPillLabel")) + ' <span class="count-chip">' + pend + '</span>'
    : esc(ui("syncPillLabel"));
  const homeBtn = $("#homeBtn");
  if(homeBtn){ homeBtn.title = ui("goHome"); homeBtn.setAttribute("aria-label", ui("goHome")); }
  const langBtn = $("#langBtn");
  if(langBtn){ langBtn.title = ui("changeLanguage"); langBtn.setAttribute("aria-label", ui("changeLanguage")); }
  const langLabel = $("#langLabel");
  if(langLabel){
    const l = LANGUAGES.find(x => x.id === getLang());
    langLabel.textContent = l ? l.code : "EN";
  }
  const testBanner = $("#testBanner");
  if(testBanner){
    testBanner.hidden = !testMode();
    testBanner.textContent = ui("testModeBanner");
  }
  document.body.classList.toggle("test-mode", testMode());
  if(testMode()) $("#brandSub").textContent = ui("testModeShort") + " · " + $("#brandSub").textContent;
}
window.addEventListener("online", renderChrome);
window.addEventListener("offline", renderChrome);

/* ==================================================================
   SCREENS
   ================================================================== */
/* Tracks which screen+audit was last drawn, so render() only jumps the
   page to the top on a genuine screen change — not on every re-render.
   Without this, in-place updates like "All OK" / "Rest OK" (which stay
   on the checklist screen and just redraw its content) were yanking the
   volunteer back to the top of a long checklist every time. */
let lastRenderKey = null;
let routeMapInstance = null;
function render(){
  renderChrome();
  const v = $("#view");
  const b = $("#bottom");
  b.innerHTML = "";
  const renderKey = state.screen + "|" + (state.id || "");
  if(renderKey !== lastRenderKey) window.scrollTo({top:0});
  lastRenderKey = renderKey;
  // The route screen owns a live Leaflet map instance bound to a DOM node
  // that's about to be thrown away by the innerHTML swap below — tear it
  // down first so it doesn't keep listening on a detached element. This is
  // wrapped in try/catch on purpose: if the map ever ended up in a broken
  // state (e.g. Leaflet threw while building it — see initRouteMap), a
  // throwing .remove() here would abort render() before the new screen's
  // HTML is written, silently freezing the whole app on the old screen no
  // matter what the volunteer taps next. Losing the map cleanly beats
  // losing the entire app.
  if(routeMapInstance && state.screen !== "route"){
    try{ routeMapInstance.remove(); }catch(e){}
    routeMapInstance = null;
  }
  if(state.screen === "lang")      v.innerHTML = screenLang();
  else if(state.screen === "login") v.innerHTML = screenLogin();
  else if(state.screen === "invite") v.innerHTML = screenInvite();
  else if(state.screen === "routegroup") v.innerHTML = screenRouteGroup();
  else if(state.screen === "home")      v.innerHTML = screenHome();
  else if(state.screen === "pick") v.innerHTML = screenPick();
  else if(state.screen === "route"){ v.innerHTML = screenRoute(); requestAnimationFrame(initRouteMap); }
  else if(state.screen === "setup")v.innerHTML = screenSetup();
  else if(state.screen === "precheck") v.innerHTML = screenPrecheck();
  else if(state.screen === "install") v.innerHTML = screenInstall();
  else if(state.screen === "check"){ v.innerHTML = screenCheck(); b.innerHTML = barCheck(); }
  else if(state.screen === "review"){ v.innerHTML = screenReview(); b.innerHTML = barReview(); }
  else if(state.screen === "sync") v.innerHTML = screenSync();
}

/* ---------- LANGUAGE PICKER ---------- */
function screenLang(){
  const firstRun = !pref("lang");
  return `
  ${firstRun ? "" : `<button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>`}
  <div class="hero">
    <span class="eyebrow">${esc(ui("chooseLanguageEyebrow"))}</span>
    <h1>${firstRun ? "Choose your language / Elige tu idioma / Escolha seu idioma" : esc(ui("chooseLanguage"))}</h1>
  </div>
  <div class="stack gap-10">
    ${LANGUAGES.map(l => `<button class="btn btn-block ${getLang()===l.id ? "btn-primary" : "btn-ghost"}" data-act="setlang" data-lang="${l.id}">${esc(l.label)}</button>`).join("")}
  </div>
  ${firstRun || !authUser() ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow">${esc(ui("accountLabel"))}</span>
    <p class="small" style="margin:0">${esc(authUser().name)} · <span class="muted">${esc(authUser().email)}</span></p>
    <button class="btn btn-block btn-ghost" data-act="signout">${esc(ui("signOutButton"))}</button>
  </div>`}
  ${firstRun || isInstalled() ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow">${esc(ui("installSettingsLabel"))}</span>
    <button class="btn btn-block btn-ghost" data-act="showinstall">${esc(ui("installSettingsButton"))}</button>
  </div>`}
  ${firstRun ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow">${esc(ui("testModeLabel"))}</span>
    <p class="small" style="color:var(--muted)">${esc(ui("testModeHint"))}</p>
    <button class="btn btn-block ${testMode() ? "btn-primary" : "btn-ghost"}" data-act="toggletest">${esc(ui(testMode() ? "testModeTurnOff" : "testModeTurnOn"))}</button>
  </div>`}
  ${firstRun ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow" style="color:var(--issue)">${esc(ui("resetAppData"))}</span>
    <p class="small" style="color:var(--muted)">${esc(ui("resetAppDataHint"))}</p>
    <button class="btn btn-block btn-danger-outline" data-act="resetapp">${esc(ui("resetAppData"))}</button>
  </div>`}`;
}

/* ---------- ADD TO HOME SCREEN GUIDE (added 2026-10-06) ----------
   Shown once, right after the language pick on first run (so it's in the
   volunteer's language) — and once to existing devices that haven't seen
   it — unless the app is already running from the home screen or it's not
   a phone. Reopenable from Settings. iPhone steps are manual (Safari has no
   install API); on Android, Chrome's own install prompt is offered as a
   one-tap button when available (captured in app/page.js), with manual
   steps as the fallback. */
function installPlatform(){
  const ua = navigator.userAgent || "";
  // Android first: the iPadOS check below (iPads report a desktop "MacIntel"
  // platform, but with touch) must never claim an Android phone.
  if(/Android/i.test(ua)) return "android";
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if(/iPhone|iPad|iPod/.test(ua) || iPadOS) return "ios";
  return "other";
}
function isInstalled(){
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}
function shouldShowInstallGuide(){
  return !pref("installGuideSeen") && !isInstalled() && installPlatform() !== "other";
}
const INSTALL_ICONS = {
  share: '<svg class="inline-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
  more: '<svg class="inline-ico" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  add: '<svg class="inline-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  kebab: '<svg class="inline-ico" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  home: '<svg class="inline-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M11 18h2"/></svg>',
};
function screenInstall(){
  const platform = state.installPlatform || (installPlatform() === "android" ? "android" : "ios");
  const steps = platform === "ios"
    ? [["installIos1", "installIos1Hint", "share"], ["installIos2", null, "add"], ["installIos3", "installIos3Hint", null], ["installOpen", null, "home"]]
    : [["installAndroid1", "installAndroid1Hint", "kebab"], ["installAndroid2", null, "add"], ["installAndroid3", null, null], ["installOpen", null, "home"]];
  const canPrompt = platform === "android" && !!window.__installPrompt;
  // On iPhone the home-screen app gets its own storage, separate from
  // Safari — anything not yet synced here would stay behind in Safari.
  const unsynced = audits.filter(a => !a.syncedAt && !a.test).length;
  const other = platform === "ios" ? "android" : "ios";
  return `
  <div class="hero">
    <span class="eyebrow">${esc(ui("installEyebrow"))}</span>
    <h1>${esc(ui("installTitle"))}</h1>
    <p class="lede small">${esc(ui("installLede"))}</p>
  </div>
  ${platform === "ios" && unsynced ? `<div class="banner banner-warn" style="margin-bottom:16px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
    <div>${esc(ui("installIosUnsyncedWarn", {n: unsynced, itemWord: noun("audit", unsynced)}))}</div>
  </div>` : ""}
  ${canPrompt ? `<button class="btn btn-primary btn-block" data-act="installnow" style="margin-bottom:14px">${esc(ui("installNowButton"))}</button>
  <p class="small muted" style="margin:-4px 0 14px;text-align:center">${esc(ui("installOrManual"))}</p>` : ""}
  <div class="card" style="padding:6px 18px;margin-bottom:16px">
    <ol class="install-steps">
      ${steps.map(([text, hint, icon]) => `<li>
        <div>${esc(ui(text))}${icon ? " " + INSTALL_ICONS[icon] : ""}</div>
        ${hint ? `<div class="small muted">${esc(ui(hint))}</div>` : ""}
      </li>`).join("")}
    </ol>
  </div>
  <div class="stack gap-10">
    <button class="btn btn-primary btn-block" data-act="installdone">${esc(ui("installDone"))}</button>
    <button class="btn btn-ghost btn-block" data-act="installdone">${esc(ui("installSkip"))}</button>
    <button class="backlink" data-act="installplatform" data-p="${other}" style="align-self:center;margin-top:4px">${esc(ui(other === "ios" ? "installShowIos" : "installShowAndroid"))}</button>
  </div>`;
}

/* ---------- SIGN IN (first run, right after language) ---------- */
function authErrorLine(){
  return authError ? `<p class="small" style="color:var(--issue);margin:0">${esc(authError)}</p>` : "";
}
function screenLogin(){
  return `
  <div class="hero">
    <span class="eyebrow">${esc(ui("loginEyebrow"))}</span>
    <h1>${esc(ui("loginTitle"))}</h1>
    <p class="lede small">${esc(ui("loginLede"))}</p>
  </div>
  ${navigator.onLine ? "" : `<div class="banner banner-warn" style="margin-bottom:16px"><div>${esc(ui("loginNeedsSignal"))}</div></div>`}
  <form data-form="login" class="card stack gap-14" style="padding:18px">
    <label class="field"><span>${esc(ui("emailLabel"))}</span>
      <input type="email" name="email" autocomplete="username" inputmode="email" required>
    </label>
    <label class="field"><span>${esc(ui("passwordLabel"))}</span>
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    ${authErrorLine()}
    <button class="btn btn-primary btn-block" type="submit">${esc(ui("signInButton"))}</button>
  </form>
  <p class="small muted" style="text-align:center;margin-top:14px">${esc(ui("loginFirstTimeHint"))}</p>`;
}

/* ---------- SET PASSWORD FROM AN INVITE LINK ---------- */
function screenInvite(){
  if(!inviteInfo){
    loadInviteInfo();
    return `<p class="small muted">${esc(ui("loadingInvite"))}</p>`;
  }
  if(inviteInfo.invalid){
    return `
    <div class="hero">
      <h1>${esc(ui("inviteInvalidTitle"))}</h1>
      <p class="lede small">${esc(ui(inviteInfo.offline ? "inviteNeedsSignal" : "inviteInvalidHint"))}</p>
    </div>
    <button class="btn btn-ghost btn-block" data-act="gologin">${esc(ui("haveAccountSignIn"))}</button>`;
  }
  return `
  <div class="hero">
    <span class="eyebrow">${esc(ui("inviteEyebrow"))}</span>
    <h1>${esc(ui("inviteTitle", {name: inviteInfo.name}))}</h1>
    <p class="lede small">${esc(ui("inviteLede", {email: inviteInfo.email}))}</p>
  </div>
  <form data-form="invite" class="card stack gap-14" style="padding:18px">
    <input type="email" name="username" autocomplete="username" value="${esc(inviteInfo.email)}" hidden>
    <label class="field"><span>${esc(ui("newPasswordLabel"))}</span>
      <input type="password" name="password" autocomplete="new-password" minlength="8" required>
    </label>
    <label class="field"><span>${esc(ui("confirmPasswordLabel"))}</span>
      <input type="password" name="confirm" autocomplete="new-password" minlength="8" required>
    </label>
    ${authErrorLine()}
    <button class="btn btn-primary btn-block" type="submit">${esc(ui("createPasswordButton"))}</button>
  </form>`;
}
async function loadInviteInfo(){
  try{
    const res = await fetch("/api/auth/invite?token=" + encodeURIComponent(pendingInvite));
    const body = await res.json().catch(() => ({}));
    inviteInfo = body.ok ? {name: body.name, email: body.email} : {invalid: true};
  }catch(e){
    inviteInfo = {invalid: true, offline: true};
  }
  if(state.screen === "invite") render();
}

/** Login and invite forms. Both end the same way: the device is signed
 * in and goes Home (via the install guide on a first run). */
async function submitAuthForm(form){
  const kind = form.dataset.form;
  const data = Object.fromEntries(new FormData(form));
  authError = "";
  if(kind === "invite" && data.password !== data.confirm){ authError = ui("passwordsDontMatch"); render(); return; }
  if(!navigator.onLine){ authError = ui("loginNeedsSignal"); render(); return; }
  const btn = form.querySelector('button[type="submit"]');
  if(btn){ btn.disabled = true; btn.textContent = ui("pleaseWait"); }
  try{
    const res = kind === "login"
      ? await fetch("/api/auth/login", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({email: data.email, password: data.password})})
      : await fetch("/api/auth/invite", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token: pendingInvite, password: data.password})});
    const body = await res.json().catch(() => ({}));
    if(!body.ok){
      authError = body.code === "bad_credentials" ? ui("wrongEmailOrPassword")
        : body.code === "weak_password" ? ui("passwordTooShort")
        : body.code === "invalid_invite" ? ui("inviteInvalidHint")
        : (body.message || ui("syncErrUnknown"));
      render();
      return;
    }
    signIn(body);
    pendingInvite = null; inviteInfo = null;
    const next = {screen:"home", id:null};
    state = shouldShowInstallGuide() ? {screen:"install", id:null, next} : next;
    render();
  }catch(e){
    authError = ui("syncErrNetwork");
    render();
  }
}

/* ---------- ROUTE GROUP PICKER (which assigned group to work today) ---------- */
// Assignments come from the admin page (project -> group -> auditor ->
// day). The same group number can appear in different projects, so the
// saved choice is "projectId:group".
const assignmentKey = (a) => a.projectId + ":" + a.group;
function myGroups(){
  return assignments().map(a => ({...a, key: assignmentKey(a), count: getGroupRoute(a.group).ordered.length + getGroupRoute(a.group).unordered.length}));
}
function currentRouteGroup(){
  const groups = myGroups();
  if(!groups.length) return null;
  return groups.find(g => g.key === pref("routeGroup")) || groups[0];
}

function screenRouteGroup(){
  const groups = myGroups();
  const current = (currentRouteGroup() || {}).key;
  const backTo = state.returnTo === "route" ? "myroute" : "home";
  return `
  <button class="backlink" data-act="${esc(backTo)}" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui("chooseGroupEyebrow"))}</span>
    <h1>${esc(ui("chooseGroupTitle"))}</h1>
    <p class="lede small">${esc(ui("chooseGroupHint"))}</p>
  </div>
  <div class="stack gap-10">
    ${groups.length ? groups.map(g => `
    <button class="btn btn-block ${current===g.key ? "btn-primary" : "btn-ghost"}" data-act="setroutegroup" data-group="${esc(g.key)}">
      <span class="row" style="justify-content:space-between;width:100%">
        <span>${esc(ui("dayGroupLabel", {day:g.day, group:g.group}))}${new Set(groups.map(x => x.projectId)).size > 1 ? ` · <span class="small">${esc(g.projectName)}</span>` : ""}</span>
        <span class="small" style="opacity:.75">${esc(ui("groupPointsCount", {n:g.count}))}</span>
      </span>
    </button>`).join("") : `
    <div class="empty">
      <div style="font-family:var(--font-display);font-weight:600;color:var(--ink);margin-bottom:5px">${esc(ui("noGroupsAssigned"))}</div>
    </div>`}
  </div>`;
}

/* ---------- MY ROUTE (map + ordered stop list for the current volunteer's current group) ---------- */
function routeStopCard(a, orderNum){
  const sub = [a.village, a.sub].filter(Boolean).join(" · ");
  return `
  <button class="audit-item" data-act="routestop" data-tag="${esc(a.tag)}">
    <span class="spine"></span>
    <span class="body">
      <span class="row wrap" style="gap:8px">
        ${orderNum ? `<span class="chip chip-draft">${orderNum}</span>` : `<span class="chip chip-draft" style="background:var(--surface-2);color:var(--muted)">${esc(ui("routeNoGpsChip"))}</span>`}
        <span style="flex:1"></span>
        ${stopStatusBadge(a.tag)}
      </span>
      <span class="audit-title">${esc(a.tag)}${sub ? " — " + esc(sub) : ""}</span>
      <span class="audit-meta"><span>${esc(a.loc || "—")}</span></span>
    </span>
  </button>`;
}

function screenRoute(){
  const user = authUser();
  const volunteer = user ? user.name : "";
  const groups = myGroups();
  const current = currentRouteGroup();
  const { ordered, unordered } = current ? getGroupRoute(current.group) : {ordered:[], unordered:[]};
  return `
  <button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui("routeEyebrow"))}</span>
    <h1>${esc(ui("routeTitle", {volunteer: volunteer || ""}))}</h1>
    ${current ? `<p class="lede small">${esc(ui("routeGroupLede", {day: current.day, group: current.group}))}</p>` : ""}
    <p class="lede small">${esc(ui("routeLede", {n: ordered.length}))}</p>
  </div>
  ${groups.length > 1 ? `
  <button class="btn btn-ghost btn-block" data-act="changegroup" style="margin-bottom:18px">${esc(ui("changeGroup"))}</button>
  ` : ""}
  ${ordered.length ? `
  <div id="routeMap" style="height:280px;border-radius:var(--r-lg);overflow:hidden;margin-bottom:10px;border:1px solid var(--line)"></div>
  <p class="small" style="color:var(--muted);margin-bottom:20px">${esc(ui("routeMapHint"))}</p>
  <div class="stack gap-10">
    ${ordered.map((a,i) => routeStopCard(a, i+1)).join("")}
  </div>` : `
  <div class="empty" style="margin-bottom:20px">
    <div style="font-family:var(--font-display);font-weight:600;color:var(--ink);margin-bottom:5px">${esc(ui("routeNoneYet"))}</div>
  </div>`}
  ${unordered.length ? `
  <div class="row" style="margin:26px 0 6px">
    <span class="eyebrow">${esc(ui("routeNoLocationHeading"))}</span>
  </div>
  <p class="small" style="color:var(--muted);margin-bottom:11px">${esc(ui("routeNoLocationHint"))}</p>
  <div class="stack gap-10">
    ${unordered.map(a => routeStopCard(a, null)).join("")}
  </div>` : ""}`;
}

/** (Re)build the Leaflet map for the current volunteer's ordered route.
 * Called via requestAnimationFrame right after screenRoute() is put into
 * the DOM, since Leaflet needs the #routeMap element to already exist
 * (and have a real height) before it can measure it.
 *
 * The whole body is wrapped in try/catch: this map is a nice-to-have on
 * top of the route list, which is plain HTML underneath it and works
 * without the map ever loading (crucial with the connectivity this app
 * has to work with — no signal means no tiles, ever). A map that fails to
 * build must never take anything else down with it. It used to: L.map()
 * has no defined view (no center/zoom) until something sets one, and
 * adding a tileLayer/polyline/markers before that happened made Leaflet
 * crash trying to project coordinates onto a view that doesn't exist yet
 * — which then left a half-built map instance around that also threw when
 * torn down on the next render(), freezing the entire app on this screen
 * (see the try/catch around routeMapInstance.remove() above). Calling
 * fitBounds() first (which sets the view) before adding any layer avoids
 * the crash at the source; the outer try/catch is the safety net in case
 * anything else about a given device's map/tile support ever misbehaves. */
function initRouteMap(){
  try{
    const el = document.getElementById("routeMap");
    if(!el) return;
    const current = currentRouteGroup();
    if(!current) return;
    const { ordered } = getGroupRoute(current.group);
    if(!ordered.length) return;
    const map = L.map(el, {scrollWheelZoom:false});
    routeMapInstance = map;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0B6B70";
    const latlngs = ordered.map(a => [a.lat, a.lon]);
    // Establish the view FIRST — before any layer is added — so Leaflet
    // always has a valid center/zoom to project against.
    map.fitBounds(L.latLngBounds(latlngs), {padding: [24, 24]});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    L.polyline(latlngs, {color: accent, weight: 3, opacity: 0.8}).addTo(map);
    ordered.forEach((a, i) => {
      const icon = L.divIcon({
        className: "route-pin",
        html: `<span style="background:${accent}">${i+1}</span>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      L.marker([a.lat, a.lon], {icon, title: a.tag}).addTo(map);
    });
  }catch(e){
    // Map failed to build (bad data, no tiles, whatever) — the route list
    // below it is plain HTML and still fully usable, so just drop it.
    if(routeMapInstance){ try{ routeMapInstance.remove(); }catch(e2){} routeMapInstance = null; }
  }
}

/* ---------- HOME ---------- */
function screenHome(){
  const drafts = audits.filter(a => !a.completedAt);
  const pend = pendingList();
  const synced = audits.filter(a => a.syncedAt);
  const ordered = [...drafts, ...pend, ...synced];
  const volunteer = (authUser() || {}).name;

  return `
  <div class="hero">
    <span class="eyebrow">${esc(ui("homeEyebrow"))}</span>
    <h1>${esc(ui("homeTitle"))}</h1>
    <p class="lede small">${esc(ui("homeLede"))}</p>
  </div>

  ${volunteer ? `<p class="small" style="color:var(--muted);margin:-8px 0 18px">${esc(ui("loggedInAs", {volunteer}))}</p>` : ""}

  <div class="statusbar" style="margin-bottom:18px">
    <div><div class="n">${drafts.length}</div><div class="k">${esc(ui("statusDraft"))}</div></div>
    <div><div class="n">${pend.length}</div><div class="k">${esc(ui("statusReady"))}</div></div>
    <div><div class="n">${synced.length}</div><div class="k">${esc(ui("statusSynced"))}</div></div>
  </div>

  <button class="btn btn-primary btn-block" data-act="new" style="margin-bottom:12px">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    ${esc(ui("startNewAudit"))}
  </button>
  ${volunteer ? `
  <button class="btn btn-ghost btn-block" data-act="myroute" style="margin-bottom:22px">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 20l-5.5-2.5V4L9 6.5m0 13.5l6-3m-6-13.5l6 3m0 13.5l5.5 2.5V6l-5.5-2.5m0 16V3.5"/></svg>
    ${esc(ui("myRoute"))}
  </button>` : ""}

  <div class="row" style="margin-bottom:11px">
    <span class="eyebrow">${esc(ui("auditsOnDevice"))}</span>
    <span style="flex:1"></span>
    ${audits.length ? '<button class="backlink" data-act="export">' + esc(ui("exportAllJson")) + '</button>' : ""}
  </div>

  ${ordered.length ? '<div class="stack gap-10">' + ordered.map(a => {
      const st = statusOf(a), s = auditStats(a);
      return `
      <div class="audit-item" data-status="${st}" style="position:relative">
        <button class="audit-item-open" data-act="open" data-id="${a.id}" style="width:100%;text-align:left">
          <span class="spine"></span>
          <span class="body">
            <span class="row wrap" style="gap:8px">
              <span class="chip chip-${st}">${esc(statusLabel(st))}</span>
              ${a.test ? '<span class="chip chip-test">' + esc(ui("testChip")) + '</span>' : ""}
              ${s.issues ? '<span class="chip chip-draft" style="background:var(--issue-soft);color:var(--issue)">' + s.issues + ' ' + esc(noun("issue", s.issues)) + '</span>' : ""}
            </span>
            <span class="audit-title">${esc(locationLabel(a))} · ${esc(unitNameDisplay(a))}</span>
            <span class="audit-meta">
              <span>${esc(tr(AUDIT_TYPES[a.type].label))}</span>
              <span class="mono">${esc(a.date)}</span>
              <span class="mono">${esc(ui("answeredOfTotal", {answered:s.answered, total:s.total}))}</span>
            </span>
          </span>
        </button>
        <button class="audit-item-delete" data-act="deletehome" data-id="${a.id}" aria-label="${esc(ui("deleteBtn"))}" title="${esc(ui("deleteBtn"))}">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>
        </button>
      </div>`;
    }).join("") + "</div>"
    : `<div class="empty">
         <div style="font-family:var(--font-display);font-weight:600;color:var(--ink);margin-bottom:5px">${esc(ui("noAuditsYet"))}</div>
         <div class="small">${esc(ui("noAuditsHint"))}</div>
       </div>`}
  `;
}

/* ---------- AUDIT TYPE PICKER ---------- */
function screenPick(){
  const cards = Object.values(AUDIT_TYPES).map(t => {
    const n = t.available
      ? t.sections.reduce((s,sec) => s + sec.groups.reduce((x,g) => x + g[1].length, 0), 0)
      : 0;
    return `
    <button class="type-card ${t.available ? "" : "locked"}" ${t.available ? 'data-act="type" data-type="'+t.id+'"' : "disabled"}>
      <span class="glyph">${t.glyph}</span>
      <h2>${esc(tr(t.label))}</h2>
      <p>${esc(tr(t.blurb))}</p>
      <span class="n-items">${t.available ? esc(ui("checklistItemsCount", {n})) : esc(ui("comingLater"))}</span>
    </button>`;
  }).join("");

  return `
  <button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui("pickEyebrow"))}</span>
    <h1>${esc(ui("pickTitle"))}</h1>
    <p class="lede small">${esc(ui("pickLede"))}</p>
  </div>
  <div class="type-grid">${cards}</div>`;
}

/* ---------- SETUP ---------- */
function screenSetup(){
  const a = current();
  const def = AUDIT_TYPES[a.type];
  const isBath = a.type === "school_bathroom";
  const isWater = a.type === "water_point";

  const unitField = isWater ? "" : isBath
    ? `<label class="field"><span>${esc(tr(def.unitLabel))}</span>
         <select data-f="unitId">
           <option value="">${esc(ui("chooseOne"))}</option>
           ${BATHROOM_UNITS.map(u => `<option value="${u.id}" ${a.unitId===u.id?"selected":""}>${esc(tr(u.label))}</option>`).join("")}
         </select>
       </label>
       <p class="small muted" style="margin:-4px 0 0">${esc(ui("bathHint"))}</p>`
    : `<label class="field"><span>${esc(tr(def.unitLabel))}</span>
         <input type="text" data-f="unitName" list="bnames" placeholder="${esc(ui("unitNamePlaceholder"))}" value="${esc(a.unitName||"")}">
         <datalist id="bnames">${BUILDING_NAMES.map(n => `<option value="${esc(n)}"></option>`).join("")}</datalist>
       </label>
       <label class="field"><span>${esc(ui("buildingTypeLabel"))}</span>
         <select data-f="buildingType">
           ${BUILDING_TYPES.map(t => `<option value="${t.id}" ${a.buildingType===t.id?"selected":""}>${esc(tr(t.label))}</option>`).join("")}
         </select>
       </label>
       <p class="small muted" style="margin:-4px 0 0">${esc(ui("buildingTypeHint"))}</p>`;

  /* Ward -> Village -> Sub-Village (optional) -> Asset Tag, each
     option list filtered by whatever was picked upstream of it. */
  const wards = getWards();
  const villages = a.ward ? getVillages(a.ward) : [];
  const subVillages = (a.ward && a.village) ? getSubVillages(a.ward, a.village) : [];
  const assetOptions = (a.ward && a.village) ? getAssets(a.ward, a.village, a.subVillage) : [];
  const waterField = !isWater ? "" : `
      <label class="field"><span>${esc(ui("wardLabel"))}</span>
        <select data-f="ward">
          <option value="">${esc(ui("chooseOne"))}</option>
          ${wards.map(w => `<option value="${esc(w)}" ${a.ward===w?"selected":""}>${esc(w)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>${esc(ui("villageLabel"))}</span>
        <select data-f="village" ${a.ward?"":"disabled"}>
          <option value="">${esc(ui(a.ward ? "chooseOne" : "chooseWardFirst"))}</option>
          ${villages.map(v => `<option value="${esc(v)}" ${a.village===v?"selected":""}>${esc(v)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>${esc(ui("subVillageLabel"))}</span>
        <select data-f="subVillage" ${a.village?"":"disabled"}>
          <option value="">${esc(ui(subVillages.length ? "allSubVillages" : "noSubVillagesListed"))}</option>
          ${subVillages.map(sv => `<option value="${esc(sv)}" ${a.subVillage===sv?"selected":""}>${esc(sv)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>${esc(ui("assetTagLabel"))}</span>
        <select data-f="assetTag" ${a.village?"":"disabled"}>
          <option value="">${esc(ui(a.village ? "chooseOne" : "chooseVillageFirst"))}</option>
          ${assetOptions.map(as => `<option value="${esc(as.tag)}" ${a.assetTag===as.tag?"selected":""}>${esc(as.tag)}${as.loc ? " — " + esc(as.loc) : ""}</option>`).join("")}
        </select>
      </label>
      <p class="small muted" style="margin:-4px 0 0">${esc(ui("waterSetupHint"))}</p>`;

  const ready = locationReady(a) && a.inspector && a.date;

  return `
  <button class="backlink" data-act="pick" style="margin-bottom:14px">${esc(ui("changeAuditType"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui(isWater ? "setupEyebrowWater" : "setupEyebrow", {label: tr(def.label)}))}</span>
    <h1>${esc(ui("setupTitle"))}</h1>
  </div>

  <div class="card" style="padding:18px">
    <div class="stack gap-14">
      ${isWater ? "" : `<label class="field"><span>${esc(ui("schoolLabel"))}</span>
        <select data-f="school">
          <option value="">${esc(ui("chooseOne"))}</option>
          ${SCHOOLS.map(s => `<option value="${esc(s)}" ${a.school===s?"selected":""}>${esc(s)}</option>`).join("")}
        </select>
      </label>`}
      ${waterField}
      ${unitField}
      <label class="field"><span>${esc(ui("inspectorLabel"))}</span>
        <input type="text" data-f="inspector" placeholder="${esc(ui("inspectorPlaceholder"))}" value="${esc(a.inspector||"")}">
      </label>
      <label class="field"><span>${esc(ui("dateLabel"))}</span>
        <input type="date" data-f="date" value="${esc(a.date)}">
      </label>

      <div class="stack gap-6">
        <span style="font-size:12.5px;font-weight:600;color:var(--ink-2)">${esc(ui("locationOptional"))}</span>
        <div class="row wrap">
          <button class="mini ${a.gps?"on":""}" data-act="gps">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
            ${a.gps ? esc(ui("locationCaptured")) : esc(ui("captureGps"))}
          </button>
          ${a.gps ? `<span class="mono small muted">${a.gps.lat.toFixed(5)}, ${a.gps.lon.toFixed(5)} ±${Math.round(a.gps.acc)}m</span>` : ""}
        </div>
        ${gpsCheckLine(a)}
      </div>
    </div>
  </div>

  <button class="btn btn-primary btn-block" data-act="start" ${ready?"":"disabled"} style="margin-top:18px">
    ${esc(ui("openChecklist"))}
  </button>
  ${ready ? "" : '<p class="small muted" style="text-align:center;margin-top:9px">' + esc(ui(isWater ? "fillFieldsHintWater" : "fillFieldsHint")) + '</p>'}
  `;
}

/** One line under the GPS button comparing the fix to the register. */
function gpsCheckLine(a){
  if(!a.gps || a.type !== "water_point" || !a.assetTag) return "";
  const d = gpsDistanceToAsset(a);
  if(d == null) return `<p class="small muted" style="margin:0">${esc(ui("gpsNoRef", {tag: a.assetTag}))}</p>`;
  return d > GPS_WARN_METERS
    ? `<p class="small" style="margin:0;color:var(--issue);font-weight:600">${esc(ui("gpsDistanceFar", {dist: d, tag: a.assetTag}))}</p>`
    : `<p class="small" style="margin:0;color:var(--ok)">${esc(ui("gpsDistanceOk", {dist: d}))}</p>`;
}

/* ---------- BEFORE THE CHECKLIST: water + valve key ---------- */
/** One yes/no question card. `act` sets the answer (see the click
 * handler), `value` is the current answer (true/false/null). */
function precheckQuestion(title, hint, act, value, yesLabel, noLabel){
  const btn = (v, label) => {
    const on = value === (v === "yes");
    return `<button class="btn btn-block ${on ? "btn-primary" : "btn-ghost"}" data-act="${act}" data-v="${v}" aria-pressed="${on}">${esc(label)}</button>`;
  };
  return `
  <div class="card" style="padding:16px 18px;margin-bottom:14px">
    <h2 style="font-size:17px;margin:0 0 6px">${esc(title)}</h2>
    <p class="small muted" style="margin:0 0 12px">${esc(hint)}</p>
    <div class="row" style="gap:10px">${btn("yes", yesLabel)}${btn("no", noLabel)}</div>
  </div>`;
}
function screenPrecheck(){
  const a = current();
  const asset = findAsset(a.assetTag);
  const facts = [];
  if(asset){
    if(asset.structure === "F") facts.push(ui("registerFaucet"));
    facts.push(asset.hasPlaque ? ui("registerPlaque") : ui("registerNoPlaque"));
  }
  const ready = !unanswered(a.hasWater) && !unanswered(a.hasValveKey);
  return `
  <button class="backlink" data-act="backsetup" style="margin-bottom:14px">${esc(ui("backToSetup"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(locationLabel(a))} · ${esc(unitNameDisplay(a))}</span>
    <h1>${esc(ui("precheckTitle"))}</h1>
  </div>
  ${facts.length ? `<div class="banner banner-info" style="margin-bottom:16px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/></svg>
    <div>${esc(ui("registerSays"))} ${facts.map(esc).join(" · ")}</div>
  </div>` : ""}
  ${precheckQuestion(ui("waterQTitle"), ui("waterQHint"), "setwater", a.hasWater, ui("waterYes"), ui("waterNo"))}
  ${precheckQuestion(ui("keyQTitle"), ui("keyQHint"), "setkey", a.hasValveKey, ui("keyYes"), ui("keyNo"))}
  <button class="btn btn-primary btn-block" data-act="check" ${ready ? "" : "disabled"} style="margin-top:6px">${esc(ui("startChecklist"))}</button>
  ${ready ? "" : `<p class="small muted" style="text-align:center;margin-top:9px">${esc(ui("precheckAnswerBoth"))}</p>`}`;
}

/** Water answer (with a way to change it) plus how many items were
 * pre-filled and why — so nothing is pre-filled silently. */
function prefillBanner(a){
  if(a.type !== "water_point" || a.assetType === "T") return '<div id="prefillBanner"></div>';
  const autos = Object.values(a.answers || {}).filter(x => x && x.auto);
  const reasons = Array.from(new Set(autos.map(x => x.auto))).map(r => ui("prefillReason_" + r));
  const facts = [
    a.hasWater === false ? ui("waterStatusNo") : a.hasWater === true ? ui("waterStatusYes") : "",
    a.hasValveKey === false ? ui("keyStatusNo") : a.hasValveKey === true ? ui("keyStatusYes") : "",
  ].filter(Boolean);
  const water = facts.join(" · ");
  if(!water && !autos.length) return '<div id="prefillBanner"></div>';
  return `
  <div id="prefillBanner" class="banner ${autos.length ? "banner-warn" : "banner-info"}" style="margin-bottom:14px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3c3 4.5 5 7.4 5 10a5 5 0 0 1-10 0c0-2.6 2-5.5 5-10Z"/></svg>
    <div>
      ${water ? `<strong>${esc(water)}</strong> <button class="backlink" data-act="askwater" style="margin-left:4px">${esc(ui("changeWater"))}</button>` : ""}
      ${autos.length ? `<div style="margin-top:4px">${esc(ui("prefillBanner", {n: autos.length, reasons: reasons.join(", ")}))}</div>` : ""}
    </div>
  </div>`;
}

/* ---------- CHECKLIST ---------- */
function screenCheck(){
  const a = current();
  const secs = sectionsFor(a);
  const s = auditStats(a);
  const pct = s.total ? Math.round(s.answered / s.total * 100) : 0;

  let idx = 0;
  const ticks = [];
  const body = secs.map(sec => {
    const secItems = sec.groups.reduce((n,g) => n + g[1].length, 0);
    let secAnswered = 0;
    const groups = sec.groups.map(([group, statements]) => {
      const rows = statements.map((text, i) => {
        const key = sec.id + "/" + slug(group) + "/" + i;
        const ans = (a.answers || {})[key] || {};
        const v = ans.value || "";
        if(v) secAnswered++;
        ticks.push(`<button class="tally-tick${idx===0||ticks.length===0?"":""}" data-v="${v}" data-act="jump" data-key="${key}" title="${esc(tr(group))} ${esc(tr(text))}" aria-label="Go to item"></button>`);
        idx++;
        const hasExtra = v === "issue" || ans.note || (ans.photos||[]).length;
        return `
        <div class="item" data-key="${key}" data-v="${v}">
          <div class="item-main">
            <div class="item-text">${esc(tr(text))}${ans.auto ? ` <span class="auto-tag" title="${esc(ui("prefillReason_" + ans.auto))}">${esc(ui("prefillTag"))}</span>` : ""}</div>
            <div class="seg" role="group" aria-label="${esc(tr(group) + " " + tr(text))}">
              <button class="v-ok"    data-act="ans" data-key="${key}" data-v="ok"    aria-pressed="${v==="ok"}">${esc(ui("ansOk"))}</button>
              <button class="v-issue" data-act="ans" data-key="${key}" data-v="issue" aria-pressed="${v==="issue"}">${esc(ui("ansIssue"))}</button>
              <button class="v-na"    data-act="ans" data-key="${key}" data-v="na"    aria-pressed="${v==="na"}">${esc(ui("ansNa"))}</button>
            </div>
          </div>
          <div class="item-extra ${hasExtra ? "" : "hidden"}">
            <textarea data-note="${key}" placeholder="${esc(ui("notePlaceholder"))}">${esc(ans.note||"")}</textarea>
            ${v === "issue" && !(ans.note||"").trim() ? '<div class="note-hint">' + esc(ui("noteHint")) + '</div>' : ""}
            <div class="attach-row">
              <label class="mini">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 17V8a2 2 0 0 0-2-2h-2.2l-1-1.6h-5.6L8.2 6H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2Z"/><circle cx="12" cy="12.5" r="3"/></svg>
                ${esc(ui("takePhoto"))}
                <input type="file" accept="image/*" capture="environment" data-photo="${key}" class="sr">
              </label>
              <label class="mini">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                ${esc(ui("chooseFromGallery"))}
                <input type="file" accept="image/*" data-photo="${key}" class="sr">
              </label>
              ${(ans.photos||[]).length ? `<span class="mono small muted">${ans.photos.length} ${esc(noun("photo", ans.photos.length))}</span>` : ""}
            </div>
            ${(ans.photos||[]).length ? `<div class="thumbs">${ans.photos.map((p,pi) =>
              `<span class="thumb"><img src="${p}" alt="${esc(ui("evidencePhotoAlt"))}"><button data-act="rmphoto" data-key="${key}" data-i="${pi}" aria-label="${esc(ui("removePhotoAria"))}">×</button></span>`
            ).join("")}</div>` : ""}
          </div>
        </div>`;
      }).join("");
      return `<div class="group">
        <div class="group-head">
          <div class="group-name">${esc(tr(group))}</div>
          <button class="allok" data-act="allok" data-sec="${sec.id}" data-group="${esc(slug(group))}" data-n="${statements.length}">${esc(ui("allOk"))}</button>
        </div>${rows}</div>`;
    }).join("");

    return `
    <section class="section" id="sec-${sec.id}">
      <div class="section-head">
        <h2>${esc(tr(sec.title))}</h2>
        <span class="cnt">${secAnswered}/${secItems}</span>
        <button class="allok" data-act="restok" data-sec="${sec.id}">${esc(ui("restOk"))}</button>
      </div>
      ${sec.note ? `<p class="section-note">${esc(tr(sec.note))}</p>` : ""}
      ${groups}
    </section>`;
  }).join("");

  const nav = secs.map(sec =>
    `<button class="mini" data-act="goto" data-sec="${sec.id}">${esc(tr(sec.title))}</button>`
  ).join("");

  return `
  <div class="ctx">
    <div class="ctx-head">
      <span class="ctx-titles">
        <span class="ctx-title">${esc(locationLabel(a))} · ${esc(unitNameDisplay(a))}</span>
        <span class="ctx-sub">${esc(tr(AUDIT_TYPES[a.type].label))} · ${esc(a.date)}</span>
      </span>
      <button class="backlink" data-act="backdiscard" style="flex:none">${esc(ui("backDiscard"))}</button>
      <button class="backlink" data-act="home" style="flex:none">${esc(ui("saveAndClose"))}</button>
    </div>
    <div class="tally" aria-hidden="true">${ticks.join("")}</div>
    <div class="progress-line"><i style="width:${pct}%"></i></div>
  </div>

  <div class="banner banner-info" style="margin-bottom:14px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    <div>${ui("checkBanner")}</div>
  </div>
  ${prefillBanner(a)}

  <div class="row wrap" style="gap:7px;margin-bottom:18px">${nav}</div>

  ${body}`;
}

function barCheck(){
  const a = current(), s = auditStats(a);
  const pct = s.total ? Math.round(s.answered / s.total * 100) : 0;
  const done = s.answered === s.total;
  return `
  <div class="bottombar"><div class="bottombar-inner">
    <div class="meter">
      <div class="t">${esc(ui("answeredIssuesLine", {answered:s.answered, total:s.total, issues:s.issues, issueWord: noun("issue", s.issues)}))}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    ${done ? "" : '<button class="btn btn-ghost" data-act="nextgap">' + esc(ui("nextBlank")) + '</button>'}
    <button class="btn ${done?"btn-primary":"btn-ghost"}" data-act="review">${esc(ui("reviewArrow"))}</button>
  </div></div>`;
}

/* ---------- REVIEW ---------- */
function screenReview(){
  const a = current();
  const s = auditStats(a);
  const missing = s.total - s.answered;
  const findings = s.items
    .map(it => ({it, ans:(a.answers||{})[it.key]}))
    .filter(x => x.ans && x.ans.value === "issue");

  const isWater = a.type === "water_point";
  const locationKv = isWater
    ? `<dt>${esc(ui("kvWard"))}</dt><dd>${esc(a.ward||"—")}</dd>
       <dt>${esc(ui("kvVillage"))}</dt><dd>${esc(a.village||"—")}</dd>
       <dt>${esc(ui("kvSubVillage"))}</dt><dd>${esc(a.subVillage||"—")}</dd>
       <dt>${esc(ui("kvAssetTag"))}</dt><dd class="mono">${esc(a.assetTag||"—")}</dd>
       <dt>${esc(ui("kvAssetType"))}</dt><dd>${esc(tr(a.assetType==="T" ? "Water Tank" : "Water Point"))}</dd>`
    : `<dt>${esc(ui("kvSchool"))}</dt><dd>${esc(a.school)}</dd>
       <dt>${esc(ui("kvUnit"))}</dt><dd>${esc(unitNameDisplay(a))}</dd>`;

  return `
  <button class="backlink" data-act="check" style="margin-bottom:14px">${esc(ui("backToChecklist"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui(isWater ? "reviewEyebrowWater" : "reviewEyebrow"))}</span>
    <h1>${esc(ui("reviewTitle"))}</h1>
  </div>

  <div class="card" style="padding:16px 18px;margin-bottom:16px">
    <dl class="kv">
      <dt>${esc(ui("kvAudit"))}</dt><dd>${esc(tr(AUDIT_TYPES[a.type].label))}</dd>
      ${locationKv}
      <dt>${esc(ui("kvInspector"))}</dt><dd>${esc(a.inspector)}</dd>
      <dt>${esc(ui("kvDate"))}</dt><dd class="mono">${esc(a.date)}</dd>
      ${a.gps ? `<dt>${esc(ui("kvGps"))}</dt><dd class="mono">${a.gps.lat.toFixed(5)}, ${a.gps.lon.toFixed(5)}</dd>` : ""}
      ${gpsDistanceToAsset(a) != null ? `<dt>${esc(ui("kvGpsDistance"))}</dt><dd class="mono" style="${gpsDistanceToAsset(a) > GPS_WARN_METERS ? "color:var(--issue);font-weight:600" : ""}">${gpsDistanceToAsset(a)} m</dd>` : ""}
      ${isWater && a.assetType !== "T" && a.hasWater != null ? `<dt>${esc(ui("kvWater"))}</dt><dd>${esc(ui(a.hasWater ? "yes" : "no"))}</dd>` : ""}
      ${isWater && a.assetType !== "T" && a.hasValveKey != null ? `<dt>${esc(ui("kvValveKey"))}</dt><dd>${esc(ui(a.hasValveKey ? "yes" : "no"))}</dd>` : ""}
      <dt>${esc(ui("kvRecord"))}</dt><dd class="mono">${esc(a.id)}</dd>
    </dl>
  </div>

  <div class="statusbar" style="margin-bottom:16px">
    <div><div class="n">${s.answered}</div><div class="k">${esc(ui("answeredLabel"))}</div></div>
    <div><div class="n" style="color:var(--issue)">${s.issues}</div><div class="k">${esc(ui("issuesFoundLabel"))}</div></div>
    <div><div class="n" style="color:${missing?"var(--issue)":"var(--ok)"}">${missing}</div><div class="k">${esc(ui("unansweredLabel"))}</div></div>
  </div>

  ${missing ? `<div class="banner banner-warn" style="margin-bottom:16px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>
      <div><strong>${esc(ui("unansweredWarnStrong", {n:missing, itemWord: noun("item", missing)}))}</strong> ${esc(ui("unansweredWarnRest"))} <button class="backlink" data-act="nextgap" style="margin-left:2px">${esc(ui("goToNextUnanswered"))}</button></div>
    </div>` : `<div class="banner banner-info" style="margin-bottom:16px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      <div>${esc(ui("allAnsweredInfo"))} ${s.issues === 0 ? esc(ui("noIssuesGood")) : esc(ui("checkFindingsBelow"))}</div>
    </div>`}

  <div class="row" style="margin-bottom:10px"><span class="eyebrow">${esc(ui("findingsToReport"))}</span></div>
  ${findings.length ? `<div class="card">${findings.map(({it,ans}) => `
      <div class="finding">
        <span class="sev"></span>
        <div class="fbody">
          <div class="fpath">${esc(tr(it.sectionTitle))} · ${esc(tr(it.group))}</div>
          <div class="ftext">${esc(tr(it.text))}</div>
          ${ans.note ? `<div class="fnote">${esc(ans.note)}</div>` : '<div class="fnote muted"><em>' + esc(ui("noNoteAdded")) + '</em></div>'}
          ${(ans.photos||[]).length ? `<div class="fthumbs">${ans.photos.map(p => `<img src="${p}" alt="${esc(ui("evidencePhotoAlt"))}">`).join("")}</div>` : ""}
        </div>
      </div>`).join("")}</div>`
    : `<div class="empty small">${esc(ui("noIssuesRecorded"))}</div>`}

  <div class="row" style="margin:20px 0 10px"><span class="eyebrow">${esc(ui("generalCommentsLabel"))}</span></div>
  <div class="card" style="padding:14px 16px">
    <textarea data-f="comment" placeholder="${esc(ui("generalCommentsPlaceholder"))}" style="min-height:90px">${esc(a.comment||"")}</textarea>
  </div>

  <div class="row" style="margin:20px 0 10px"><span class="eyebrow">${esc(ui("sitePhotoLabel"))}</span></div>
  <div class="card" style="padding:14px 16px">
    <p class="small muted" style="margin:0 0 10px">${esc(ui("sitePhotoHint"))}</p>
    <div class="attach-row">
      <label class="mini">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 17V8a2 2 0 0 0-2-2h-2.2l-1-1.6h-5.6L8.2 6H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2Z"/><circle cx="12" cy="12.5" r="3"/></svg>
        ${esc(ui("takePhoto"))}
        <input type="file" accept="image/*" capture="environment" data-sitephoto="1" class="sr">
      </label>
      <label class="mini">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        ${esc(ui("chooseFromGallery"))}
        <input type="file" accept="image/*" data-sitephoto="1" class="sr">
      </label>
    </div>
    ${a.sitePhoto ? `<div class="thumbs"><span class="thumb"><img src="${a.sitePhoto}" alt="${esc(ui("evidencePhotoAlt"))}"><button data-act="rmsitephoto" aria-label="${esc(ui("removePhotoAria"))}">×</button></span></div>` : ""}
  </div>
  `;
}

function barReview(){
  const a = current();
  const done = !!a.completedAt;
  const s = auditStats(a);
  const missing = s.total - s.answered;
  return `
  <div class="bottombar"><div class="bottombar-inner">
    <button class="btn btn-ghost" data-act="delete">${esc(ui("deleteBtn"))}</button>
    <span style="flex:1"></span>
    ${done
      ? `<span class="chip chip-ready">${esc(ui("chipReadyToSync"))}</span><button class="btn btn-primary" data-act="sync">${esc(ui("goToSync"))}</button>`
      : `<button class="btn btn-primary" data-act="complete" ${missing ? "disabled" : ""} title="${missing ? esc(ui("itemsNeedAnswerTitle", {n:missing, itemWord: noun("item", missing)})) : ""}">${esc(ui("finishAudit"))}</button>`}
  </div></div>`;
}

/* ---------- SYNC ---------- */
let syncLog = [];
// navigator.storage.estimate() is async, but screenSync() has to return a
// string synchronously — so the tile shows this cached value (refreshed
// every time the Sync screen renders) rather than blocking on it.
let storageEstimateMB = null;
let storageEstimateInFlight = false;
function refreshStorageEstimate(){
  if(storageEstimateInFlight) return;
  storageEstimateInFlight = true;
  estimateUsage().then(est => {
    storageEstimateInFlight = false;
    if(!est || est.usage == null) return;
    const mb = (est.usage / (1024 * 1024)).toFixed(1);
    // Only re-render on an actual change — screenSync() calls this on
    // every render, so re-rendering unconditionally here would retrigger
    // itself forever instead of settling once the value is known.
    if(mb !== storageEstimateMB){
      storageEstimateMB = mb;
      if(state.screen === "sync") render();
    }
  }).catch(() => { storageEstimateInFlight = false; });
}
function screenSync(){
  const pend = pendingList();
  const online = navigator.onLine;
  refreshStorageEstimate();
  const mb = storageEstimateMB == null ? "—" : storageEstimateMB;

  return `
  <button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui("syncEyebrow"))}</span>
    <h1>${esc(ui("syncTitle"))}</h1>
    <p class="lede small">${esc(ui("syncLede"))}</p>
  </div>

  ${authUser() ? `<button class="btn btn-primary btn-block" data-act="myroute" style="margin-bottom:16px">${esc(ui("backToRouteList"))}</button>`
    : `<div class="banner banner-warn" style="margin-bottom:12px"><div>${esc(ui("syncErrSignedOut"))}</div></div>
       <button class="btn btn-primary btn-block" data-act="gologin" style="margin-bottom:16px">${esc(ui("signInButton"))}</button>`}

  <div class="banner banner-info" style="margin-bottom:16px">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      ${online ? '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>'
               : '<path d="M3 3l18 18M5 12.5a10 10 0 0 1 6-2.9M19 12.5a10 10 0 0 0-3-2.3"/><circle cx="12" cy="19" r="1"/>'}
    </svg>
    <div>${online ? esc(ui("syncOnlineBanner")) : esc(ui("syncOfflineBanner"))}</div>
  </div>

  <div class="statusbar" style="margin-bottom:16px">
    <div><div class="n">${pend.length}</div><div class="k">${esc(ui("queuedLabel"))}</div></div>
    <div><div class="n">${audits.filter(a => a.syncedAt).length}</div><div class="k">${esc(ui("sentLabel"))}</div></div>
    <div><div class="n">${esc(mb)}</div><div class="k">${esc(ui("mbOnDevice"))}</div></div>
  </div>

  ${pend.length ? `<div class="stack gap-10" style="margin-bottom:16px">${pend.map(a => {
      const s = auditStats(a);
      return `<div class="card" style="padding:12px 14px">
        <div class="row wrap" style="gap:8px;margin-bottom:5px">
          <span class="chip chip-ready">${esc(ui("chipQueued"))}</span>
          ${s.issues ? `<span class="chip" style="background:var(--issue-soft);color:var(--issue)">${s.issues} ${esc(noun("issue", s.issues))}</span>` : ""}
        </div>
        <div class="audit-title">${esc(locationLabel(a))} · ${esc(unitNameDisplay(a))}</div>
        <div class="audit-meta"><span>${esc(tr(AUDIT_TYPES[a.type].label))}</span><span class="mono">${esc(a.date)}</span><span class="mono">${esc(a.id)}</span></div>
      </div>`;
    }).join("")}</div>` : `<div class="empty small" style="margin-bottom:16px">${esc(ui("nothingQueued"))}</div>`}

  <div class="row wrap" style="gap:10px;margin-bottom:16px">
    <button class="btn btn-primary" data-act="dosync" ${!pend.length ? "disabled" : ""}>
      ${esc(ui("syncNAudits", {n: pend.length, auditWord: noun("audit", pend.length)}))}
    </button>
    <button class="btn btn-ghost" data-act="export">${esc(ui("exportJson"))}</button>
  </div>

  ${syncLog.length ? `<div class="stack gap-6"><span class="eyebrow">${esc(ui("logLabel"))}</span><div class="log">${esc(syncLog.join("\n"))}</div></div>` : ""}`;
}

/* ==================================================================
   ACTIONS
   ================================================================== */
function setAnswer(key, v){
  const a = current();
  a.answers = a.answers || {};
  const cur = a.answers[key] || {};
  cur.value = (cur.value === v) ? "" : v;
  delete cur.auto; delete cur.autoNote;   // it's the auditor's answer now, not a pre-fill
  a.answers[key] = cur;
  a.updatedAt = new Date().toISOString();
  persist();
  patchItem(key);
  $("#bottom").innerHTML = barCheck();
  refreshCounts();
  const pb = $("#prefillBanner");
  if(pb) pb.outerHTML = prefillBanner(a);
}

/* Re-render one item row + its tally tick, so the page never jumps. */
function patchItem(key){
  const a = current();
  const ans = (a.answers||{})[key] || {};
  const v = ans.value || "";
  const row = document.querySelector('.item[data-key="' + cssEsc(key) + '"]');
  if(row){
    row.dataset.v = v;
    if(!ans.auto){ const tag = row.querySelector(".auto-tag"); if(tag) tag.remove(); }
    row.querySelectorAll(".seg button").forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === v));
    });
    const extra = row.querySelector(".item-extra");
    const hasExtra = v === "issue" || ans.note || (ans.photos||[]).length;
    extra.classList.toggle("hidden", !hasExtra);
    const hint = extra.querySelector(".note-hint");
    const needHint = v === "issue" && !(ans.note||"").trim();
    if(needHint && !hint){
      const d = document.createElement("div");
      d.className = "note-hint";
      d.textContent = ui("noteHint");
      extra.querySelector("textarea").after(d);
    }else if(!needHint && hint){ hint.remove(); }
  }
  const tick = document.querySelector('.tally-tick[data-key="' + cssEsc(key) + '"]');
  if(tick) tick.dataset.v = v;
}
function cssEsc(s){ return s.replace(/["\\]/g, "\\$&"); }

function refreshCounts(){
  const a = current();
  const secs = sectionsFor(a);
  secs.forEach(sec => {
    const el = document.querySelector("#sec-" + sec.id + " .cnt");
    if(!el) return;
    let tot = 0, ans = 0;
    sec.groups.forEach(([group, statements]) => {
      statements.forEach((t,i) => {
        tot++;
        const val = ((a.answers||{})[sec.id + "/" + slug(group) + "/" + i] || {}).value;
        if(val) ans++;
      });
    });
    el.textContent = ans + "/" + tot;
  });
  const s = auditStats(a);
  const line = document.querySelector(".progress-line > i");
  if(line) line.style.width = (s.total ? Math.round(s.answered/s.total*100) : 0) + "%";
}

// Tuned down from 900px/0.55 (2026-09-24): with photos never leaving
// localStorage until Sync (see doSync()'s post-sync photo swap below), a
// device that goes a while between syncs can still fill its quota on
// today's higher-megapixel phone cameras. 720px/0.5 still keeps checklist
// evidence (cracks, leaks, corrosion) legible while cutting file size
// roughly a third further.
function shrinkImage(file, cb){
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function(){
    const max = 720;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    cb(c.toDataURL("image/jpeg", 0.5));
  };
  img.onerror = function(){ URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

function newAudit(type){
  const a = {
    id: uid(), type,
    school: pref("lastSchool") || "",
    unitName: "", unitId: "", buildingType: "classroom",
    // Water point fields. Ward/Village carry over from the last audit
    // started on this device — volunteers usually work their way through
    // several assets in the same village — but Sub-Village and Asset Tag
    // never do, so nobody accidentally logs a checklist against the
    // wrong asset.
    ward: pref("lastWard") || "", village: pref("lastVillage") || "",
    subVillage: "", assetTag: "", assetType: "", assetLocation: "",
    // The volunteer already identified themselves before reaching Home
    // (see the "Who are you?" screen) — no reason to make them type their
    // own name again here. lastInspector is only a fallback for the
    // unlikely case a device somehow has no volunteer pref set.
    inspector: (authUser() || {}).name || pref("lastInspector") || "",
    date: today(), gps: null,
    answers: {}, sitePhoto: null, hasWater: null, hasValveKey: null, test: testMode(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: null, syncedAt: null
  };
  audits.unshift(a);
  persist();
  state = {screen:"setup", id:a.id};
  render();
}

/** Tapping a stop on "My route": resume that asset's unfinished audit if
 * one already exists on this device, otherwise start a fresh one with
 * Ward/Village/Sub-Village/Asset Tag pre-filled from the route data (the
 * volunteer only has Inspector name + date left to confirm on Setup). */
function openOrStartAsset(tag){
  const existing = audits.find(a => a.type === "water_point" && a.assetTag === tag && !a.completedAt && inCurrentMode(a));
  if(existing){
    state = {screen: setupStarted(existing) ? checklistScreenFor(existing) : "setup", id: existing.id};
    render();
    return;
  }
  const asset = findAsset(tag);
  const a = {
    id: uid(), type: "water_point",
    school: "", unitName: "", unitId: "", buildingType: "classroom",
    ward: asset ? asset.ward : "", village: asset ? asset.village : "",
    subVillage: asset ? asset.sub : "", assetTag: tag,
    assetType: asset ? asset.type : "", assetLocation: asset ? asset.loc : "",
    // The volunteer already identified themselves before reaching Home
    // (see the "Who are you?" screen) — no reason to make them type their
    // own name again here. lastInspector is only a fallback for the
    // unlikely case a device somehow has no volunteer pref set.
    inspector: (authUser() || {}).name || pref("lastInspector") || "",
    date: today(), gps: null,
    answers: {}, sitePhoto: null, hasWater: null, hasValveKey: null, test: testMode(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: null, syncedAt: null,
  };
  audits.unshift(a);
  persist();
  state = {screen:"setup", id:a.id};
  render();
}

/** Is this audit's location/unit fully picked? (Ready to open the checklist.) */
function locationReady(a){
  if(a.type === "water_point") return !!(a.ward && a.village && a.assetTag);
  if(a.type === "school_bathroom") return !!(a.school && a.unitId);
  return !!(a.school && a.unitName);
}
/** Has setup been started at all, for deciding which screen "open" lands on. */
function setupStarted(a){
  return a.type === "water_point" ? !!a.assetTag : !!a.school;
}


/** Package one audit's data + photos into one JSON-serializable record. */
function auditRecord(a){
  const s = auditStats(a);
  const checklist = s.items.map(it => {
    const ans = (a.answers||{})[it.key] || {};
    return {
      section: it.sectionTitle, group: it.group, statement: it.text,
      value: ans.value || "", note: ans.note || "",
      auto: ans.auto || "",      // pre-fill reason if the auditor left a pre-filled answer as-is
      photos: ans.photos || []   // data: URLs, embedded inline
    };
  });
  return {
    id: a.id, type: a.type, typeLabel: AUDIT_TYPES[a.type].label,
    school: a.school || "", unit: unitName(a), buildingType: a.buildingType || null,
    // Water point fields — empty string (not null) for non-water audits,
    // so the sync backend can always write a consistent column shape.
    ward: a.ward || "", village: a.village || "", subVillage: a.subVillage || "",
    assetTag: a.assetTag || "", assetType: a.assetType === "T" ? "Water Tank" : (a.assetType === "P" ? "Water Point" : ""),
    location: a.assetLocation || "",
    inspector: a.inspector, date: a.date, gps: a.gps || null,
    createdAt: a.createdAt, completedAt: a.completedAt,
    answeredCount: s.answered, totalCount: s.total, issueCount: s.issues,
    comment: a.comment || "",
    hasWater: a.hasWater === true ? true : a.hasWater === false ? false : null,
    hasValveKey: a.hasValveKey === true ? true : a.hasValveKey === false ? false : null,
    gpsDistanceM: gpsDistanceToAsset(a),
    test: !!a.test,
    sitePhoto: a.sitePhoto || null,   // data: URL, embedded inline — see checklist photos above
    checklist
  };
}

/* ==================================================================
   SYNC  — posts each queued audit to /api/sync (Node function on this
   same deployment), which uploads photos to Drive and appends rows to
   the results spreadsheet using a service account. No per-volunteer
   Google login needed. Falls back to a local JSON download so data is
   never trapped on one phone even if the network step fails.
   ================================================================== */
function downloadJson(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url; el.download = filename;
  document.body.appendChild(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportJson(){
  downloadJson("karimu-audits-export.json", {
    exportedAt: new Date().toISOString(),
    audits: audits.map(auditRecord)
  });
}

/** Testing/reset tool: wipe every trace of this app on this device — the
 * audits list, saved preferences (language, last ward/village/inspector),
 * and the service-worker cache — then reload to a clean first-run state.
 * Only touches this device's own storage; other volunteers' devices and
 * anything already synced to the sheet are unaffected. */
async function resetAppData(){
  try{ await wipeAll(); }catch(e){}
  try{ localStorage.removeItem(KEY); }catch(e){}
  try{ localStorage.removeItem(PREF); }catch(e){}
  try{
    if("serviceWorker" in navigator){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  }catch(e){}
  try{
    if(window.caches && caches.keys){
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  }catch(e){}
  location.reload();
}

/** POST one audit to the server. Never throws — returns {ok, code?, message?}. */
async function syncOne(audit){
  try{
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: {"Content-Type":"application/json", Authorization: "Bearer " + (authToken() || "")},
      body: JSON.stringify({audit})
    });
    const body = await res.json().catch(() => ({}));
    if(res.ok && body.ok) return {ok:true, ...body};
    return {ok:false, code: body.code || ("http_" + res.status), message: body.message || ui("serverRejected")};
  }catch(err){
    return {ok:false, code:"network_error", message: err.message || ui("couldNotReachServer")};
  }
}

async function doSync(){
  syncLog = [];
  const stamp = () => new Date().toISOString().replace("T"," ").slice(0,19);
  render();

  // Test audits never leave the device, whatever mode the app is in now —
  // "syncing" one just marks it done locally. No network involved, so this
  // works offline too.
  pendingList().filter(a => a.test).forEach(a => {
    a.syncedAt = new Date().toISOString();
    syncLog.push("[" + stamp() + "] " + locationLabel(a) + " / " + unitNameDisplay(a) + " — " + ui("syncTestSimulated"));
  });
  persist();

  const real = pendingList().filter(a => !a.test);
  if(testMode()){
    if(real.length) syncLog.push("[" + stamp() + "] " + ui("syncHeldTestMode", {n: real.length, itemWord: noun("audit", real.length)}));
    render();
    return;
  }
  const pend = real;

  if(pend.length && !authToken()){
    syncLog.push("[" + stamp() + "] " + ui("syncErrSignedOut"));
    render();
    return;
  }
  if(pend.length && !navigator.onLine){
    syncLog.push("[" + stamp() + "] " + ui("syncNoConnection"));
    render();
    return;
  }

  let sent = 0, failed = 0, hardStop = false;

  for(const a of pend){
    if(hardStop) break;
    const s = auditStats(a);
    const nPhotos = s.items.reduce((n,it) => n + (((a.answers||{})[it.key]||{}).photos||[]).length, 0);
    syncLog.push("[" + stamp() + "] Sending " + locationLabel(a) + " / " + unitNameDisplay(a) + " (" + s.issues + " " + noun("issue", s.issues) + ", " + nPhotos + " " + noun("photo", nPhotos) + ")…");
    render();

    const res = await syncOne(auditRecord(a));

    if(res.ok){
      a.syncedAt = new Date().toISOString();
      // Free the space: the server just uploaded every photo to Blob
      // storage and handed back its URL for each checklist item, in the
      // same order sent (see auditRecord()/blobStore.saveAudit). Swap the
      // heavy base64 payloads for those tiny URLs so a synced audit's
      // photos stop taking up localStorage — this is the actual "cache
      // full" fix, since without it a synced audit keeps its full-size
      // photos on the device forever. Review screen keeps working the
      // same either way: it just uses each photo entry as an <img src>.
      if(Array.isArray(res.photosByItem)){
        s.items.forEach((it, i) => {
          const urls = res.photosByItem[i];
          const ans = (a.answers || {})[it.key];
          if(urls && ans) ans.photos = urls;
        });
      }
      // Same swap for the one-off site photo (see auditRecord()) — it
      // isn't part of the checklist array, so it travels as its own
      // field/response value instead of through photosByItem.
      if(res.sitePhotoUrl) a.sitePhoto = res.sitePhotoUrl;
      persist();
      sent++;
      syncLog.push("[" + stamp() + "] " + ui("syncSentLine", {photos: res.photosUploaded||0, findings: res.findingsWritten||0}));
    }else{
      failed++;
      const friendly = {
        not_configured: ui("syncErrNotConfigured"),
        network_error: ui("syncErrNetwork"),
        upstream_error: ui("syncErrUpstream", {message: res.message||""}),
        bad_request: ui("syncErrBadRequest"),
        signed_out: ui("syncErrSignedOut")
      }[res.code] || (res.message || ui("syncErrUnknown"));
      syncLog.push("[" + stamp() + "] " + ui("syncNotSentLine", {reason: friendly}));
      if(res.code === "network_error" || res.code === "not_configured" || res.code === "signed_out") hardStop = true; // no point hammering a dead endpoint
      // Token rejected (account deactivated / password reset): sign the
      // device out; the queued audits stay and go after signing in again.
      if(res.code === "signed_out") signOut();
    }
    render();
  }

  if(failed && sent === 0){
    syncLog.push("[" + stamp() + "] " + ui("syncNothingThrough"));
  }
  syncLog.push("[" + stamp() + "] " + ui("syncDoneLine", {sent, failed}));
  render();
}

/* ==================================================================
   MOUNT — attaches all event listeners and does the first render.
   Call once, after the page's static HTML skeleton exists in the DOM.
   ================================================================== */
let mounted = false;
export async function mount(){
  if(mounted) return;
  mounted = true;

  // Everything below reads `audits`/pref() synchronously, so the async
  // IndexedDB load (and one-time localStorage migration) has to finish
  // first — see boot() and the STORAGE block up top.
  await boot();

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-act]");
    if(!t) return;
    const act = t.dataset.act;
    // Defense in depth: one bad tap must never leave every button on the
    // page silently unresponsive. A screen that fails to build itself is
    // one thing (see the route-map fix above for a case that used to do
    // exactly that); this catch is the backstop for any handler crashing
    // for a reason we haven't hit yet, especially with the flaky
    // connectivity this app has to run on.
    try{

    if(act === "home"){ state = {screen:"home", id:null}; render(); }
    else if(act === "new"){
      // Only one audit type is active right now (water_point) — skip
      // straight past the picker instead of showing a screen full of
      // locked cards. Re-enable more types and this goes back to always
      // showing "pick" on its own.
      const avail = Object.values(AUDIT_TYPES).filter(x => x.available);
      if(avail.length === 1){ newAudit(avail[0].id); }
      else { state.screen = "pick"; render(); }
    }
    else if(act === "pick"){ state.screen = "pick"; render(); }
    else if(act === "type"){ newAudit(t.dataset.type); }
    else if(act === "open"){
      const a = audits.find(x => x.id === t.dataset.id);
      state = {screen: a.completedAt ? "review" : (setupStarted(a) ? checklistScreenFor(a) : "setup"), id:a.id};
      render();
    }
    else if(act === "start"){
      const a = current();
      pref("lastSchool", a.school); pref("lastInspector", a.inspector);
      if(a.type === "water_point"){ pref("lastWard", a.ward); pref("lastVillage", a.village); }
      state.screen = checklistScreenFor(a); render();
    }
    else if(act === "setwater" || act === "setkey"){
      // Pre-fill is applied on every answer (it's idempotent), not only on
      // "Start checklist" — so an audit closed right after answering still
      // opens with the right pre-fills.
      const a = current();
      a[act === "setwater" ? "hasWater" : "hasValveKey"] = t.dataset.v === "yes";
      applyPrefill(a);
      persist(); render();
    }
    else if(act === "askwater"){ state.screen = "precheck"; render(); }
    else if(act === "backsetup"){ state.screen = "setup"; render(); }
    else if(act === "toggletest"){
      if(testMode()){
        const tests = audits.filter(a => a.test);
        if(tests.length && confirm(ui("confirmDeleteTestAudits", {n: tests.length, itemWord: noun("audit", tests.length)}))){
          audits = audits.filter(a => !a.test);
          persist();
        }
        pref("testMode", false);
      }else{
        pref("testMode", true);
      }
      render();
    }
    else if(act === "check"){ state.screen = "check"; render(); }
    else if(act === "review"){ state.screen = "review"; render(); }
    else if(act === "complete"){
      const a = current();
      a.completedAt = new Date().toISOString();
      persist(); state.screen = "sync"; render();
    }
    else if(act === "delete"){
      if(confirm(ui("confirmDelete"))){
        audits = audits.filter(x => x.id !== state.id);
        persist(); state = {screen:"home", id:null}; render();
      }
    }
    else if(act === "deletehome"){ deleteAuditFromHome(t.dataset.id); }
    else if(act === "backdiscard"){
      if(confirm(ui("confirmBackDiscard"))){
        audits = audits.filter(x => x.id !== state.id);
        persist(); state = {screen:"home", id:null}; render();
      }
    }
    else if(act === "sync"){ state.screen = "sync"; render(); }
    else if(act === "dosync"){ doSync(); }
    else if(act === "export"){ exportJson(); }
    else if(act === "ans"){ setAnswer(t.dataset.key, t.dataset.v); }
    else if(act === "allok"){
      const a = current();
      a.answers = a.answers || {};
      const n = Number(t.dataset.n);
      for(let i = 0; i < n; i++){
        const key = t.dataset.sec + "/" + t.dataset.group + "/" + i;
        const cur = a.answers[key] = a.answers[key] || {};
        // Leave pre-filled answers alone — "All OK" on Faucets shouldn't
        // quietly undo "no water" or "faucet only".
        if(cur.value !== "issue" && !cur.auto) cur.value = "ok";
      }
      a.updatedAt = new Date().toISOString();
      persist(); render();
    }
    else if(act === "restok"){
      const a = current();
      a.answers = a.answers || {};
      sectionsFor(a).filter(s => s.id === t.dataset.sec).forEach(sec => {
        sec.groups.forEach(([group, statements]) => {
          statements.forEach((txt, i) => {
            const key = sec.id + "/" + slug(group) + "/" + i;
            const cur = a.answers[key] = a.answers[key] || {};
            if(!cur.value) cur.value = "ok";
          });
        });
      });
      a.updatedAt = new Date().toISOString();
      persist(); render();
    }
    else if(act === "goto"){
      const el = document.getElementById("sec-" + t.dataset.sec);
      if(el) el.scrollIntoView({block:"start", behavior:"smooth"});
    }
    else if(act === "nextgap"){
      const a = current();
      const items = buildItems(a);
      const gap = items.find(it => !((a.answers||{})[it.key]||{}).value);
      state.screen = "check"; render();
      if(gap){
        requestAnimationFrame(() => {
          const row = document.querySelector('.item[data-key="' + cssEsc(gap.key) + '"]');
          if(row){
            row.scrollIntoView({block:"center", behavior:"smooth"});
            row.animate([{background:"var(--accent-soft)"},{background:"transparent"}], {duration:1200});
          }
        });
      }
    }
    else if(act === "jump"){
      const row = document.querySelector('.item[data-key="' + cssEsc(t.dataset.key) + '"]');
      if(row){
        row.scrollIntoView({block:"center", behavior:"smooth"});
        row.animate([{background:"var(--accent-soft)"},{background:"transparent"}], {duration:900});
      }
    }
    else if(act === "rmphoto"){
      const a = current();
      a.answers[t.dataset.key].photos.splice(Number(t.dataset.i), 1);
      persist(); render();
    }
    else if(act === "rmsitephoto"){
      const a = current();
      a.sitePhoto = null;
      persist(); render();
    }
    else if(act === "gps"){
      if(!navigator.geolocation){ alert(ui("noGeolocation")); return; }
      t.textContent = ui("gettingLocation");
      navigator.geolocation.getCurrentPosition(
        p => {
          const a = current();
          a.gps = {lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy};
          persist(); render();
          const d = gpsDistanceToAsset(a);
          if(d != null && d > GPS_WARN_METERS){
            // Let the new screen paint before the blocking alert shows.
            setTimeout(() => alert(ui("gpsFarWarning", {dist: d, tag: a.assetTag, acc: Math.round(a.gps.acc)})), 50);
          }
        },
        () => { alert(ui("gpsFailed")); render(); },
        {enableHighAccuracy:true, timeout:12000}
      );
    }
    else if(act === "setlang"){
      setLang(t.dataset.lang);
      pref("lang", t.dataset.lang);
      const next = authUser() ? {screen:"home", id:null} : {screen: pendingInvite ? "invite" : "login", id:null};
      // On a first run the install guide comes before signing in, so the
      // auditor signs in inside the installed app (on iPhone it doesn't
      // share sign-in or data with Safari).
      state = shouldShowInstallGuide() ? {screen:"install", id:null, next} : next;
      render();
    }
    else if(act === "gologin"){ pendingInvite = null; inviteInfo = null; authError = ""; state = {screen:"login", id:null}; render(); }
    else if(act === "signout"){
      const unsynced = audits.filter(a => !a.syncedAt && !a.test).length;
      if(confirm(unsynced ? ui("confirmSignOutUnsynced", {n: unsynced, itemWord: noun("audit", unsynced)}) : ui("confirmSignOut"))){
        signOut(); authError = "";
        state = {screen:"login", id:null};
        render();
      }
    }
    else if(act === "showinstall"){ state = {screen:"install", id:null, next:{screen:"home", id:null}}; render(); }
    else if(act === "installplatform"){ state = {...state, installPlatform: t.dataset.p}; render(); }
    else if(act === "installdone"){
      pref("installGuideSeen", true);
      state = state.next || {screen:"home", id:null};
      render();
    }
    else if(act === "installnow"){
      const prompt = window.__installPrompt;
      if(!prompt) return;
      window.__installPrompt = null;   // Chrome allows each prompt event to be used once
      prompt.prompt();
      prompt.userChoice.then(choice => {
        if(choice && choice.outcome === "accepted"){
          pref("installGuideSeen", true);
          state = state.next || {screen:"home", id:null};
        }
        render();
      }).catch(() => render());
    }
    else if(act === "myroute"){
      const groups = myGroups();
      const needsPick = groups.length > 1 && !groups.some(g => g.key === pref("routeGroup"));
      state = needsPick ? {screen:"routegroup", id:null, returnTo:"route"} : {screen:"route", id:null};
      render();
      refreshMe();
    }
    else if(act === "changegroup"){ state = {screen:"routegroup", id:null, returnTo:"route"}; render(); }
    else if(act === "setroutegroup"){
      pref("routeGroup", t.dataset.group);
      state = {screen: state.returnTo === "route" ? "route" : "home", id:null};
      render();
    }
    else if(act === "routestop"){ openOrStartAsset(t.dataset.tag); }
    else if(act === "resetapp"){
      const pend = pendingList();
      const msg = pend.length
        ? ui("confirmResetAppPending", {n: pend.length, itemWord: noun("audit", pend.length)})
        : ui("confirmResetApp");
      if(confirm(msg)) resetAppData();
    }

    }catch(err){
      // Whatever just broke, at least try to get the volunteer back to a
      // screen that works rather than leaving them stuck on a dead tap.
      try{ render(); }catch(e2){}
    }
  });

  document.addEventListener("input", e => {
    const f = e.target.dataset.f;
    if(f && current()){
      const a = current();
      a[f] = e.target.value;
      // Cascading water fields: changing an upstream field invalidates
      // whatever was picked downstream of it, so it can't point at a
      // combination that no longer exists in the option lists.
      if(f === "ward"){ a.village = ""; a.subVillage = ""; a.assetTag = ""; a.assetType = ""; a.assetLocation = ""; }
      else if(f === "village"){ a.subVillage = ""; a.assetTag = ""; a.assetType = ""; a.assetLocation = ""; }
      else if(f === "subVillage"){ a.assetTag = ""; a.assetType = ""; a.assetLocation = ""; }
      else if(f === "assetTag"){
        const asset = findAsset(e.target.value);
        a.assetType = asset ? asset.type : "";
        a.assetLocation = asset ? asset.loc : "";
      }
      // A different water point means fresh water / valve-key answers and
      // fresh register-based pre-fills — never the previous point's.
      if(f === "ward" || f === "village" || f === "subVillage" || f === "assetTag"){
        a.hasWater = null;
        a.hasValveKey = null;
        applyPrefill(a);
      }
      a.updatedAt = new Date().toISOString();
      persist();
      if(f === "ward" || f === "village" || f === "subVillage" || f === "assetTag"){
        // Downstream <select> option lists changed — a full re-render
        // regenerates them. (Selects don't hold caret state like text
        // inputs do, so this doesn't cost focus the way it would there.)
        render();
        return;
      }
      const ready = locationReady(a) && a.inspector && a.date;
      const btn = document.querySelector('[data-act="start"]');
      if(btn) btn.disabled = !ready;
      return;
    }
    const noteKey = e.target.dataset.note;
    if(noteKey && current()){
      const a = current();
      a.answers = a.answers || {};
      a.answers[noteKey] = a.answers[noteKey] || {};
      a.answers[noteKey].note = e.target.value;
      a.updatedAt = new Date().toISOString();
      persist();
      const row = e.target.closest(".item");
      const hint = row.querySelector(".note-hint");
      if(hint && e.target.value.trim()) hint.remove();
    }
  });
  
  document.addEventListener("change", e => {
    if(e.target.dataset.sitephoto !== undefined){
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      shrinkImage(file, data => {
        if(!data){ alert(ui("photoUnreadable")); return; }
        const a = current();
        a.sitePhoto = data;
        a.updatedAt = new Date().toISOString();
        if(save(audits)) render();
      });
      return;
    }
    const key = e.target.dataset.photo;
    if(!key) return;
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    shrinkImage(file, data => {
      if(!data){ alert(ui("photoUnreadable")); return; }
      const a = current();
      a.answers = a.answers || {};
      a.answers[key] = a.answers[key] || {};
      a.answers[key].photos = a.answers[key].photos || [];
      a.answers[key].photos.push(data);
      a.updatedAt = new Date().toISOString();
      if(save(audits)) render();
    });
  });
  
  $("#syncPill").addEventListener("click", () => { state.screen = "sync"; render(); });

  // Light-only now (see app/layout.js) — the theme toggle and its stored
  // preference are gone; data-theme="light" is fixed in the page markup.

  const langBtnEl = $("#langBtn");
  if(langBtnEl) langBtnEl.addEventListener("click", () => { state.screen = "lang"; render(); });

  document.addEventListener("submit", e => {
    const form = e.target.closest("form[data-form]");
    if(!form) return;
    e.preventDefault();
    submitAuthForm(form);
  });

  // An invite link (/?invite=…): remember the token and drop it from the
  // address bar, so it isn't left in history or bookmarked.
  const params = new URLSearchParams(location.search);
  if(params.get("invite")){
    pendingInvite = params.get("invite");
    history.replaceState(null, "", location.pathname);
  }

  /* Language first (so everything after is in the volunteer's language),
     then — if this device isn't signed in yet — the invite or sign-in
     screen. Devices set up before sign-in existed (2026-10-28) land on
     sign-in once; their audits stay on the device and sync after. */
  const savedLang = pref("lang");
  if(savedLang){ setLang(savedLang); }
  const signedOutScreen = {screen: pendingInvite ? "invite" : "login", id:null};
  if(!savedLang){ state = {screen:"lang", id:null}; }
  else if(pendingInvite || !authUser()){ state = signedOutScreen; }
  // Devices that were already set up before the install guide existed
  // never pass the first-run language step again — show it to them once
  // here instead, then carry on to wherever they were going.
  if(savedLang && shouldShowInstallGuide()){
    state = {screen:"install", id:null, next:state};
  }

  render();
  refreshMe();
}
