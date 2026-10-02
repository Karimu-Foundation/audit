# Karimu Field Audit

Offline-first maintenance audit app for Karimu Foundation volunteers. Approved
by Nelson to go live for **water point audits**: pick a Ward, Village,
optional Sub-Village, and Asset Tag from the Water Assets registry, work the
maintenance checklist without any connection, then Sync when back online.
School building / school bathroom / health post audits are built and still
in the code (`available:false` in `lib/checklists.js`), but are not in active
use right now — flip that flag back on if/when they're needed again.

Ported from an interactive prototype — see `lib/checklists.js` for the full
item lists and applicability rules, `lib/waterAssets.js` for the embedded
Water Assets registry powering the picker, and `lib/engine.js` for the app
itself (screens, offline storage, sync).

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

This is a stock Next.js App Router project — deploy it to Vercel by connecting
this repository (Import Project → this repo) or with `vercel deploy` from a
machine that can reach vercel.com. No special build settings needed.

## Water Assets registry

`lib/waterAssets.js` embeds the full "Water Assets" tab of the [Water Assets
sheet](https://docs.google.com/spreadsheets/d/1HLnqnP8wUJjV-MfVO9o7cio693qG220MpOHbFLRLrFE)
— 1,717 assets across the Ayalagaya, Arri, and Kiru wards, as of the
2026-08-25 export — so the Ward → Village → Sub-Village → Asset Tag picker
works fully offline, same as everything else in this app.

Of those, 1,693 are Water Points and 24 are Water Tanks. **Only Water Points
are in the picker right now** — Nelson's scope decision, confirmed
2026-08-25 — via a filter on `WATER_ASSETS` in `lib/waterAssets.js`; the
raw 1,717-row list stays in the file either way. If tanks come into scope
later, dropping that one filter brings them back, and the 51-item "Tanks
and Intake" checklist in `lib/checklists.js` (`WATER_TANK_SECTIONS`) is
already written and wired up to `assetType === "T"` — it's just unreachable
while every asset in the picker is a Water Point.

Of the 1,693 Water Points, the sheet's "Ownership" column marks 332 as
**Public** and 1,361 as **Private**. **Only Public Water Points are in the
picker** — Edu's scope decision, confirmed 2026-08-26: private water points
aren't part of Karimu's audit program. Same reversible-filter pattern as
Water Tanks above (an `isPublic` flag on each row, checked alongside the
Water Point type check in `WATER_ASSETS`) — the 1,361 private rows stay in
the file, just unreachable from the picker, route, or map anywhere in the
app. Two of the 332 Public Water Points (in Kiru) have no village on file
and so don't surface in the Ward → Village → ... picker either — that's
the sheet's data (see the Kiru note below), not something this filter did.

The Water Point checklist itself (`WATER_POINT_SECTIONS` in
`lib/checklists.js`) is sourced from the "Maintanence checklist-Water
Project" tab of a separate sheet, and picked automatically based on the
selected asset's type.

**This data goes stale as the registry sheet changes** — new water points,
renamed villages, corrected wards, ownership changes. There's no live sync
back to the sheet; re-export it and regenerate `lib/waterAssets.js` (a
plain array of `[assetTag, assetType, ward, village, subVillage, location,
lat, lon, volunteer, routeOrder, isPublic]` tuples — see "Volunteer
identification and routes" below for the volunteer/routeOrder pair) when
it's meaningfully out of date. Two Kiru assets have no village/sub-village
on file and use `""` — that's the sheet's data, not a bug here.

The 81 individual checklist statements (in both the Water Point and Tanks
and Intake sections) are kept verbatim from Nelson's checklist and are only
in English — see the i18n note below on why that's an acceptable gap for
now, and how to close it later.

## Volunteer identification, groups, and routes

Added 2026-08-25, reworked 2026-09-12. Right after picking a language, a
volunteer picks their name from a fixed list (`VOLUNTEERS` in
`lib/waterAssets.js`: Thuler, Arake, Gui Lacerda, Rafa Braga, Sergio,
Padilha, plus a `Teste` account for QA with nothing assigned to it) —
remembered on that device from then on, same as language, and changeable
later from the same screen (globe icon → scroll down). It's also used to
auto-fill the Inspector field on every new audit's Setup screen — nobody
has to type their own name a second time. It isn't sent anywhere else and
doesn't gate which audits someone can start.

**Groups (added 2026-09-12, regenerated 2026-09-13 from the redone
sheet).** The mission's 312 planned Water Points are split into **24
hand-planned groups** of 10-14 each (from the "Water Points" tab of Edu's
routing spreadsheet — see the header comment in `lib/waterAssets.js` for
the exact source, the re-export procedure, and its pitfalls), worked over
**4 field days, 6 groups per day**: groups 1-6 on day 1, 7-12 on day 2,
13-18 on day 3, 19-24 on day 4 (`group -> day = Math.ceil(group / 6)`).
Each of the 6 volunteers covers one group per day (e.g. Thuler: groups 1,
7, 13, 19). Because the same volunteer's groups point at
completely different places on different days, picking a name alone
isn't enough to know which Water Points to show — so right after choosing
a name (and any time after, via "Change group" on My Route), the app asks
**which day/group they're working** and remembers that choice the same
way as the volunteer/language prefs. A volunteer with only one group (or
none, like `Teste`) skips straight past this screen since there's nothing
to choose.

"My route" shows the current group's Water Points on a map (OpenStreetMap
tiles via Leaflet — needs a connection to load the map itself, though the
stop list below it works offline like everything else) with a suggested
visiting order, plus a tap-to-start shortcut into a pre-filled audit for
that asset. Each stop also shows a small status badge — synced, done but
waiting to sync, or not audited yet (see `auditStatusForTag()` in
`lib/engine.js`). There is deliberately **no "go to next stop"
shortcut** on the Sync screen — that existed briefly (2026-09-12) but was
removed at Nelson's request (2026-09-13): the planned visiting order
within a group isn't necessarily the order the auditor and guide will
actually walk it in, so after finishing a checklist the Sync screen's
"← Back to water points list" button just returns to the full route list,
letting the auditor pick whichever stop makes sense next rather than
being steered toward one the plan suggests. The assignment, grouping, and
order are **precomputed and baked into `lib/waterAssets.js`**, not
calculated on the device, so every volunteer's phone shows the same plan:

- Each row's 12th tuple field is its `group` (1-24, or `null` if the
  point isn't part of this year's planned route). `routeOrder` is the
  visiting order **within that group**, taken straight from the row
  order in Edu's spreadsheet (the planned order, not a computed
  nearest-neighbor walk) — the map still draws it as a straight-line
  path, since there's no detailed road network here to route against.
