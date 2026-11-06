/**
 * Karimu audit app -> "Incidents" tab, in the official incidents format.
 * (Added 2026-11-03. Lives in the parallel sheet "Water Points Audit
 * Results - Sept 2026": Extensions -> Apps Script, paste this whole file.)
 *
 * Every run (hourly, once setUp() has been run):
 *   1. reads the app's findings, already laid out like the official
 *      "Incidents - Water Project" sheet (tab "Current Incidents"), from
 *      /api/admin/export?tab=incidents (see lib/incidents.js in the repo);
 *   2. copies each new finding's photos into the Drive folder
 *      "Occurrence Photos" (skipping any already there under the same
 *      name, subfolders included) and links them in "Picture of the Issue";
 *   3. translates the description to English (auditors write in
 *      Portuguese, Spanish or English; the original is kept in column AO);
 *   4. appends the new rows to the "Incidents" tab;
 *   5. (added 2026-11-06) fills in S-AC of a row once a validation visit in
 *      the app has closed that issue, with the "after" photo in Y.
 *
 * Two stages, like the official sheet: copy A-R plus V right after the
 * inspection, and S-AC once "Validation copied to official sheet" shows
 * an empty box on the row (V comes along unchanged, it's the same link).
 *
 * Columns A-AI match the official sheet, so a row copied from here and
 * pasted into the official sheet lands in the right columns, with the
 * official per-row formulas (AD, AE, AG, AH) included. Columns AK onwards
 * are for this sheet only — don't copy them. Rows are appended once and
 * only S-AC are ever written again (by step 5), so notes and ticks added
 * here by hand elsewhere on the row are safe.
 *
 * This replaces the "Karimu audit photos -> Drive" Claude routine, which
 * did step 2 only (same folder, same file names, so nothing is copied
 * twice when switching over).
 *
 * Setup: Project Settings -> Script properties -> add EXPORT_KEY = the
 * export key from the admin page (the same key the Findings tab's
 * IMPORTDATA formula uses). Then run setUp() once and authorize.
 */

const APP_URL = "https://karimu-audit-app.vercel.app";
const TAB = "Incidents";
const PHOTO_FOLDER_ID = "1vzrQVBA2LxhlEOhlXQoov2WKNTn__s4_"; // "Occurrence Photos" in "Water Points Maintenance"
const TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes; the rest goes next hour

// Official columns (A-AI) come from the export; these follow after a gap.
// Only ever appended to, so tabs made by an earlier version keep lining up.
const EXTRA_COLUMNS = ["Copied to official sheet", "App ref", "Audit id", "Synced at", "Original description", "Photo files",
  "App notes", "Validation copied to official sheet", "Validation synced at", "Validation photo files"];
const OFFICIAL_COUNT = 35;                       // A..AI
const COPIED_COL = OFFICIAL_COUNT + 2;           // AK
const REF_COL = OFFICIAL_COUNT + 3;              // AL
const VALIDATION_COPIED_COL = OFFICIAL_COUNT + 9;  // AR
const VALIDATION_SYNCED_COL = OFFICIAL_COUNT + 10; // AS

// Official columns, 1-based.
const PICTURE_COL = 22;                          // V, the issue's picture
const RESOLVED_PICTURE_COL = 25;                 // Y, the picture after the fix
const DATE_COLS = [2, 16, 17, 19, 26, 29];       // B, P, Q, S, Z, AC
const DATE_FORMAT = "d-mmm-yyyy";                // as in the official sheet

/** Run once: creates the tab and the hourly trigger. */
function setUp() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "syncIncidents")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncIncidents").timeBased().everyHours(1).create();
  syncIncidents();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Karimu")
    .addItem("Sync incidents now", "syncIncidents")
    .addToUi();
}

