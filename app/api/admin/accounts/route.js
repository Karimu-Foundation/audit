import { isAuthorized } from "@/lib/adminAuth";
import {
  accountsConfigured, listUsers, listProjects, publicUser, AccountError,
  createUser, reinviteUser, editUser, setUserActive,
  createProject, updateProject, deleteProject,
} from "@/lib/accounts";
import { getGroups } from "@/lib/waterAssets";

export const runtime = "nodejs";

// Admin side of auditor accounts and audit projects (Google sign-in only,
// like the rest of /admin). Invite links are returned once, right after
// creating an auditor or asking for a new link, and never stored in a
// readable form — the admin copies it and sends it by WhatsApp or email.

function unauthorized() {
  return Response.json({ ok: false, message: "Not authorized." }, { status: 401 });
}
function notConfigured() {
  return Response.json({ ok: false, code: "not_configured", message: "The private accounts store isn't connected to this deployment yet (missing ACCOUNTS_STORE_ID). See the README." }, { status: 503 });
}
const inviteUrl = (request, token) => new URL("/?invite=" + encodeURIComponent(token), request.url).toString();

async function snapshot() {
  const [users, projects] = await Promise.all([listUsers(), listProjects()]);
  return { users: users.map(publicUser), projects, groups: getGroups() };
}

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  if (!accountsConfigured()) return notConfigured();
  return Response.json({ ok: true, ...(await snapshot()) });
}

export async function POST(request) {
  if (!isAuthorized(request)) return unauthorized();
  if (!accountsConfigured()) return notConfigured();
  const b = await request.json().catch(() => ({}));
  try {
    let extra = {};
    switch (b.action) {
      case "createUser": {
        const { user, inviteToken } = await createUser(b);
        extra = { invite: { userId: user.id, url: inviteUrl(request, inviteToken), expiresAt: user.invite.expiresAt } };
        break;
      }
      case "reinviteUser": {
        const { user, inviteToken } = await reinviteUser(b.userId);
        extra = { invite: { userId: user.id, url: inviteUrl(request, inviteToken), expiresAt: user.invite.expiresAt } };
        break;
      }
      case "editUser": await editUser(b.userId, b); break;
      case "setUserActive": await setUserActive(b.userId, b.active); break;
      case "createProject": await createProject(b); break;
      case "updateProject": {
        const users = await listUsers();
        await updateProject(
          b.projectId, b,
          new Set(getGroups().map((g) => g.group)),
          new Set(users.filter((u) => u.active).map((u) => u.id)),
        );
        break;
      }
      case "deleteProject": await deleteProject(b.projectId); break;
      default: return Response.json({ ok: false, message: "Unknown action." }, { status: 400 });
    }
    return Response.json({ ok: true, ...extra, ...(await snapshot()) });
  } catch (err) {
    if (err instanceof AccountError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
      return Response.json({ ok: false, code: err.code, message: err.message }, { status });
    }
    throw err;
  }
}
