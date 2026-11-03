/**
 * Karimu audit app -> "Incidents" tab, in the official SCHOOLS incidents
 * format. (Added 2026-11-03. Lives in the schools' parallel sheet: create
 * a blank Google Sheet, then Extensions -> Apps Script, paste this whole
 * file. The water points have their own copy, apps-script/Incidents.gs,
 * in their own parallel sheet.)
 *
 * Every run (hourly, once setUp() has been run):
 *   1. reads the app's school findings, already laid out like the official
 *      "Incidents - Schools" sheet (tab "Current Incidents"), from
 *      /api/admin/export?tab=school_incidents (see lib/schoolIncidents.js);
 *   2. copies each new finding's photos into a Drive folder (by default
 *      "School Occurrence Photos", created next to this spreadsheet on the
 *      first run) and links them in "Picture";
 *   3. translates the description to English (auditors write in
 *      Portuguese, Spanish or English; the original is kept in AH);
 *   4. appends the new rows to the "Incidents" tab.
 *
 * Columns A-AB match the official sheet, so a row copied from here and
 * pasted into the official sheet lands in the right columns, with the
 * official per-row formulas (C, Y, Z) included. Columns AD onwards are
 * for this sheet only — don't copy them. Rows are only ever appended,
 * never changed, so notes and ticks added here by hand are safe.
 *
 * Setup: Project Settings -> Script properties -> add EXPORT_KEY = the
 * export key from the admin page (the same key as the water points'
 * script). Optional: PHOTO_FOLDER_ID = a Drive folder id, to put the
 * photos somewhere else. Then run setUp() once and authorize.
 */

const APP_URL = "https://karimu-audit-app.vercel.app";
const TAB = "Incidents";
const PHOTO_FOLDER_NAME = "School Occurrence Photos";
const TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes; the rest goes next hour

// Official columns (A-AB) come from the export; these follow after a gap.
const EXTRA_COLUMNS = ["Copied to official sheet", "App ref", "Audit id", "Synced at", "Original description", "Photo files"];
const OFFICIAL_COUNT = 28;                 // A..AB
const COPIED_COL = OFFICIAL_COUNT + 2;     // AD
const REF_COL = OFFICIAL_COUNT + 3;        // AE
const PICTURE_COL = 10;                    // J

/** Run once: creates the tab and the hourly trigger. */
function setUp() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "syncSchoolIncidents")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncSchoolIncidents").timeBased().everyHours(1).create();
  syncSchoolIncidents();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Karimu")
    .addItem("Sync school incidents now", "syncSchoolIncidents")
    .addToUi();
}

function syncSchoolIncidents() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // a run is already going
  try {
    const started = Date.now();
    const key = PropertiesService.getScriptProperties().getProperty("EXPORT_KEY");
    if (!key) throw new Error("Add the EXPORT_KEY script property first (Project Settings -> Script properties).");

    const res = UrlFetchApp.fetch(
      APP_URL + "/api/admin/export?tab=school_incidents&format=json&key=" + encodeURIComponent(key),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() === 401) throw new Error("The app rejected EXPORT_KEY — it was probably rotated. Copy the current key from the admin page into the script property.");
    if (res.getResponseCode() !== 200) throw new Error("The app's export failed (HTTP " + res.getResponseCode() + "): " + res.getContentText().slice(0, 200));
    const data = JSON.parse(res.getContentText());

    const sheet = incidentsSheet_(data.columns);
    const lastRow = sheet.getLastRow();
    const done = new Set(lastRow > 1
      ? sheet.getRange(2, REF_COL, lastRow - 1, 1).getValues().map(r => String(r[0]))
      : []);
    const todo = data.incidents.filter(inc => !done.has(inc.ref));
    if (!todo.length) return;

    const folder = photoFolder_();
    const driveByName = indexFolder_(folder, {});

    const ready = [];
    for (const inc of todo) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const links = inc.photoUrls.map((url, i) => {
        const name = inc.photoFilenames[i];
        if (!driveByName[name]) {
          const blob = UrlFetchApp.fetch(url).getBlob().setName(name);
          driveByName[name] = folder.createFile(blob).getUrl();
        }
        return driveByName[name];
      });
      ready.push({ inc, links, description: toEnglish_(inc.description) });
    }
    if (!ready.length) return;

    const first = sheet.getLastRow() + 1;
    const rows = ready.map(({ inc, description }, i) => {
      const r = first + i;
      const v = inc.values.slice(0, OFFICIAL_COUNT);
      v[1] = inc.date ? new Date(inc.date + "T00:00:00") : "";
      v[7] = description;
      v[PICTURE_COL - 1] = ""; // photos: rich-text links, set below
      // The official sheet's own per-row formulas, so pasted rows keep working.
      v[2] = '=if(B' + r + ',year(B' + r + '), "")';
      v[24] = '=if(O' + r + '<>"",O' + r + '-M' + r + ',"")';
      v[25] = '=if(AND(X' + r + '="",M' + r + '<>""),today()-M' + r + ',IF(M' + r + '<>"",O' + r + '-M' + r + ', ""))';
      v[27] = "";
      return v.concat(["", false, inc.ref, inc.auditId, inc.syncedAt, inc.description, inc.photoFilenames.join(", ")]);
    });
    sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
    sheet.getRange(first, COPIED_COL, rows.length, 1).insertCheckboxes();
    sheet.getRange(first, 2, rows.length, 1).setNumberFormat("yyyy-mm-dd");
    sheet.getRange(first, PICTURE_COL, rows.length, 1).setRichTextValues(ready.map(({ links }) => [photoLinks_(links)]));
  } finally {
    lock.releaseLock();
  }
}

/** The tab, created with the official header row the first time. */
function incidentsSheet_(columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB);
  if (!sheet) {
    sheet = ss.insertSheet(TAB);
    const header = columns.slice(0, OFFICIAL_COUNT).concat([""], EXTRA_COLUMNS);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold").setWrap(true);
    sheet.getRange(1, COPIED_COL, 1, EXTRA_COLUMNS.length).setBackground("#eeeeee");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** The PHOTO_FOLDER_ID folder, or "School Occurrence Photos" next to this
 * spreadsheet (created on the first run, then remembered). */
function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("PHOTO_FOLDER_ID");
  if (id) return DriveApp.getFolderById(id);
  const parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const existing = parent.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = existing.hasNext() ? existing.next() : parent.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty("PHOTO_FOLDER_ID", folder.getId());
  return folder;
}

/** name -> Drive URL for every file in the folder and its subfolders
 * (people sort photos into subfolders such as "Dia 2"). */
function indexFolder_(folder, out) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!out[f.getName()]) out[f.getName()] = f.getUrl();
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) indexFolder_(subs.next(), out);
  return out;
}

/** "Photo 1", "Photo 2" … each linked to its Drive file. */
function photoLinks_(links) {
  if (!links.length) return SpreadsheetApp.newRichTextValue().setText("").build();
  const labels = links.map((_, i) => "Photo " + (i + 1));
  const b = SpreadsheetApp.newRichTextValue().setText(labels.join("\n"));
  let at = 0;
  labels.forEach((label, i) => {
    b.setLinkUrl(at, at + label.length, links[i]);
    at += label.length + 1;
  });
  return b.build();
}

function toEnglish_(text) {
  if (!text) return text;
  try {
    return LanguageApp.translate(text, "", "en");
  } catch (e) {
    return text; // daily translation quota hit, or similar — keep the original
  }
}
