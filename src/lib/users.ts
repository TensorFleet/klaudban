/**
 * Team users store.
 *
 * Users start from `klaudban.config.json` and can be auto-created when a
 * reverse-proxy auth identity (Caddy/AuthCrunch) arrives for someone who
 * is not yet in the list. New members are persisted back into the config
 * file so they survive restarts.
 *
 * Each user accumulates auth *providers* (origins) over time, e.g.
 * ["google"], ["local"], or ["google","local"]. The same email id is
 * reused when a second IdP is linked — we only append the provider.
 *
 * Persistence is synchronous (writeFileSync) so a later request never
 * reloadFromDisk()'s a stale file over a just-updated in-memory list.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG, type TeamUser } from './config';
import { identityFromHeaders, normalizeProvider, type RequestIdentity } from './auth';

const CONFIG_FILENAME = 'klaudban.config.json';
const DEFAULT_EMOJI = '👤';

let users: TeamUser[] = normalizeUsers(CONFIG.users ?? []);

function configPath(): string {
  return resolve(process.cwd(), CONFIG_FILENAME);
}

function normalizeProviders(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = normalizeProvider(String(raw ?? ''));
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function normalizeUsers(list: TeamUser[]): TeamUser[] {
  const seen = new Set<string>();
  const out: TeamUser[] = [];
  for (const u of list) {
    if (!u?.id) continue;
    const id = String(u.id).trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let providers = normalizeProviders((u as TeamUser).providers);
    // Config-only handles without an email id and without providers:
    // treat as a single "local" source so the UI can still badge them.
    if (providers.length === 0 && !id.includes('@')) {
      providers = ['local'];
    }
    out.push({
      id,
      label: (u.label && String(u.label).trim()) || id,
      emoji: u.emoji || DEFAULT_EMOJI,
      providers,
    });
  }
  return out;
}

/**
 * Optional refresh from disk (e.g. after an external CLI migrate).
 * Not used on the request hot path — avoids racing a concurrent write.
 */
export function reloadUsersFromDisk(): void {
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

  if (existsSync(path)) {
    let rawText: string;
    try {
      rawText = readFileSync(path, 'utf8');
    } catch (err) {
      // Do not overwrite an existing config we cannot read.
      throw new Error(
        `persistUsers: cannot read ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else {
        throw new Error('root JSON value is not an object');
      }
    } catch (err) {
      // Refuse to write — a parse failure must never collapse the file to { users }.
      throw new Error(
        `persistUsers: ${CONFIG_FILENAME} is not valid JSON; refusing to overwrite (fix the file first): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Preserve every non-users key; replace users with the in-memory list.
  base.users = next;
  writeFileSync(path, JSON.stringify(base, null, 2) + '\n', 'utf8');
}

function commitUsers(next: TeamUser[]): void {
  users = next;
  persistUsers(next);
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
 * Creates + persists a new entry when missing. Merges providers when present.
 */
export function ensureUserFromHeaders(headers: Headers): TeamUser | null {
  const identity = identityFromHeaders(headers);
  if (!identity) return null;
  return ensureUser(identity);
}

export function ensureUser(identity: RequestIdentity): TeamUser {
  const existing = users.find((u) => u.id === identity.id);
  const incomingProvider = normalizeProvider(identity.provider || '');

  if (existing) {
    let changed = false;
    let nextUser: TeamUser = { ...existing, providers: normalizeProviders(existing.providers) };

    if (
      identity.label &&
      identity.label !== nextUser.label &&
      (nextUser.label === nextUser.id || nextUser.label === identity.email)
    ) {
      nextUser = { ...nextUser, label: identity.label };
      changed = true;
    }

    if (incomingProvider && !nextUser.providers!.includes(incomingProvider)) {
      nextUser = {
        ...nextUser,
        providers: [...(nextUser.providers || []), incomingProvider],
      };
      changed = true;
    }

    if (changed) {
      commitUsers(users.map((u) => (u.id === existing.id ? nextUser : u)));
      return nextUser;
    }
    return existing;
  }

  const created: TeamUser = {
    id: identity.id,
    label: identity.label,
    emoji: DEFAULT_EMOJI,
    providers: incomingProvider ? [incomingProvider] : [],
  };
  commitUsers([...users, created]);
  return created;
}

/**
 * Normalize an assignee id for storage and lookup (trim + lowercase).
 * null/undefined/blank → null (unassigned).
 */
export function normalizeAssigneeId(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return id === '' ? null : id;
}

/**
 * Resolve assignee on task create.
 *
 * - Body **omits** `assignee` → default to signed-in user (if any).
 * - Body sets `assignee: null` / `""` → explicit unassigned.
 * - Body sets a non-empty string → that id (normalized).
 */
export function resolveAssigneeForCreate(
  headers: Headers,
  body: Record<string, unknown>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(body, 'assignee')) {
    return normalizeAssigneeId(body.assignee);
  }
  // Missing key: prefer logged-in principal.
  return ensureUserFromHeaders(headers)?.id ?? null;
}

/**
 * @deprecated Prefer resolveAssigneeForCreate — kept for call sites that only
 * have a scalar. Treats null/empty as "use default self" (legacy).
 */
export function defaultAssigneeFromHeaders(
  headers: Headers,
  assignee: string | null | undefined,
): string | null {
  const normalized = normalizeAssigneeId(assignee);
  if (normalized) return normalized;
  const user = ensureUserFromHeaders(headers);
  return user?.id ?? null;
}

/**
 * Update the display label for the authenticated principal only.
 * Id is never changed. Returns null when there is no auth identity.
 */
export function updateSelfLabel(headers: Headers, labelRaw: string): TeamUser | null {
  const me = ensureUserFromHeaders(headers);
  if (!me) return null;
  const label = String(labelRaw ?? '').trim();
  if (!label) {
    throw new Error('label is required');
  }
  if (label.length > 80) {
    throw new Error('label too long');
  }
  const next = users.map((u) => (u.id === me.id ? { ...u, label } : u));
  commitUsers(next);
  return next.find((u) => u.id === me.id) ?? null;
}

/** Single provider badge label, or null when none / multiple. */
export function soleProvider(user: TeamUser | null | undefined): string | null {
  const list = normalizeProviders(user?.providers);
  return list.length === 1 ? list[0]! : null;
}
