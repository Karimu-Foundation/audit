"use client";

// Auditor accounts and audit projects on the admin page (2026-10-28).
// Backed by /api/admin/accounts; see lib/accounts.js for how things are
// stored and why.

import { useEffect, useState } from "react";

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");

async function call(body) {
  const res = await fetch("/api/admin/accounts", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

function userStatus(u) {
  if (!u.active) return { label: "Deactivated", color: "var(--muted)" };
  if (u.hasPassword) return { label: "Active", color: "var(--ok)" };
  if (u.inviteExpiresAt && new Date(u.inviteExpiresAt) > new Date()) return { label: `Invite sent · until ${fmtDate(u.inviteExpiresAt)}`, color: "var(--accent)" };
  return { label: "Invite expired", color: "var(--issue)" };
}

/** The link shown once after creating an auditor or asking for a new one. */
function InviteBox({ invite, user, onClose }) {
  const [copied, setCopied] = useState(false);
  const message = `Hi ${user ? user.name : ""}! This is your access to the Karimu Field Audit app. Open this link on your phone to create your password (valid until ${fmtDate(invite.expiresAt)}): ${invite.url}`;
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: "var(--accent)" }}>
      <div className="stack gap-10">
        <strong>Invite link for {user ? user.name : "the auditor"}</strong>
        <p className="small" style={{ margin: 0, color: "var(--muted)" }}>
          Send this to them by WhatsApp or email. It&rsquo;s shown only now, works once, and expires on {fmtDate(invite.expiresAt)}.
          If it&rsquo;s lost, just create a new one.
        </p>
        <div className="copybox" style={{ wordBreak: "break-all" }}>{invite.url}</div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => navigator.clipboard.writeText(invite.url).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <a className="btn btn-ghost" style={{ textDecoration: "none" }} target="_blank" rel="noreferrer"
             href={"https://wa.me/?text=" + encodeURIComponent(message)}>Send by WhatsApp</a>
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function ProjectEditor({ project, users, groups, onSave, onToggle, onDelete, busy }) {
  const byGroup = Object.fromEntries(project.assignments.map((a) => [a.group, a]));
  const [rows, setRows] = useState(() => Object.fromEntries(
    groups.map((g) => [g.group, { userId: byGroup[g.group]?.userId || "", day: byGroup[g.group]?.day || g.plannedDay }]),
  ));
  const set = (group, patch) => setRows((r) => ({ ...r, [group]: { ...r[group], ...patch } }));
  const active = users.filter((u) => u.active);
  const perAuditor = active
    .map((u) => ({ u, gs: groups.filter((g) => rows[g.group].userId === u.id) }))
    .filter((x) => x.gs.length);
  const dirty = groups.some((g) => (byGroup[g.group]?.userId || "") !== rows[g.group].userId
    || (rows[g.group].userId && Number(byGroup[g.group]?.day) !== Number(rows[g.group].day)));

  function save() {
    onSave(groups.filter((g) => rows[g.group].userId).map((g) => ({ group: g.group, userId: rows[g.group].userId, day: Number(rows[g.group].day) })));
  }

  return (
    <div className="card" style={{ padding: 18, marginBottom: 18 }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <strong style={{ fontSize: 16 }}>{project.name}</strong>
        <span className="small" style={{ color: project.active ? "var(--ok)" : "var(--muted)" }}>
          {project.active ? "Active — auditors see their groups" : "Inactive — hidden from auditors"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="backlink" disabled={busy} onClick={onToggle}>{project.active ? "Deactivate" : "Activate"}</button>
        <button className="backlink" style={{ color: "var(--issue)" }} disabled={busy} onClick={onDelete}>Delete project</button>
      </div>

      {perAuditor.length ? (
        <p className="small" style={{ margin: "0 0 12px" }}>
          {perAuditor.map(({ u, gs }) => `${u.name}: ${gs.length} group${gs.length === 1 ? "" : "s"} (day${gs.length === 1 ? "" : "s"} ${[...new Set(gs.map((g) => rows[g.group].day))].sort((a, b) => a - b).join(", ")})`).join(" · ")}
        </p>
      ) : <p className="small" style={{ margin: "0 0 12px", color: "var(--muted)" }}>No groups assigned yet.</p>}

      <div className="table-scroll">
        <table className="datatable">
          <thead><tr><th>Group</th><th>Water points</th><th>Villages</th><th>Auditor</th><th>Day</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.group}>
                <td className="mono">{g.group}</td>
                <td>{g.count}</td>
                <td className="wrap-cell">{g.villages.join(", ") || "—"}</td>
                <td>
                  <select style={{ minWidth: 180 }} value={rows[g.group].userId} onChange={(e) => set(g.group, { userId: e.target.value })}>
                    <option value="">— not assigned —</option>
                    {active.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </td>
                <td>
                  <input type="number" min={1} max={60} style={{ width: 64 }} value={rows[g.group].day}
                         disabled={!rows[g.group].userId}
                         onChange={(e) => set(g.group, { day: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12, gap: 10 }}>
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save assignments"}</button>
        {dirty ? <span className="small" style={{ color: "var(--issue)" }}>Unsaved changes</span> : null}
      </div>
    </div>
  );
}

export default function AccountsPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(null);
  const [newUser, setNewUser] = useState({ name: "", email: "" });
  const [newProject, setNewProject] = useState("");

  useEffect(() => {
    call().then(setData).catch((e) => setError(e.message));
  }, []);

  async function run(body) {
    setBusy(true); setError("");
    try {
      const d = await call(body);
      setData(d);
      if (d.invite) setInvite(d.invite);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return error
      ? <div className="banner banner-warn" style={{ marginBottom: 24 }}><div>{error}</div></div>
      : <p className="small" style={{ color: "var(--muted)" }}>Loading auditors…</p>;
  }
  const userById = Object.fromEntries(data.users.map((u) => [u.id, u]));

  return (
    <div style={{ marginBottom: 36 }}>
      {error ? <div className="banner banner-warn" style={{ marginBottom: 16 }}><div>{error}</div></div> : null}

      <div className="row" style={{ marginBottom: 11 }}><span className="eyebrow">Auditors ({data.users.length})</span></div>
      {invite ? <InviteBox invite={invite} user={userById[invite.userId]} onClose={() => setInvite(null)} /> : null}

      <form className="card row" style={{ padding: 14, gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run({ action: "createUser", ...newUser })) setNewUser({ name: "", email: "" });
            }}>
        <label className="field" style={{ flex: "1 1 180px" }}><span>Name</span>
          <input value={newUser.name} required onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></label>
        <label className="field" style={{ flex: "1 1 220px" }}><span>Email</span>
          <input type="email" value={newUser.email} required onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></label>
        <button className="btn btn-primary" type="submit" disabled={busy}>Add auditor</button>
      </form>

      <div className="table-scroll" style={{ marginBottom: 30 }}>
        <table className="datatable">
          <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>
            {data.users.map((u) => {
              const st = userStatus(u);
              return (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td style={{ color: st.color }}>{st.label}</td>
                  <td>{fmtDate(u.lastLoginAt)}</td>
                  <td>
                    {u.active ? (
                      <>
                        <button className="backlink" disabled={busy} onClick={() => run({ action: "reinviteUser", userId: u.id })}>
                          {u.hasPassword ? "Reset password (new link)" : "New invite link"}
                        </button>
                        <span style={{ width: 12, display: "inline-block" }} />
                        <button className="backlink" style={{ color: "var(--issue)" }} disabled={busy}
                                onClick={() => window.confirm(`Deactivate ${u.name}? They'll be signed out of every device the next time it syncs.`) && run({ action: "setUserActive", userId: u.id, active: false })}>
                          Deactivate
                        </button>
                      </>
                    ) : (
                      <button className="backlink" disabled={busy} onClick={() => run({ action: "setUserActive", userId: u.id, active: true })}>Reactivate</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!data.users.length ? <tr><td colSpan={5} className="small" style={{ color: "var(--muted)" }}>No auditors yet — add the first one above.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginBottom: 11 }}><span className="eyebrow">Audit projects ({data.projects.length})</span></div>
      <p className="small" style={{ color: "var(--muted)", margin: "0 0 12px" }}>
        A project hands the {data.groups.length} water-point groups to auditors, with a field day for each. Auditors see their
        groups under &ldquo;My route&rdquo; the next time their phone has signal.
      </p>
      <form className="card row" style={{ padding: 14, gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run({ action: "createProject", name: newProject })) setNewProject("");
            }}>
        <label className="field" style={{ flex: "1 1 260px" }}><span>New project name</span>
          <input value={newProject} required placeholder="e.g. Water points audit — Nov 2026" onChange={(e) => setNewProject(e.target.value)} /></label>
        <button className="btn btn-primary" type="submit" disabled={busy}>Create project</button>
      </form>

      {data.projects.map((p) => (
        <ProjectEditor
          key={p.id + (p.updatedAt || "")}
          project={p} users={data.users} groups={data.groups} busy={busy}
          onSave={(assignments) => run({ action: "updateProject", projectId: p.id, assignments })}
          onToggle={() => run({ action: "updateProject", projectId: p.id, active: !p.active })}
          onDelete={() => window.confirm(`Delete the project "${p.name}"? Auditors lose these group assignments. Synced audits are not affected.`) && run({ action: "deleteProject", projectId: p.id })}
        />
      ))}
    </div>
  );
}