function syncIncidents() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // a run is already going
  try {
    const started = Date.now();
    const key = PropertiesService.getScriptProperties().getProperty("EXPORT_KEY");
    if (!key) throw new Error("Add the EXPORT_KEY script property first (Project Settings -> Script properties).");

    const res = UrlFetchApp.fetch(
      APP_URL + "/api/admin/export?tab=incidents&format=json&key=" + encodeURIComponent(key),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() === 401) throw new Error("The app rejected EXPORT_KEY — it was probably rotated. Copy the current key from the admin page into the script property.");
    if (res.getResponseCode() !== 200) throw new Error("The app's export failed (HTTP " + res.getResponseCode() + "): " + res.getContentText().slice(0, 200));
    const data = JSON.parse(res.getContentText());

    const sheet = incidentsSheet_(data.columns);
    const lastRow = sheet.getLastRow();
    const rowByRef = {};
    const validationSynced = {};
    if (lastRow > 1) {
      const refs = sheet.getRange(2, REF_COL, lastRow - 1, 1).getValues();
      const synced = sheet.getRange(2, VALIDATION_SYNCED_COL, lastRow - 1, 1).getValues();
      refs.forEach((r, i) => {
        rowByRef[String(r[0])] = i + 2;
        validationSynced[String(r[0])] = String(synced[i][0]);
      });
    }

    const folder = DriveApp.getFolderById(PHOTO_FOLDER_ID);
    const driveByName = indexFolder_(folder, {});
    const toDrive = (urls, names) => urls.map((url, i) => {
      const name = names[i];
      if (!driveByName[name]) {
        const blob = UrlFetchApp.fetch(url).getBlob().setName(name);
        driveByName[name] = folder.createFile(blob).getUrl();
      }
      return driveByName[name];
    });

    // New issues: append a row each.
    const ready = [];
    for (const inc of data.incidents.filter(inc => !rowByRef[inc.ref])) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      ready.push({
        inc,
        links: toDrive(inc.photoUrls, inc.photoFilenames),
        fixLinks: inc.validation ? toDrive(inc.validation.photoUrls, inc.validation.photoFilenames) : [],
        description: toEnglish_(inc.description),
      });
    }
    if (ready.length) {
      const first = sheet.getLastRow() + 1;
      const rows = ready.map(({ inc, description }, i) => {
        const r = first + i;
        const v = inc.values.slice(0, OFFICIAL_COUNT).map(toCell_);
        v[11] = description;
        v[PICTURE_COL - 1] = "";           // photos: rich-text links, set below
        v[RESOLVED_PICTURE_COL - 1] = "";
        // The official sheet's own per-row formulas, so pasted rows keep working.
        v[29] = '=if(S' + r + '="","",S' + r + '-B' + r + ')';
        v[30] = '=if(AC' + r + '="","",AC' + r + '-S' + r + ')';
        v[32] = '=if(B' + r + '="", , year(B' + r + '))';
        v[33] = '=if(S' + r + '="", if(B' + r + '<>"", today()-B' + r + ', ""), 0)';
        v[34] = "";
        const val = inc.validation;
        return v.concat(["", false, inc.ref, inc.auditId, inc.syncedAt, inc.description, inc.photoFilenames.join(", "),
          inc.appNotes || "", val ? false : "", val ? val.syncedAt : "", val ? val.photoFilenames.join(", ") : ""]);
      });
      sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
      sheet.getRange(first, COPIED_COL, rows.length, 1).insertCheckboxes();
      DATE_COLS.forEach(c => sheet.getRange(first, c, rows.length, 1).setNumberFormat(DATE_FORMAT));
      sheet.getRange(first, PICTURE_COL, rows.length, 1).setRichTextValues(ready.map(({ links }) => [photoLinks_(links)]));
      sheet.getRange(first, RESOLVED_PICTURE_COL, rows.length, 1).setRichTextValues(ready.map(({ fixLinks }) => [photoLinks_(fixLinks)]));
      ready.forEach(({ inc }, i) => {
        if (inc.validation) sheet.getRange(first + i, VALIDATION_COPIED_COL).insertCheckboxes();
      });
    }

    // Issues a validation visit closed since their row was written: S-AC.
    for (const inc of data.incidents) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const r = rowByRef[inc.ref];
      if (!r || !inc.validation || validationSynced[inc.ref] === inc.validation.syncedAt) continue;
      const v = inc.values.map(toCell_);
      sheet.getRange(r, 19, 1, 3).setValues([v.slice(18, 21)]);   // S-U
      sheet.getRange(r, 23, 1, 7).setValues([v.slice(22, 29)]);   // W-AC
      sheet.getRange(r, RESOLVED_PICTURE_COL).setRichTextValue(
        photoLinks_(toDrive(inc.validation.photoUrls, inc.validation.photoFilenames)));
      [19, 26, 29].forEach(c => sheet.getRange(r, c).setNumberFormat(DATE_FORMAT));
      sheet.getRange(r, VALIDATION_COPIED_COL).insertCheckboxes().setValue(false);
      sheet.getRange(r, VALIDATION_SYNCED_COL, 1, 2).setValues([[inc.validation.syncedAt, inc.validation.photoFilenames.join(", ")]]);
    }
  } finally {
    lock.releaseLock();
  }
}

/** The tab, created with the official header row the first time; the
 * extra columns' header is brought up to date on tabs made earlier. */
function incidentsSheet_(columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB);
  if (!sheet) {
    sheet = ss.insertSheet(TAB);
    const header = columns.slice(0, OFFICIAL_COUNT).concat([""], EXTRA_COLUMNS);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold").setWrap(true);
    sheet.setFrozenRows(1);
  }
  const width = COPIED_COL + EXTRA_COLUMNS.length - 1;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const extras = sheet.getRange(1, COPIED_COL, 1, EXTRA_COLUMNS.length);
  if (extras.getValues()[0].join("|") !== EXTRA_COLUMNS.join("|")) {
    extras.setValues([EXTRA_COLUMNS]).setFontWeight("bold").setWrap(true);
  }
  extras.setBackground("#eeeeee");
  return sheet;
}

/** yyyy-mm-dd from the app -> a real date, so the sheet's formulas work. */
function toCell_(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T00:00:00") : v;
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

/** "link" (or "link 1", "link 2" …), each linked to its Drive file — the
 * official sheet's own wording. */
function photoLinks_(links) {
  if (!links.length) return SpreadsheetApp.newRichTextValue().setText("").build();
  const labels = links.length === 1 ? ["link"] : links.map((_, i) => "link " + (i + 1));
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