- Of the 332 Public Water Points, 312 are in one of the 24 groups; the
  rest aren't part of this year's route and carry
  `volunteer`/`routeOrder`/`group` all `null` (same as Private Water
  Points and Water Tanks, which are out of scope regardless).
- A handful of grouped points (26 of 312) have no GPS coordinates on
  file; same as before, the app lists them after the ordered route,
  unordered, flagged "No GPS."

**Each regeneration fully replaces whatever came before it** — every
Water Point assigned under an earlier plan gets
`volunteer`/`routeOrder`/`group` reset to `null` first, so a point
dropped from the new sheet doesn't keep a stale group. The exact
re-export procedure — including the Drive-connector truncation trap that
silently produced a wrong 12-group plan on 2026-09-13, and the checks
that catch it (6 volunteers × 4 groups, sizes 10-14, every tag resolving
to a Public Water Point) — is written up in the header comment of
`lib/waterAssets.js`. There's no saved script committed here yet; worth
turning into a real `scripts/` file, since this has now come up three
times.

## Checklist pre-fill, GPS check, and test mode

Added 2026-10-02.

**"Is there water?"** Opening the checklist for a water point first asks
whether there's water right now (`screenWater()` in `lib/engine.js`). The
answer is saved on the audit (`hasWater`), shown on Review, and exported
as the `water` column. With no water, the items that can't be checked
without water are pre-filled N/A, and "Faucets are delivering enough
water" is pre-filled as an **Issue** (with an auto-note) — on purpose, so a
dry water point shows up in Findings / the Occurrences sheet rather than
vanishing behind N/As. The answer can be changed from the checklist
banner; switching back to "yes" withdraws those pre-fills.

**From the register.** `lib/waterAssets.js` now carries each point's
structure type and whether a plaque is on record (from the sheet's "Type"
and "Plaque" columns, see the header comment there). No plaque on record →
the Plaque questions (and "is it supposed to have a donation plaque") are
pre-filled N/A. Type "Faucet" → the Concrete Column questions are
pre-filled N/A. "Concrete wall" points currently get no structure
pre-fill — add a rule if Concrete Column doesn't apply to them either.

