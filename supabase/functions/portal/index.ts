import {
  adminDb, appSecret, corsHeaders, decryptAttendee, fail, getGroupSession, hmacHex, HttpError,
  json, randomToken, storeAttendee, eventIsEditable, writeAudit,
} from '../_shared/common.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'Método no permitido.', 405);

  try {
    const db = adminDb();
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'login') {
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase().replace(/\s/g, '') : '';
      if (!/^[A-Z0-9-]{12,50}$/.test(code)) throw new HttpError('Introduce un identificador válido.');
      const ip = (req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? 'unknown').split(',')[0].trim();
      const ipHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), ip);
      const { data: allowed, error: rateError } = await db.rpc('portal_login_allowed', { p_ip_hash: ipHash });
      if (rateError) throw new HttpError('No se ha podido validar el acceso. Inténtalo de nuevo.', 503);
      if (!allowed) throw new HttpError('Demasiados intentos. Espera 15 minutos antes de volver a intentarlo.', 429, 'RATE_LIMITED');

      const codeHash = await hmacHex(await appSecret('CODE_HASH_SECRET'), code);
      const { data: group, error } = await db.from('groups')
        .select('id, label, responsible_name, rrpp_name, contact, active')
        .eq('code_hash', codeHash).maybeSingle();
      if (error || !group || !group.active) {
        throw new HttpError('El identificador no es correcto o está desactivado.', 401, 'INVALID_CODE');
      }
      await db.rpc('clear_portal_login_attempt', { p_ip_hash: ipHash });
      const sessionToken = randomToken(32);
      const tokenHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), sessionToken);
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const { error: sessionError } = await db.from('portal_sessions').insert({
        group_id: group.id, token_hash: tokenHash, expires_at: expiresAt,
      });
      if (sessionError) throw new HttpError('No se pudo iniciar la sesión. Vuelve a intentarlo.', 500);
      await writeAudit(db, { actor_type: 'group', actor_id: group.id, group_id: group.id, action: 'group.login', details: {} });
      return json(req, { ok: true, token: sessionToken, expires_at: expiresAt, group });
    }

    const { sessionId, group } = await getGroupSession(req, db);

    if (action === 'me') {
      const { data: assignments, error } = await db.from('event_groups').select('event_id').eq('group_id', group.id);
      if (error) throw new HttpError('No se han podido cargar tus eventos.', 500);
      const ids = (assignments ?? []).map((item: any) => item.event_id);
      let events: any[] = [];
      if (ids.length) {
        const { data, error: eventsError } = await db.from('events').select('id, name, description, starts_at, deadline_at, capacity, status, poster_url').eq('is_published', true).in('id', ids).order('starts_at');
        if (eventsError) throw new HttpError('No se han podido cargar tus eventos.', 500);
        const { data: metrics, error: metricsError } = await db.rpc('get_group_event_metrics', {
          p_group_id: group.id,
          p_event_ids: ids,
        });
        if (metricsError) throw new HttpError('No se han podido calcular los contadores de tus eventos.', 500);
        const metricsByEvent = new Map((metrics ?? []).map((item: any) => [item.event_id, item]));
        events = (data ?? []).map((event: any) => {
          const item: any = metricsByEvent.get(event.id) ?? {};
          return {
            ...event,
            group_attendee_count: Number(item.group_attendee_count ?? 0),
            total_attendee_count: Number(item.total_attendee_count ?? 0),
            editable: event.status === 'open' && new Date(event.deadline_at).getTime() > Date.now(),
          };
        });
      }
      return json(req, { ok: true, group, events });
    }

    if (action === 'event') {
      const eventId = String(body.event_id ?? '');
      const { data: assignment } = await db.from('event_groups').select('event_id').eq('event_id', eventId).eq('group_id', group.id).maybeSingle();
      if (!assignment) throw new HttpError('Este evento no está asignado a tu grupo.', 403);
      const { data: event, error: eventError } = await db.from('events')
        .select('id, name, description, starts_at, deadline_at, capacity, status, poster_url').eq('id', eventId).eq('is_published', true).maybeSingle();
      if (eventError || !event) throw new HttpError('No se ha encontrado el evento.', 404);
      const { data: rows, error: rowsError } = await db.from('attendees')
        .select('id, event_id, group_id, full_name, document_type, document_ciphertext, document_iv, status, paid, entry_number, price_paid, price_frozen_at, created_at, updated_at')
        .eq('event_id', eventId).eq('group_id', group.id).order('created_at');
      if (rowsError) throw new HttpError('No se han podido cargar los asistentes.', 500);
      const attendees = [];
      for (const row of rows ?? []) attendees.push({ ...(await decryptAttendee(row)), paid: row.paid === true });
      event.editable = event.status === 'open' && new Date(event.deadline_at).getTime() > Date.now();
      return json(req, { ok: true, event, attendees });
    }

    if (action === 'save_attendee') {
      const eventId = String(body.event_id ?? '');
      const { data: assignment } = await db.from('event_groups').select('event_id').eq('event_id', eventId).eq('group_id', group.id).maybeSingle();
      if (!assignment) throw new HttpError('Este evento no está asignado a tu grupo.', 403);
      await eventIsEditable(db, eventId);
      const attendee = await storeAttendee(db, { ...(body.attendee ?? {}), event_id: eventId }, group.id, 'group');
      return json(req, { ok: true, attendee });
    }

    if (action === 'cancel_attendee') {
      const eventId = String(body.event_id ?? '');
      const attendeeId = String(body.attendee_id ?? '');
      await eventIsEditable(db, eventId);
      const { data: attendee, error } = await db.from('attendees').select('id, group_id, event_id, full_name, status, paid, entry_number, price_frozen_at')
        .eq('id', attendeeId).eq('event_id', eventId).maybeSingle();
      if (error || !attendee || attendee.group_id !== group.id) throw new HttpError('No puedes modificar este asistente.', 404);
      if (attendee.price_frozen_at !== null || (attendee.paid === true && attendee.entry_number !== null)) {
        throw new HttpError('Esta entrada es nominativa: el pago está confirmado y ya tiene número de entrada. Solo administración puede modificarla.', 409, 'ATTENDEE_LOCKED');
      }
      const { error: updateError } = await db.from('attendees').update({ status: 'cancelled', updated_by_type: 'group' }).eq('id', attendeeId);
      if (updateError) throw new HttpError('No se pudo cancelar el asistente.', 500);
      await writeAudit(db, { actor_type: 'group', actor_id: group.id, group_id: group.id, event_id: eventId, action: 'attendee.cancelled', details: { attendee_id: attendeeId } });
      return json(req, { ok: true });
    }

    if (action === 'logout') {
      await db.from('portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', sessionId);
      return json(req, { ok: true });
    }

    throw new HttpError('Acción no reconocida.', 404);
  } catch (error) {
    console.error('portal error:', error);
    if (error instanceof HttpError) return fail(req, error.message, error.status, error.code);
    return fail(req, 'Se ha producido un error interno. Inténtalo de nuevo.', 500);
  }
});
