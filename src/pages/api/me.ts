import type { APIRoute } from 'astro';
import { ensureUserFromHeaders, listUsers, updateSelfLabel } from '../../lib/users';
import { withWriteLock } from '../../lib/write-lock';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const me = await withWriteLock(() => ensureUserFromHeaders(request.headers));
  return new Response(
    JSON.stringify({
      me,
      users: listUsers(),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

/** PATCH { label } — rename display label for the authenticated self only. */
export const PATCH: APIRoute = async ({ request }) => {
  let body: { label?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const me = await withWriteLock(() => {
      if (!ensureUserFromHeaders(request.headers)) {
        const err = new Error('not authenticated');
        (err as Error & { status: number }).status = 401;
        throw err;
      }
      return updateSelfLabel(request.headers, String(body.label ?? ''));
    });
    return new Response(JSON.stringify({ me, users: listUsers() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === 'not authenticated') {
      return new Response(JSON.stringify({ error: 'not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const msg = err instanceof Error ? err.message : 'update failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
