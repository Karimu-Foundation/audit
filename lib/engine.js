// Karimu Field Audit — core app engine.
// Ported from the original single-file prototype: same screens, same
// offline-first localStorage model, same checklist logic. The only
// change from the Artifact version is how Sync leaves the device:
// it now POSTs to /api/sync (a real serverless function on this same
// deployment) instead of asking the Artifact runtime to save a file.

import {
  SCHOOLS, BUILDING_NAMES, BUILDING_TYPES, TEACHING_SPACES, COOKING_SPACES,
  BATHROOM_UNITS, SCHOOL_BUILDING, SCHOOL_BATHROOM, AUDIT_TYPES,
  groupApplies, buildItems, sectionsFor, slug,
} from "./checklists";
import {
  getWards, getVillages, getSubVillages, getAssets, findAsset,
  getVolunteers, getVolunteerGroups, getRoute,
} from "./waterAssets";
import { LANGUAGES, setLang, getLang, tr, ui, noun } from "./i18n";
import L from "leaflet";


/* ==================================================================
   STORAGE  (offline-first: everything lives on the device until sync)
   ================================================================== */
const KEY = "karimu.audits.v2";
const PREF = "karimu.prefs.v1";

function load(){
  try{ return JSON.parse(localStorage.getItem(KEY) || "[]"); }
  catch(e){ return []; }
}
function save(list){
  try{ localStorage.setItem(KEY, JSON.stringify(list)); return true; }
  catch(e){
    alert(ui("storageFull"));
    return false;
  }
}
function pref(k, v){
  try{
    const p = JSON.parse(localStorage.getItem(PREF) || "{}");
    if(v === undefined) return p[k];
    p[k] = v; localStorage.setItem(PREF, JSON.stringify(p)); return v;
  }catch(e){ return undefined; }
}

let audits = load();
let state = {screen:"home", id:null};

function uid(){
  return "KA-" + Date.now().toString(36).toUpperCase() + "-" +
         Math.random().toString(36).slice(2,6).toUpperCase();
}
function current(){ return audits.find(a => a.id === state.id); }
function persist(){ save(audits); }

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
  const matches = audits.filter(a => a.type === "water_point" && a.assetTag === tag);
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
  else if(state.screen === "volunteer") v.innerHTML = screenVolunteer();
  else if(state.screen === "routegroup") v.innerHTML = screenRouteGroup();
  else if(state.screen === "home")      v.innerHTML = screenHome();
  else if(state.screen === "pick") v.innerHTML = screenPick();
  else if(state.screen === "route"){ v.innerHTML = screenRoute(); requestAnimationFrame(initRouteMap); }
  else if(state.screen === "setup")v.innerHTML = screenSetup();
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
  ${firstRun ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow">${esc(ui("currentVolunteerLabel"))}</span>
    <div class="stack gap-10">
      ${getVolunteers().map(vol => `<button class="btn btn-block ${pref("volunteer")===vol ? "btn-primary" : "btn-ghost"}" data-act="setvolunteer" data-volunteer="${esc(vol)}">${esc(vol)}</button>`).join("")}
    </div>
  </div>`}
  ${firstRun ? "" : `
  <div class="stack gap-10" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
    <span class="eyebrow" style="color:var(--issue)">${esc(ui("resetAppData"))}</span>
    <p class="small" style="color:var(--muted)">${esc(ui("resetAppDataHint"))}</p>
    <button class="btn btn-block btn-danger-outline" data-act="resetapp">${esc(ui("resetAppData"))}</button>
  </div>`}`;
}

/* ---------- VOLUNTEER PICKER (first run, right after language) ---------- */
function screenVolunteer(){
  const firstRun = !pref("volunteer");
  return `
  ${firstRun ? "" : `<button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>`}
  <div class="hero">
    <span class="eyebrow">${esc(ui("chooseVolunteerEyebrow"))}</span>
    <h1>${esc(ui("chooseVolunteerTitle"))}</h1>
    <p class="lede small">${esc(ui("chooseVolunteerHint"))}</p>
  </div>
  <div class="stack gap-10">
    ${getVolunteers().map(vol => `<button class="btn btn-block ${pref("volunteer")===vol ? "btn-primary" : "btn-ghost"}" data-act="setvolunteer" data-volunteer="${esc(vol)}">${esc(vol)}</button>`).join("")}
  </div>`;
}

