/**
 * Identity helpers for reverse-proxy auth (AuthCrunch / Caddy).
 *
 * When klaudban sits behind AuthCrunch with `inject headers with claims`,
 * requests arrive with X-Token-* claim headers. Caddy may also forward
 * `X-Actor` (email) the same way KiwiFS does.
 */

export interface RequestIdentity {
  /** Stable user id used in assignee fields (email lowercased). */
  id: string;
  email: string;
  /** Display name when present; otherwise derived from the email local-part. */
  label: string;
}

function firstHeader(headers: Headers, names: string[]): string {
  for (const name of names) {
    const v = headers.get(name)?.trim();
    if (v) return v;
  }
  return '';
}

function labelFromEmail(email: string): string {
  const local = email.split('@')[0] || email;
  // "matthew.campbell" / "matthew_campbell" → "Matthew Campbell"
  return local
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || email;
}

/**
 * Extract the authenticated principal from proxy-injected headers.
 * Returns null when no identity is present (direct/local access).
 */
export function identityFromHeaders(headers: Headers): RequestIdentity | null {
  const emailRaw = firstHeader(headers, [
    'x-token-user-email',
    'x-token-email',
    'x-actor',
  ]);
  if (!emailRaw) return null;

  const email = emailRaw.toLowerCase();
  // Basic sanity: must look like an email (AuthCrunch always injects one).
  if (!email.includes('@')) return null;

  const name = firstHeader(headers, [
    'x-token-user-name',
    'x-token-name',
    'x-token-user-fullname',
  ]);

  return {
    id: email,
    email,
    label: name || labelFromEmail(email),
  };
}
