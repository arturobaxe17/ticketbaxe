import { adminDb, corsHeaders, env, fail, json, closeDueEvents } from '../_shared/common.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'Método no permitido.', 405);
  try {
    const received = req.headers.get('x-cron-secret') ?? '';
    const expected = env('CRON_SECRET');
    // Compare fixed-length digests rather than secrets directly.
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    const a = await digest(received);
    const b = await digest(expected);
    let mismatch = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
    if (mismatch !== 0) return fail(req, 'No autorizado.', 401);
    const closed = await closeDueEvents(adminDb());
    return json(req, { ok: true, closed });
  } catch (error) {
    console.error('close-due-events error:', error);
    return fail(req, 'No se pudieron procesar los cierres automáticos.', 500);
  }
});