**How pre-fill behaves.** All rules live in `PREFILL_RULES` in
`lib/checklists.js` (one line each). Pre-fill only fills empty items,
tags each with its reason (`ans.auto`, shown as a "Pre-filled" badge plus
a count in the checklist banner), and is a starting point, not a lock:
the moment the auditor taps an answer it's theirs, and "All OK" skips
pre-filled items so it can't quietly undo them. Changing the water point
on Setup resets the water answer and the register-based pre-fills.
Synced checklist items carry `auto` with the reason when the auditor left
a pre-fill as-is.

**GPS vs. register.** Capturing GPS on Setup compares the fix with the
point's coordinates in the register. More than 50 m away
(`GPS_WARN_METERS`) → an alert that the auditor may be at the wrong water
point, and a red line under the button; within 50 m → a green
confirmation. It warns, it doesn't block (the register's coordinates
aren't always exact). 30 of the 332 Public Water Points have no
coordinates on file, so there's nothing to compare against for those.
The distance is shown on Review and exported as `gpsDistanceM`.

**Test mode.** Globe icon → scroll down → "Turn on test mode". While it's
on, a banner and an amber edge on the top bar make it obvious, every new
audit is marked as a test for good (`test: true`, "Test" chip on Home),
and Sync sends nothing at all — test audits are just marked synced on the
device, real audits stay queued until test mode is off. Test audits are
never sent even after test mode is turned off, and `/api/sync` refuses to
store one as a second guard, so nothing reaches Blob storage, the admin
page, the Sheet, or the Drive photo routine. "My route" badges and
"resume this stop" only consider audits of the current mode, so a test
run never makes a real stop look done. Turning test mode off offers to
delete the test audits from the device.

## Local storage (on-device)

Changed 2026-09-28 (`lib/idbStore.js`). Every audit lives on-device until
Sync, same as always — what changed is *where*. It used to be one JSON
blob in `localStorage`, which most browsers cap at somewhere around 5-10MB
per origin no matter what; that cap turned out to be the real reason
volunteers kept hitting "no space for photos" even right after syncing —
not anything about compression or the post-sync cleanup (still in place,
see below). IndexedDB doesn't have that fixed ceiling; its quota is a share
of the device's free disk space, typically hundreds of MB at minimum.

Two object stores: `audits` (one row per audit, keyed by its own `id` —
persisting a change to one audit no longer means re-serializing every
other audit on the device, unlike the old single-blob approach) and
`prefs` (one row per remembered preference — language, volunteer, last
ward/village, etc.).

**Keeping every existing call site working unchanged:** `audits` and the
prefs cache stay as plain in-memory values, populated once at boot and
read/written synchronously everywhere in `lib/engine.js` exactly as
before — only the underlying persistence is now async, fired off in the
background from `save()`/`pref()` without blocking the caller. The one
place this is awaited is `mount()`'s startup, which loads everything from
IndexedDB (and runs the one-time migration below) before the first
real screen renders.

**Migration from the old version:** the first time this version runs on a
device that still has data in the old `localStorage` keys
(`karimu.audits.v2`, `karimu.prefs.v1`), it's copied into IndexedDB once
(gated by a `__migratedFromLocalStorage` pref so it never runs twice or
clobbers newer IndexedDB data with stale localStorage data), and the old
keys are then cleared — reclaiming that space is the whole point. A
device that was already using IndexedDB, or a brand new install, skips
this entirely.

The still-in-place photo space-saving pipeline — shrinking new photos
client-side, swapping a synced photo's local base64 for its Blob URL right
after sync, and retroactively reclaiming space for anything already synced
— all works exactly as before; only the storage it reads from and writes
to changed.

The Sync screen's "MB on device" tile now reads `navigator.storage.estimate()`
instead of measuring one `localStorage` key's string length — a live
estimate of this whole origin's on-device storage (not just audits), refreshed
each time that screen renders. The app also asks the browser not to evict
this origin's storage under pressure via `navigator.storage.persist()` on
boot (best-effort — notably unsupported on iOS Safari, and Chrome only
auto-grants it based on its own engagement heuristics; nothing here depends
on it being granted).

## Sync storage, admin page, and reporting

Changed 2026-08-26. The original design synced straight into Google
Sheets/Drive using a Google Cloud service account — that needs real IT
setup (a GCP project, enabled APIs, a service account, a JSON key, sharing
files with it) that isn't happening for this project. `app/api/sync/route.js`
now saves each completed audit to **Vercel Blob** instead (`lib/blobStore.js`)
— no Google Cloud step at all, just one toggle in Vercel.

