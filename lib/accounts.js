// Auditor accounts and audit projects (2026-10-28) — server only.
//
// Stored as two small JSON files in a separate PRIVATE Vercel Blob store
// ("karimu-audit-accounts"), never in the public store the audits and
// photos live in: that store's URLs are public and its host appears in the
// photo links in the report spreadsheet, so anything there is one guess
// away from being readable. Private blobs need the server's credentials to
// read at all.
//
// The store is addressed by ACCOUNTS_STORE_ID with Vercel's OIDC auth.
// It has to be the store id, not a token: on Vercel the SDK ignores an
// explicit `token` whenever OIDC is available and BLOB_STORE_ID is set —
// which it is, for the public store — so passing only a token would
// silently read and write the PUBLIC store instead.
//
// Outside production with no store configured (local development), the
// same functions use JSON files in .accounts-dev/ so the flows can be
// tried without touching real data.
//
// Scale: tens of auditors and a handful of projects, edited by an admin
// now and then — whole-file read/modify/write is fine at that size.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { put, get } from "@vercel/blob";

const USERS = "users.json";
const PROJECTS = "projects.json";
const INVITE_DAYS = 7;
const MIN_PASSWORD = 8;

const storeId = () => process.env.ACCOUNTS_STORE_ID;
const devDir = () => path.join(process.cwd(), ".accounts-dev");
const devFilesMode = () => !storeId() && process.env.NODE_ENV !== "production";

export function accountsConfigured() {
  return Boolean(storeId()) || devFilesMode();
}

async function readJson(name) {
  if (devFilesMode()) {
    try { return JSON.parse(await fs.readFile(path.join(devDir(), name), "utf8")); }
    catch { return []; }
  }
  const res = await get(name, { access: "private", storeId: storeId(), useCache: false });
  if (!res || res.statusCode !== 200) return [];
  return JSON.parse(await new Response(res.stream).text());
}

async function writeJson(name, data) {
  const body = JSON.stringify(data, null, 1);
  if (devFilesMode()) {
    await fs.mkdir(devDir(), { recursive: true });
    await fs.writeFile(path.join(devDir(), name), body);
    return;
  }
  await put(name, body, {
    access: "private", storeId: storeId(), contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true,
  });
}

/* ---------- passwords and one-time tokens ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
function checkPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}
// Invite links carry a random token; only its SHA-256 is stored, so the
// accounts file alone can't be used to claim an account.
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");
function newInvite() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, record: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString() } };
}

export class AccountError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** What the admin page and API responses may see — never hashes. */
export function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, active: u.active,
    hasPassword: Boolean(u.passwordHash),
    inviteExpiresAt: u.invite ? u.invite.expiresAt : null,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  };
}

/* ---------- users ---------- */

export async function listUsers() {
  return readJson(USERS);
}

export async function getUser(id) {
  return (await readJson(USERS)).find((u) => u.id === id) || null;
}

/** Returns { user, inviteToken } — the token is shown to the admin once. */
export async function createUser({ name, email }) {
  name = String(name || "").trim();
  email = normEmail(email);
  if (!name) throw new AccountError("bad_request", "Name is required.");
  if (!validEmail(email)) throw new AccountError("bad_request", "That email address doesn't look right.");
  const users = await readJson(USERS);
  if (users.some((u) => u.email === email)) throw new AccountError("conflict", "There's already an auditor with that email.");
  const { token, record } = newInvite();
  const user = {
    id: "U-" + crypto.randomBytes(6).toString("hex"), name, email,
    passwordHash: null, invite: record, active: true, sessionVersion: 1,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await writeJson(USERS, users);
  return { user, inviteToken: token };
}

async function updateUser(id, fn) {
  const users = await readJson(USERS);
  const user = users.find((u) => u.id === id);
  if (!user) throw new AccountError("not_found", "Auditor not found.");
  const result = fn(user, users);
  await writeJson(USERS, users);
  return result === undefined ? user : result;
}

/** New invite link (also how a forgotten password gets reset). The old
 * link stops working; the current password keeps working until the new
 * link is used. */
export async function reinviteUser(id) {
  return updateUser(id, (u) => {
    const { token, record } = newInvite();
    u.invite = record;
    return { user: u, inviteToken: token };
  });
}

export async function editUser(id, { name, email }) {
  return updateUser(id, (u, users) => {
    if (name !== undefined) {
      name = String(name).trim();
      if (!name) throw new AccountError("bad_request", "Name is required.");
      u.name = name;
    }
    if (email !== undefined) {
      email = normEmail(email);
      if (!validEmail(email)) throw new AccountError("bad_request", "That email address doesn't look right.");
      if (users.some((x) => x.id !== u.id && x.email === email)) throw new AccountError("conflict", "There's already an auditor with that email.");
      u.email = email;
    }
  });
}

/** Deactivating also bumps sessionVersion, which signs the auditor out
 * of every device the next time it talks to the server. */
export async function setUserActive(id, active) {
  return updateUser(id, (u) => {
    u.active = Boolean(active);
    if (!u.active) { u.sessionVersion = (u.sessionVersion || 1) + 1; u.invite = null; }
  });
}

function findByInvite(users, token) {
  if (typeof token !== "string" || !token) return null;
  const h = sha256(token);
  const u = users.find((x) => x.invite && x.invite.tokenHash === h);
  if (!u || !u.active || new Date(u.invite.expiresAt) < new Date()) return null;
  return u;
}

export async function userForInvite(token) {
  return findByInvite(await readJson(USERS), token);
}

/** Sets the password from an invite link and uses the link up. Bumps
 * sessionVersion so any device signed in with an old password is signed
 * out (this is also the password-reset path). */
export async function acceptInvite(token, password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new AccountError("weak_password", `The password must be at least ${MIN_PASSWORD} characters.`);
  }
  const users = await readJson(USERS);
  const u = findByInvite(users, token);
  if (!u) throw new AccountError("invalid_invite", "This invite link is no longer valid. Ask the admin for a new one.");
  u.passwordHash = hashPassword(password);
  u.invite = null;
  u.sessionVersion = (u.sessionVersion || 1) + 1;
  u.lastLoginAt = new Date().toISOString();
  await writeJson(USERS, users);
  return u;
}