/* ---------- ROUTE GROUP PICKER (which day/group a volunteer is working) ----------
   A volunteer covers one group per field day (4 groups total), so "My
   route" needs to know which one before it can show anything. Asked
   right after picking a name (when more than one group is assigned),
   and changeable any time from the My Route screen. */
function currentRouteGroup(volunteer){
  const groups = getVolunteerGroups(volunteer);
  if(!groups.length) return null;
  const saved = pref("routeGroup");
  return groups.find(g => g.group === saved) || groups[0];
}

function screenRouteGroup(){
  const volunteer = pref("volunteer");
  const groups = getVolunteerGroups(volunteer);
  const current = pref("routeGroup");
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
    <button class="btn btn-block ${current===g.group ? "btn-primary" : "btn-ghost"}" data-act="setroutegroup" data-group="${g.group}">
      <span class="row" style="justify-content:space-between;width:100%">
        <span>${esc(ui("dayGroupLabel", {day:g.day, group:g.group}))}</span>
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
  const volunteer = pref("volunteer");
  const groups = getVolunteerGroups(volunteer);
  const current = currentRouteGroup(volunteer);
  const { ordered, unordered } = current ? getRoute(volunteer, current.group) : {ordered:[], unordered:[]};
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
    const volunteer = pref("volunteer");
    const current = currentRouteGroup(volunteer);
    if(!current) return;
    const { ordered } = getRoute(volunteer, current.group);
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
  const volunteer = pref("volunteer");

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
      </div>
    </div>
  </div>

  <button class="btn btn-primary btn-block" data-act="start" ${ready?"":"disabled"} style="margin-top:18px">
    ${esc(ui("openChecklist"))}
  </button>
  ${ready ? "" : '<p class="small muted" style="text-align:center;margin-top:9px">' + esc(ui(isWater ? "fillFieldsHintWater" : "fillFieldsHint")) + '</p>'}
  `;
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
            <div class="item-text">${esc(tr(text))}</div>
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
                ${esc(ui("addPhoto"))}
                <input type="file" accept="image/*" capture="environment" data-photo="${key}" class="sr">
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
function screenSync(){
  const pend = pendingList();
  const online = navigator.onLine;
  const bytes = (localStorage.getItem(KEY) || "").length;
  const kb = (bytes / 1024).toFixed(0);

  return `
  <button class="backlink" data-act="home" style="margin-bottom:14px">${esc(ui("backToAudits"))}</button>
  <div class="hero">
    <span class="eyebrow">${esc(ui("syncEyebrow"))}</span>
    <h1>${esc(ui("syncTitle"))}</h1>
    <p class="lede small">${esc(ui("syncLede"))}</p>
  </div>

  <button class="btn btn-primary btn-block" data-act="myroute" style="margin-bottom:16px">${esc(ui("backToRouteList"))}</button>

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
    <div><div class="n">${kb}</div><div class="k">${esc(ui("kbOnDevice"))}</div></div>
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
  a.answers[key] = cur;
  a.updatedAt = new Date().toISOString();
  persist();
  patchItem(key);
  $("#bottom").innerHTML = barCheck();
  refreshCounts();
}