**To activate it:** in the Vercel project, Storage tab → create a Blob
store → connect it to this project. That's the whole setup — Vercel
injects `BLOB_READ_WRITE_TOKEN` automatically, and `/api/sync` picks it up
on the next deploy. Until it's connected, `/api/sync` returns a clear
"not configured" response and every audit just stays queued on the
device — nothing is lost, it just can't leave the phone yet. The client's
manual "Export JSON" backup button still works regardless, as a fallback.

Each synced audit becomes one JSON blob (`audits/{auditId}.json`) plus one
blob per photo (`photos/{auditId}/{filename}.jpg`, publicly viewable at its
own URL — no signing needed). Re-syncing the same audit overwrites its
blob rather than duplicating it (`allowOverwrite: true` on both `put()`
calls in `lib/blobStore.js`, added 2026-09-12 — without it, re-syncing
after any partial failure hit "This blob already exists" and the retry
could never get through).

### Admin page

`/admin` on the deployed site — a shared-keyword gate (not per-person
accounts), default keyword `K@rimu` (`ADMIN_PASSWORD` in `lib/adminAuth.js`;
**set a real value in Vercel's environment variables before this is used
for anything that matters** — the fallback is sitting in this repo's
source). Behind it: a table of every synced audit and every occurrence
(issue) with a link to its photo(s), read live from Blob storage — nothing
is copied or cached, so it's always current as of the last sync.

A **"Delete all synced audits"** button (added 2026-09-12) wipes every
audit and photo blob in one go — for clearing out test data between
testing rounds, or before the real mission starts. It's a hard delete
straight from `/api/admin/reset` (`deleteAll()` in `lib/blobStore.js`),
gated behind a confirm dialog, disabled with nothing to delete, and there
is no undo — any copy the daily Drive-photos routine already uploaded to
Google Drive is a separate copy and is untouched by it.

There's deliberately no "generate report" button on the page itself — see
below for why.

### Getting the data into an actual Google Sheet + Drive photos

Edu's Google Drive is connected to Claude directly (no service account
needed for this part), but that connector only has generic file
operations (create/read/search) — no Google Sheets cell-editing API. So
updating one persistent spreadsheet's *cells* from server code, or from
Claude's Drive tools, isn't possible; only creating brand-new files is.
The workaround that needs no API access at all: Google Sheets'
`IMPORTDATA()` formula, which fetches a URL's CSV content itself and
refreshes it automatically every couple of hours (and on open) — no app
code, no scheduled task, nothing to maintain.

One-time setup, done once by a human in the actual spreadsheet (the admin
page shows the exact text once you've logged in, with your own keyword
already filled in):

