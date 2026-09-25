"use client";

import { useEffect, useState } from "react";

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function AdminPage() {
  const [status, setStatus] = useState("checking"); // checking | locked | ready
  const [password, setPassword] = useState("");
  const [enteredPassword, setEnteredPassword] = useState(""); // kept in memory only, to build the IMPORTDATA formulas below without asking the server to echo the secret back
  const [error, setError] = useState("");
  const [audits, setAudits] = useState([]);
  const [findings, setFindings] = useState([]);
  const [loadError, setLoadError] = useState("");

  const [reloadKey, setReloadKey] = useState(0);
  function refresh() { setReloadKey((k) => k + 1); }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError("");
      const res = await fetch("/api/admin/data");
      if (cancelled) return;
      if (res.status === 401) { setStatus("locked"); return; }
      const body = await res.json().catch(() => null);
      if (cancelled) return;
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

  async function submitLogin(e) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) { setError("Wrong password."); return; }
    setEnteredPassword(password);
    setPassword("");
    setStatus("checking");
    refresh();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setEnteredPassword("");
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
          <p className="lede small">Enter the shared keyword to view synced audits.</p>
        </div>
        <form onSubmit={submitLogin} className="stack gap-10">
          <label className="field">
            <span>Keyword</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          {error ? <p className="small" style={{ color: "var(--issue)" }}>{error}</p> : null}
          <button className="btn btn-primary btn-block" type="submit">Enter</button>
        </form>
      </div>
    );
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const findingsFormula = enteredPassword
    ? `=IMPORTDATA("${origin}/api/admin/export?tab=findings&format=csv&key=${encodeURIComponent(enteredPassword)}")`
    : null;
  const auditsFormula = enteredPassword
    ? `=IMPORTDATA("${origin}/api/admin/export?tab=audits&format=csv&key=${encodeURIComponent(enteredPassword)}")`
    : null;

  return (
    <div className="admin-shell">
      <div className="hero">
        <span className="eyebrow">Karimu Field Audit</span>
        <h1>Admin</h1>
        <p className="lede small">
          {audits.length} synced audit{audits.length === 1 ? "" : "s"}, {findings.length} occurrence{findings.length === 1 ? "" : "s"} with an issue.
        </p>
      </div>

      {loadError ? (
        <div className="banner banner-warn" style={{ marginBottom: 20 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16v.5" /></svg>
          <div>{loadError}</div>
        </div>
      ) : null}

      {enteredPassword ? (
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
      ) : (
        <div className="banner banner-info" style={{ marginBottom: 24 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.5" /></svg>
          <div>Log in again (re-enter the keyword) to see the ready-to-paste Google Sheets formulas — they&rsquo;re only shown right after you type the keyword, since this page never asks the server for it back.</div>
        </div>
      )}

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
              </tr>
            ))}
            {!audits.length ? <tr><td colSpan={10} className="small" style={{ color: "var(--muted)" }}>No audits synced yet.</td></tr> : null}
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