/* Re-render one item row + its tally tick, so the page never jumps. */
function patchItem(key){
  const a = current();
  const ans = (a.answers||{})[key] || {};
  const v = ans.value || "";
  const row = document.querySelector('.item[data-key="' + cssEsc(key) + '"]');
  if(row){
    row.dataset.v = v;
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

function shrinkImage(file, cb){
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function(){
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    cb(c.toDataURL("image/jpeg", 0.55));
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
    inspector: pref("volunteer") || pref("lastInspector") || "",
    date: today(), gps: null,
    answers: {},
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
  const existing = audits.find(a => a.type === "water_point" && a.assetTag === tag && !a.completedAt);
  if(existing){
    state = {screen: setupStarted(existing) ? "check" : "setup", id: existing.id};
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
    inspector: pref("volunteer") || pref("lastInspector") || "",
    date: today(), gps: null,
    answers: {},
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
      headers: {"Content-Type":"application/json"},
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
  const pend = pendingList();
  syncLog = [];
  const stamp = () => new Date().toISOString().replace("T"," ").slice(0,19);
  render();

  if(!navigator.onLine){
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
      persist();
      sent++;
      syncLog.push("[" + stamp() + "] " + ui("syncSentLine", {photos: res.photosUploaded||0, findings: res.findingsWritten||0}));
    }else{
      failed++;
      const friendly = {
        not_configured: ui("syncErrNotConfigured"),
        network_error: ui("syncErrNetwork"),
        upstream_error: ui("syncErrUpstream", {message: res.message||""}),
        bad_request: ui("syncErrBadRequest")
      }[res.code] || (res.message || ui("syncErrUnknown"));
      syncLog.push("[" + stamp() + "] " + ui("syncNotSentLine", {reason: friendly}));
      if(res.code === "network_error" || res.code === "not_configured") hardStop = true; // no point hammering a dead endpoint
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
export function mount(){
  if(mounted) return;
  mounted = true;

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
      state = {screen: a.completedAt ? "review" : (setupStarted(a) ? "check" : "setup"), id:a.id};
      render();
    }
    else if(act === "start"){
      const a = current();
      pref("lastSchool", a.school); pref("lastInspector", a.inspector);
      if(a.type === "water_point"){ pref("lastWard", a.ward); pref("lastVillage", a.village); }
      state.screen = "check"; render();
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
        if(cur.value !== "issue") cur.value = "ok";
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
    else if(act === "gps"){
      if(!navigator.geolocation){ alert(ui("noGeolocation")); return; }
      t.textContent = ui("gettingLocation");
      navigator.geolocation.getCurrentPosition(
        p => {
          const a = current();
          a.gps = {lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy};
          persist(); render();
        },
        () => { alert(ui("gpsFailed")); render(); },
        {enableHighAccuracy:true, timeout:12000}
      );
    }
    else if(act === "setlang"){
      setLang(t.dataset.lang);
      pref("lang", t.dataset.lang);
      state = pref("volunteer") ? {screen:"home", id:null} : {screen:"volunteer", id:null};
      render();
    }
    else if(act === "setvolunteer"){
      pref("volunteer", t.dataset.volunteer);
      const groups = getVolunteerGroups(t.dataset.volunteer);
      if(groups.length > 1){
        // Ask which day/group this volunteer is working before sending
        // them on to Home — a name alone isn't enough to know which
        // water points they need today.
        state = {screen:"routegroup", id:null, returnTo:"home"};
      } else {
        pref("routeGroup", groups.length === 1 ? groups[0].group : null);
        state = {screen:"home", id:null};
      }
      render();
    }
    else if(act === "myroute"){
      const volunteer = pref("volunteer");
      const groups = getVolunteerGroups(volunteer);
      const saved = pref("routeGroup");
      const needsPick = groups.length > 1 && !groups.some(g => g.group === saved);
      state = needsPick ? {screen:"routegroup", id:null, returnTo:"route"} : {screen:"route", id:null};
      render();
    }
    else if(act === "changegroup"){ state = {screen:"routegroup", id:null, returnTo:"route"}; render(); }
    else if(act === "setroutegroup"){
      pref("routeGroup", Number(t.dataset.group));
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

  /* Language: pick up any saved preference, otherwise gate the very
     first screen the volunteer sees on the language picker — the
     backend/spreadsheet side is unaffected either way, since tr()/ui()
     only ever touch what gets rendered. */
  const savedLang = pref("lang");
  if(savedLang){ setLang(savedLang); }
  if(!savedLang){ state = {screen:"lang", id:null}; }
  else if(!pref("volunteer")){ state = {screen:"volunteer", id:null}; }
  else {
    // A returning volunteer whose device predates group routing (or
    // whose saved group no longer belongs to them) gets asked once,
    // same as a first-time name pick — remembered from then on, same as
    // language/volunteer.
    const groups = getVolunteerGroups(pref("volunteer"));
    const saved = pref("routeGroup");
    if(groups.length > 1 && !groups.some(g => g.group === saved)){
      state = {screen:"routegroup", id:null, returnTo:"home"};
    }
  }

  render();
}
