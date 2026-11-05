/**
 * One-off repair (2026-11-04) for the photos the old "Karimu audit photos
 * -> Drive" Claude routine put in "Occurrence Photos" before Incidents.gs
 * took over. That routine re-typed each photo's bytes by hand, and some
 * copies came out truncated or with a wrong byte. This compares each photo
 * it left in the folder (created before REPAIR_CUTOFF) with the original
 * in the app and, where they differ, replaces the Drive file's content in
 * place: same file, same link, so the "Photo N" links in the Incidents
 * tab keep working.
 *
 * Setup, in the same Apps Script project as Incidents.gs (it uses that
 * file's APP_URL, PHOTO_FOLDER_ID and EXPORT_KEY): add a file (+ -> Script)
 * and paste this; then Services (+) -> Drive API -> Add. Run
 * repairOldPhotos() and read the Execution log. Safe to run again: photos
 * that already match are left alone.
 */
const REPAIR_CUTOFF = new Date("2026-11-03T00:00:00Z");

function repairOldPhotos() {
  const key = PropertiesService.getScriptProperties().getProperty("EXPORT_KEY");
  const res = UrlFetchApp.fetch(
    APP_URL + "/api/admin/export?tab=incidents&format=json&key=" + encodeURIComponent(key),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error("The app's export failed (HTTP " + res.getResponseCode() + ")");
  const urlByName = {};
  JSON.parse(res.getContentText()).incidents.forEach(inc =>
    inc.photoFilenames.forEach((name, i) => { urlByName[name] = inc.photoUrls[i]; }));

  const counts = { matching: 0, replaced: 0, badOriginal: 0, notInApp: 0 };
  const files = DriveApp.getFolderById(PHOTO_FOLDER_ID).getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getDateCreated() >= REPAIR_CUTOFF || file.getMimeType() !== "image/jpeg") continue;
    const name = file.getName();
    const url = urlByName[name];
    if (!url) { counts.notInApp++; Logger.log("Not in the app, left as is: " + name); continue; }

    const original = UrlFetchApp.fetch(url).getBlob();
    const bytes = original.getBytes();
    // A JPEG starts with FF D8 (-1, -40 as Apps Script's signed bytes).
    if (bytes.length < 1000 || bytes[0] !== -1 || bytes[1] !== -40) {
      counts.badOriginal++;
      Logger.log("The app's original is not a photo, left as is: " + name);
      continue;
    }
    if (md5_(bytes) === md5_(file.getBlob().getBytes())) { counts.matching++; continue; }

    const before = file.getSize();
    Drive.Files.update({}, file.getId(), original.setContentType("image/jpeg"), { supportsAllDrives: true });
    counts.replaced++;
    Logger.log("Replaced " + name + " (" + before + " -> " + bytes.length + " bytes)");
  }
  Logger.log(JSON.stringify(counts));
}

function md5_(bytes) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
}
