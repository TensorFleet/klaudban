import type { APIRoute } from 'astro';
import { ensureUserFromHeaders, listUsers, updateSelfLabel } from '../../lib/users';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const me = ensureUserFromHeaders(request.headers);
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

  if (!ensureUserFromHeaders(request.headers)) {
    return new Response(JSON.stringify({ error: 'not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const me = updateSelfLabel(request.headers, String(body.label ?? ''));
    return new Response(JSON.stringify({ me, users: listUsers() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'update failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