export async function verifyLogin(email, password) {
  const users = await readJson(USERS);
  const u = users.find((x) => x.email === normEmail(email));
  // Hash even when there's no such user, so response time doesn't reveal
  // which emails have accounts.
  const ok = checkPassword(password, u && u.passwordHash ? u.passwordHash : "scrypt$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86));
  if (!u || !u.active || !u.passwordHash || !ok) return null;
  u.lastLoginAt = new Date().toISOString();
  await writeJson(USERS, users);
  return u;
}

/* ---------- projects ---------- */
// A project hands the existing water-point groups (1-24, see
// lib/waterAssets.js) to auditors: assignments are [{group, userId, day}].
// Only active projects show up on auditors' devices.

export async function listProjects() {
  return readJson(PROJECTS);
}

export async function createProject({ name }) {
  name = String(name || "").trim();
  if (!name) throw new AccountError("bad_request", "Project name is required.");
  const projects = await readJson(PROJECTS);
  const project = { id: "P-" + crypto.randomBytes(5).toString("hex"), name, active: true, assignments: [], createdAt: new Date().toISOString() };
  projects.push(project);
  await writeJson(PROJECTS, projects);
  return project;
}

export async function updateProject(id, { name, active, assignments }, validGroups, validUserIds) {
  const projects = await readJson(PROJECTS);
  const p = projects.find((x) => x.id === id);
  if (!p) throw new AccountError("not_found", "Project not found.");
  if (name !== undefined) {
    name = String(name).trim();
    if (!name) throw new AccountError("bad_request", "Project name is required.");
    p.name = name;
  }
  if (active !== undefined) p.active = Boolean(active);
  if (assignments !== undefined) {
    if (!Array.isArray(assignments)) throw new AccountError("bad_request", "Assignments must be a list.");
    const seen = new Set();
    p.assignments = assignments.map((a) => {
      const group = Number(a.group), day = Number(a.day);
      if (!validGroups.has(group)) throw new AccountError("bad_request", `Unknown group ${a.group}.`);
      if (seen.has(group)) throw new AccountError("bad_request", `Group ${group} is assigned twice.`);
      seen.add(group);
      if (!validUserIds.has(a.userId)) throw new AccountError("bad_request", `Unknown auditor for group ${group}.`);
      if (!Number.isInteger(day) || day < 1 || day > 60) throw new AccountError("bad_request", `Day for group ${group} must be a whole number from 1 to 60.`);
      return { group, userId: a.userId, day };
    });
  }
  p.updatedAt = new Date().toISOString();
  await writeJson(PROJECTS, projects);
  return p;
}

export async function deleteProject(id) {
  const projects = await readJson(PROJECTS);
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) throw new AccountError("not_found", "Project not found.");
  await writeJson(PROJECTS, next);
}

/** Everything assigned to one auditor across active projects. */
export async function assignmentsFor(userId) {
  const out = [];
  for (const p of await readJson(PROJECTS)) {
    if (!p.active) continue;
    for (const a of p.assignments) {
      if (a.userId === userId) out.push({ projectId: p.id, projectName: p.name, group: a.group, day: a.day });
    }
  }
  return out.sort((a, b) => a.day - b.day || a.group - b.group);
}