1. Open the target spreadsheet — as of 2026-08-26, [Water Points Audit
   Results](https://docs.google.com/spreadsheets/d/1PMCZa1GW77uCNAnuo51KTBUti9RH-_B1vFxEOVBj-Ag/edit).
2. Rename its first tab to `Findings`; add a second tab named `Audits`.
3. In `Findings!A1`: `=IMPORTDATA("https://<deployment-url>/api/admin/export?tab=findings&format=csv&key=<ADMIN_PASSWORD>")`
4. In `Audits!A1`: the same URL with `tab=audits`.

`key=` on that URL is the same shared keyword as the admin page — it's
there because `IMPORTDATA` can't send a cookie or an `Authorization`
header, only fetch a plain URL, so the keyword has to travel in the query
string for this one legitimate use.

**Photos still need a real copy in Drive** — `IMPORTDATA` only pulls text,
so an occurrence's photo(s) stay Blob-storage URLs in the sheet (also
directly viewable, just not "in Karimu's Drive" the way Edu wants for the
Shared Drive backup) until something actually uploads them. That
something is a daily scheduled Claude routine (set up 2026-08-26, `19:00`
Tanzania time / `16:00` UTC): it reads the Findings export, and for every
occurrence's photo not already sitting in the
["Water Points Maintenance"](https://drive.google.com/drive/folders/1aXy3R_WFnQy2jNtxuAh97H-96zC7oYcH)
Drive folder (checked by filename — same filename scheme as the Blob
storage path, so a row's `photoFilenames` column and the file sitting in
Drive always match by name, with nothing else needed to correlate them),
downloads it from its Blob URL and re-uploads it there. Idempotent by
design — running it twice in a row just finds everything already present
and uploads nothing.

Ask Claude directly in a chat any time for an on-demand run of that same
photo-upload step, or to re-generate/inspect the report by another means —
this section describes the mechanism, not a fixed procedure Claude has to
follow verbatim if a better one is obviously available later.

## Language / i18n

The interface can be shown in English, Spanish, or Portuguese. A volunteer
picks a language the first time they open the app (before starting any
audit); it's remembered on that device from then on, and can be changed
any time from the globe icon in the top bar.

This is a **display-only** layer — `lib/i18n.js` holds the UI strings and
translated checklist labels for `es`/`pt`, looked up through two helpers
(`tr()` for checklist/label text, `ui()` for interface strings) that fall
back to English if a translation is ever missing. Everything that gets
saved locally and sent to `/api/sync` — section/group/statement text,
school names, building names, dates, notes — always comes from
`lib/checklists.js` in canonical English, completely untouched by the
selected display language. That's deliberate: the spreadsheet and Drive
records stay in one consistent language regardless of which volunteer
audited which building.

Adding a fourth language means adding one more entry to `LANGUAGES` and
one more language block to `TEXT`/`UI_STRINGS` in `lib/i18n.js` — nothing
in `lib/checklists.js` or the backend needs to change.

The water point checklist's section/group names and all 58 unique
statement strings (`WATER_POINT_SECTIONS` and — dormant for now, see
above — `WATER_TANK_SECTIONS` in `lib/checklists.js`) are translated into
es/pt in `TEXT`. (An earlier version of this app shipped with only the
section/group names translated; a field test in pt surfaced English
statement text throughout the checklist, which is what prompted adding
the rest.) If new statements are ever added to those sections, add
matching `es`/`pt` entries in `TEXT` in the same pass — `tr()`'s English
fallback means a missed one won't error, it'll just quietly show English.

## What's ported from the prototype, what's new

- Newest: water point audits (this is the audit type actually in use —
  see above). Ward/Village/Sub-Village/Asset Tag picker in
  `lib/waterAssets.js`, checklist content in `lib/checklists.js`
  (`WATER_POINT_SECTIONS` / `WATER_TANK_SECTIONS`), setup screen and
  review screen changes in `lib/engine.js`.
- Newer still: volunteer identification and "My route" (map + suggested
  visiting order + tap-to-start) — see "Volunteer identification and
  routes" above.
- Same checklists, same applicability rules, same offline-first local
  storage, same "All OK" / "Rest OK" shortcuts, same completed-audit gate.
- New: this runs as a normal website, not inside a sandboxed preview, so it
  can be installed as a PWA (`app/manifest.js`, `public/sw.js`) and — this is
  the actual point of moving it here — it can make real network calls. Sync
  now POSTs to `/api/sync` instead of only offering a local file save.
- **Resolved 2026-09-28:** audit data (including photos) used to be cached
  in the browser's `localStorage`, which has a hard several-MB ceiling per
  origin regardless of how well photos are compressed — the actual wall
  behind volunteers hitting "no space for photos" even right after syncing.
  Local storage is now IndexedDB (`lib/idbStore.js`), whose quota is a share
  of the device's free disk space instead — see "Local storage" below.
- Added 2026-09-12, for real field use with practically no connectivity:
  - Every audit — draft, finished-but-unsynced, or already synced — can be
    deleted straight from the home screen's list (trash icon on each row),
    fully offline. The confirm message is tailored to what's actually at
    stake: a draft, a finished audit that hasn't left the device yet
    (including its photos — nothing to fall back on), or just the local
    copy of one already safely synced.
  - The checklist screen has a "← Back" button next to "Save & close" that
    returns to the home menu and discards the audit entirely (with a
    confirm first) — for when a volunteer wants to abandon an audit rather
    than keep it as a draft.
  - A free-text "General comments" field on the review screen
    (`a.comment`, carried through `auditRecord()` into the synced record,
    the CSV export, and the admin table).
  - The stale "you'll need to move the photos to Drive by hand" messaging
    is gone from the Sync screen — it described the old manual-export
    flow, not the current direct-to-Blob sync.
  - `public/sw.js` rewritten: `/_next/static/*` (content-hashed JS/CSS
    chunks) are served cache-first, so they load instantly with zero
    network dependency once cached, instead of racing a doomed fetch every
    time the device is offline. Everything else same-origin stays
    network-first but is now raced against a 2.5s timeout so a dead or
    very slow connection falls back to the cached shell immediately
    instead of leaving a tap hanging. `app/page.js`'s `import("@/lib/engine")`
    (the module that attaches every click handler on the page — if it
    fails to load, every button silently does nothing) now retries once
    on failure.
