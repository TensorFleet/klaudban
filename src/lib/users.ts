/**
 * Team users store.
 *
 * Users start from `klaudban.config.json` and can be auto-created when a
 * reverse-proxy auth identity (Caddy/AuthCrunch) arrives for someone who
 * is not yet in the list. New members are persisted back into the config
 * file so they survive restarts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG, type TeamUser } from './config';
import { identityFromHeaders, type RequestIdentity } from './auth';

const CONFIG_FILENAME = 'klaudban.config.json';
const DEFAULT_EMOJI = '👤';

let users: TeamUser[] = normalizeUsers(CONFIG.users ?? []);
let writeQueue: Promise<void> = Promise.resolve();

function configPath(): string {
  return resolve(process.cwd(), CONFIG_FILENAME);
}

function normalizeUsers(list: TeamUser[]): TeamUser[] {
  const seen = new Set<string>();
  const out: TeamUser[] = [];
  for (const u of list) {
    if (!u?.id) continue;
    const id = String(u.id).trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: (u.label && String(u.label).trim()) || id,
      emoji: u.emoji || DEFAULT_EMOJI,
    });
  }
  return out;
}

function reloadFromDisk(): void {
  try {
    const path = configPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { users?: TeamUser[] };
    if (Array.isArray(raw.users)) {
      users = normalizeUsers(raw.users);
    }
  } catch {
    // Keep the in-memory list if the file is temporarily unreadable.
  }
}

function persistUsers(next: TeamUser[]): void {
  const path = configPath();
  let base: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      base = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    base = {};
  }
  base.users = next;
  writeFileSync(path, JSON.stringify(base, null, 2) + '\n', 'utf8');
}

/** Current team members (config + any auto-created auth users). */
export function listUsers(): TeamUser[] {
  return users.slice();
}

export function findUser(id: string | null | undefined): TeamUser | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  return users.find((u) => u.id === key) ?? null;
}

/**
 * Ensure the authenticated principal exists in the users list.
 * Creates + persists a new entry when missing. No-op without auth headers.
 */
export function ensureUserFromHeaders(headers: Headers): TeamUser | null {
  const identity = identityFromHeaders(headers);
  if (!identity) return null;
  return ensureUser(identity);
}

export function ensureUser(identity: RequestIdentity): TeamUser {
  reloadFromDisk();
  const existing = users.find((u) => u.id === identity.id);
  if (existing) {
    // Refresh label if we only had a placeholder and now have a real name.
    if (
      identity.label &&
      identity.label !== existing.label &&
      (existing.label === existing.id || existing.label === identity.email)
    ) {
      const updated = users.map((u) =>
        u.id === existing.id ? { ...u, label: identity.label } : u,
      );
      users = updated;
      enqueuePersist(updated);
      return updated.find((u) => u.id === existing.id)!;
    }
    return existing;
  }

  const created: TeamUser = {
    id: identity.id,
    label: identity.label,
    emoji: DEFAULT_EMOJI,
  };
  const next = [...users, created];
  users = next;
  enqueuePersist(next);
  return created;
}

function enqueuePersist(next: TeamUser[]): void {
  writeQueue = writeQueue
    .then(() => {
      persistUsers(next);
    })
    .catch((err) => {
      console.error('[users] failed to persist klaudban.config.json users:', err);
    });
}

/**
 * If the request has auth headers and the body did not set an assignee,
 * default to the logged-in user (after ensuring they exist in the list).
 */
export function defaultAssigneeFromHeaders(
  headers: Headers,
  assignee: string | null | undefined,
): string | null {
  if (assignee != null && String(assignee).trim() !== '') {
    return String(assignee).trim().toLowerCase();
  }
  const user = ensureUserFromHeaders(headers);
  return user?.id ?? null;
}
