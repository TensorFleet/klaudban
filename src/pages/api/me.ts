import type { APIRoute } from 'astro';
import { ensureUserFromHeaders, listUsers } from '../../lib/users';

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
