"use client";

import { useEffect, useState } from "react";

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// Why the Google sign-in bounced back to /admin (see
// app/api/auth/google/callback/route.js).
const SIGNIN_ERRORS = {
  domain: "Only @karimufoundation.org Google accounts can open the admin page. Sign in again and pick your Karimu account.",
  cancelled: "Google sign-in was cancelled.",
  state: "The sign-in link expired or was opened in a different browser. Please try again.",
  google: "Google sign-in didn't go through. Please try again.",
  not_configured: "Google sign-in isn't set up on this deployment yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Vercel). See the README.",
};

export default function AdminPage() {
  const [status, setStatus] = useState("checking"); // checking | locked | ready
  const [user, setUser] = useState(null);
  const [exportKey, setExportKey] = useState(null);
  const [googleReady, setGoogleReady] = useState(true);
  // A failed sign-in comes back as /admin?error=<reason>. Read once on the
  // client; it's only displayed on the "locked" screen, never the first
  // (server-rendered) "Loading…" one, so there's no hydration mismatch.
  const [error] = useState(() => {
    if (typeof window === "undefined") return "";
    const reason = new URLSearchParams(window.location.search).get("error");
    return reason ? SIGNIN_ERRORS[reason] || SIGNIN_ERRORS.google : "";
  });
  const [audits, setAudits] = useState([]);
  const [findings, setFindings] = useState([]);
  const [loadError, setLoadError] = useState("");

  const [reloadKey, setReloadKey] = useState(0);
  function refresh() { setReloadKey((k) => k + 1); }

  // Drop ?error= from the address bar so a reload doesn't repeat it.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError("");
      const res = await fetch("/api/admin/data");
      if (cancelled) return;
      const body = await res.json().catch(() => null);
      if (cancelled) return;
      if (res.status === 401) {
        setGoogleReady(!body || body.googleConfigured !== false);
        setStatus("locked");
        return;
      }
      if (body && body.user) setUser(body.user);
      if (body && body.exportKey) setExportKey(body.exportKey);
      if (!res.ok || !body || !body.ok) {
        setLoadError((body && body.message) || "Could not load data.");
        setStatus("ready");
        return;
      }
      setAudits(body.audits || []);
      setFindings(body.findings || []);
      setStatus("ready");
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setUser(null);
    setExportKey(null);
    setAudits([]);
    setFindings([]);
    setStatus("locked");
  }

  const [resetting, setResetting] = useState(false);
  async function resetAllData() {
    const warn = `Delete all ${audits.length} synced audit${audits.length === 1 ? "" : "s"} and their photos? This can't be undone.`;
    if (!window.confirm(warn)) return;
    setResetting(true);
    setLoadError("");
    try {
      const res = await fetch("/api/admin/reset", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        setLoadError((body && body.message) || "Could not delete the synced audits.");
        return;
      }
      refresh();
    } finally {
      setResetting(false);
    }
  }

  if (status === "checking") {
    return <div className="admin-shell"><p className="small" style={{ color: "var(--muted)" }}>Loading…</p></div>;
  }

  if (status === "locked") {
    return (
      <div className="admin-shell" style={{ maxWidth: 420 }}>
        <div className="hero">
          <span className="eyebrow">Karimu Field Audit</span>
          <h1>Admin</h1>
          <p className="lede small">Sign in with your @karimufoundation.org Google account to view synced audits.</p>
        </div>
        <div className="stack gap-10">
          {error ? <p className="small" style={{ color: "var(--issue)" }}>{error}</p> : null}
          {googleReady ? (
            // A plain link, not fetch: the sign-in is a full-page trip to
            // Google and back (see app/api/auth/google/login/route.js).
            <a className="btn btn-primary btn-block" href="/api/auth/google/login" style={{ textDecoration: "none" }}>Sign in with Google</a>
          ) : (
            <p className="small" style={{ color: "var(--issue)" }}>{SIGNIN_ERRORS.not_configured}</p>
          )}
        </div>
      </div>
    );
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const findingsFormula = exportKey
    ? `=IMPORTDATA("${origin}/api/admin/export?tab=findings&format=csv&key=${encodeURIComponent(exportKey.key)}")`
    : null;
  const auditsFormula = exportKey
    ? `=IMPORTDATA("${origin}/api/admin/export?tab=audits&format=csv&key=${encodeURIComponent(exportKey.key)}")`
    : null;

  return (
    <div className="admin-shell">
      <div className="hero">
        <span className="eyebrow">Karimu Field Audit</span>
        <h1>Admin</h1>
        <p className="lede small">
          {audits.length} synced audit{audits.length === 1 ? "" : "s"}, {findings.length} occurrence{findings.length === 1 ? "" : "s"} with an issue.
        </p>
        {user ? <p className="small" style={{ color: "var(--muted)", marginTop: 4 }}>Signed in as {user.email}</p> : null}
      </div>

      {loadError ? (
        <div className="banner banner-warn" style={{ marginBottom: 20 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.5" /></svg>
          <div>{loadError}</div>
        </div>
      ) : null}

      {exportKey && exportKey.isFallback ? (
        <div className="banner banner-warn" style={{ marginBottom: 20 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.5" /></svg>
          <div>
            The Google Sheets export key is still the default one, which is visible in this app&rsquo;s public source
            code — anyone with it can download every audit. Set <code>ADMIN_PASSWORD</code> to a new random value in
            the Vercel project&rsquo;s environment variables, redeploy, then paste the updated formulas below into the
            spreadsheet.
          </div>
        </div>
      ) : null}

      {exportKey ? (
        <div className="card" style={{ padding: 18, marginBottom: 24 }}>
          <div className="stack gap-10">
            <span className="eyebrow">Connect to Google Sheets</span>
            <p className="small" style={{ color: "var(--muted)" }}>
              Paste this once into cell A1 of a tab named &ldquo;Findings&rdquo; (and the other into a tab named
              &ldquo;Audits&rdquo;) in the report spreadsheet. Google refreshes it on its own — nothing more to run
              here. See the README for the full setup.
            </p>
            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Findings tab, cell A1:</div>
              <div className="copybox">{findingsFormula}</div>
            </div>
            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Audits tab, cell A1:</div>
              <div className="copybox">{auditsFormula}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 11 }}>
        <span className="eyebrow">Audits ({audits.length})</span>
        <span style={{ flex: 1 }} />
        <button className="backlink" onClick={refresh}>Refresh</button>
        <span style={{ width: 14 }} />
        <button
          className="backlink"
          style={{ color: "var(--issue)" }}
          onClick={resetAllData}
          disabled={resetting || !audits.length}
        >
          {resetting ? "Deleting…" : "Delete all synced audits"}
        </button>
        <span style={{ width: 14 }} />
        <button className="backlink" onClick={logout}>Log out</button>
      </div>
      <div className="table-scroll" style={{ marginBottom: 30 }}>
        <table className="datatable">
          <thead>
            <tr>
              <th>Synced</th><th>Ward</th><th>Village</th><th>Asset Tag</th>
              <th>Inspector</th><th>Date</th><th>Answered</th><th>Issues</th><th>Comment</th><th>Site Photo</th>
              <th>Water</th><th>GPS vs register</th><th>Valve key</th>
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <tr key={a.id}>
                <td>{fmtDate(a.syncedAt)}</td>
                <td>{a.ward}</td>
                <td>{a.village}</td>
                <td className="mono">{a.assetTag}</td>
                <td>{a.inspector}</td>
                <td className="mono">{a.date}</td>
                <td>{a.answeredCount}/{a.totalCount}</td>
                <td>{a.issueCount}</td>
                <td className="wrap-cell">{a.comment || "—"}</td>
                <td>{a.sitePhoto ? <a href={a.sitePhoto} target="_blank" rel="noreferrer">photo</a> : "—"}</td>
                <td>{a.hasWater === true ? "yes" : a.hasWater === false ? "no" : "—"}</td>
                <td className="mono" style={a.gpsDistanceM > 50 ? { color: "var(--issue)", fontWeight: 600 } : undefined}>
                  {a.gpsDistanceM == null ? "—" : `${a.gpsDistanceM} m`}
                </td>
                <td>{a.hasValveKey === true ? "yes" : a.hasValveKey === false ? "no" : "—"}</td>
              </tr>
            ))}
            {!audits.length ? <tr><td colSpan={13}className="small" style={{ color: "var(--muted)" }}>No audits synced yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginBottom: 11 }}>
        <span className="eyebrow">Occurrences ({findings.length})</span>
      </div>
      <div className="table-scroll">
        <table className="datatable">
          <thead>
            <tr>
              <th>Synced</th><th>Asset Tag</th><th>Section</th><th>Group</th>
              <th>Statement</th><th>Note</th><th>Photo(s)</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={i}>
                <td>{fmtDate(f.syncedAt)}</td>
                <td className="mono">{f.assetTag}</td>
                <td>{f.section}</td>
                <td>{f.group}</td>
                <td className="wrap-cell">{f.statement}</td>
                <td className="wrap-cell">{f.note}</td>
                <td className="wrap-cell">
                  {f.photoUrls
                    ? f.photoUrls.split(", ").map((u, j) => (
                        <a key={j} href={u} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                          {(f.photoFilenames.split(", ")[j] || `photo ${j + 1}`)}
                        </a>
                      ))
                    : "—"}
                </td>
              </tr>
            ))}
            {!findings.length ? <tr><td colSpan={7} className="small" style={{ color: "var(--muted)" }}>No occurrences yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
