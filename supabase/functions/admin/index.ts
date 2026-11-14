import {
  adminDb, assertString, closeDueEvents, createOfficialSnapshot, corsHeaders, decryptAttendee, decryptText,
  env, eventIsEditable, fail, hmacHex, HttpError, json, randomToken, requireAdmin, storeAttendee, writeAudit,
} from '../_shared/common.ts';

function makeCode(): string {
  return `NAV-${randomToken(18).replace(/-/g, '').replace(/_/g, '').toUpperCase()}`;
}

async function saveGroupCode(db: ReturnType<typeof adminDb>, groupId: string): Promise<string> {
  const code = makeCode();
  const hash = await hmacHex(env('CODE_HASH_SECRET'), code);
  const { error } = await db.from('groups').update({ code_hash: hash, code_last4: code.slice(-4) }).eq('id', groupId);
  if (error) throw new HttpError('No se pudo generar el identificador.', 500);
  return code;
}

async function getEventDetail(db: ReturnType<typeof adminDb>, eventId: string) {
  const { data: event, error } = await db.from('events').select('*').eq('id', eventId).maybeSingle();
  if (error || !event) throw new HttpError('No se ha encontrado el evento.', 404);
  const { data: assignments } = await db.from('event_groups').select('group_id').eq('event_id', eventId);
  const groupIds = (assignments ?? []).map((x: any) => x.group_id);
  let groups: any[] = [];
  if (groupIds.length) {
    const { data } = await db.from('groups').select('id, label, responsible_name, contact, active, code_last4').in('id', groupIds).order('label');
    groups = data ?? [];
  }
  const { data: rows, error: attendeeError } = await db.from('attendees')
    .select('id, event_id, group_id, full_name, document_type, document_ciphertext, document_iv, status, paid, created_at, updated_at')
    .eq('event_id', eventId).order('full_name');
  if (attendeeError) throw new HttpError('No se pudieron cargar los asistentes.', 500);
  const attendees = [];
  for (const row of rows ?? []) attendees.push({ ...(await decryptAttendee(row)), paid: row.paid === true });
  const nameKey = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/[^a-z0-9]/g, '');
  const nameCounts = new Map<string, number>();
  for (const person of attendees) if (person.status !== 'cancelled') {
    const key = nameKey(String(person.full_name ?? ''));
    if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  for (const person of attendees) {
    const key = nameKey(String(person.full_name ?? ''));
    person.name_duplicate = person.status !== 'cancelled' && Boolean(key) && (nameCounts.get(key) ?? 0) > 1;
  }
  const { data: snapshots } = await db.from('official_snapshots')
    .select('id, version, attendee_count, confirmed_count, pending_count, created_at, created_by_type')
    .eq('event_id', eventId).order('version', { ascending: false });
  return { event, groups, attendees, snapshots: snapshots ?? [] };
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new HttpError(`${label} no es válida.`);
  return new Date(value).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'Método no permitido.', 405);

  try {
    const admin = await requireAdmin(req);
    const db = adminDb();
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'dashboard') {
      await closeDueEvents(db);
      const { data: events, error } = await db.from('events').select('*').order('starts_at');
      if (error) throw new HttpError('No se pudieron cargar los eventos.', 500);
      const summary = [];
      for (const event of events ?? []) {
        const { count: total } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', event.id).neq('status', 'cancelled');
        const { count: confirmed } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', event.id).eq('status', 'confirmed');
        const { count: pending } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', event.id).eq('status', 'pending');
        const { count: groups } = await db.from('event_groups').select('group_id', { count: 'exact', head: true }).eq('event_id', event.id);
        summary.push({ ...event, attendee_count: total ?? 0, confirmed_count: confirmed ?? 0, pending_count: pending ?? 0, group_count: groups ?? 0 });
      }
      const { count: activeGroups } = await db.from('groups').select('id', { count: 'exact', head: true }).eq('active', true);
      return json(req, { ok: true, events: summary, active_groups: activeGroups ?? 0 });
    }

    if (action === 'create_event') {
      const name = assertString(body.name, 'El nombre del evento', 120);
      const startsAt = parseIso(body.starts_at, 'La fecha del evento');
      const deadlineAt = parseIso(body.deadline_at, 'La fecha límite');
      if (Date.parse(deadlineAt) > Date.parse(startsAt)) {
        throw new HttpError('La fecha límite debe ser anterior o igual al inicio del evento.');
      }
      const capacity = body.capacity === '' || body.capacity == null ? null : Number(body.capacity);
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000)) throw new HttpError('El aforo debe ser un número entero positivo.');
      const { data: event, error } = await db.from('events').insert({
        name, description: typeof body.description === 'string' ? body.description.slice(0, 800) : '',
        starts_at: startsAt, deadline_at: deadlineAt, capacity, created_by: admin.id,
        is_published: body.is_published !== false, poster_url: typeof body.poster_url === 'string' ? body.poster_url.slice(0, 1000) : null,
      }).select('*').single();
      if (error) throw new HttpError('No se pudo crear el evento. Comprueba las fechas y el aforo.', 400);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, event_id: event.id, action: 'event.created', details: { name } });
      return json(req, { ok: true, event });
    }

    if (action === 'update_event') {
      const eventId = String(body.event_id ?? '');
      const update: Record<string, unknown> = {};
      if (typeof body.name === 'string') update.name = assertString(body.name, 'El nombre', 120);
      if (typeof body.description === 'string') update.description = body.description.slice(0, 800);
      if (typeof body.is_published === 'boolean') update.is_published = body.is_published;
      if (body.poster_url === null || typeof body.poster_url === 'string') update.poster_url = body.poster_url ? body.poster_url.slice(0, 1000) : null;
      if (typeof body.starts_at === 'string') update.starts_at = parseIso(body.starts_at, 'La fecha del evento');
      if (typeof body.deadline_at === 'string') update.deadline_at = parseIso(body.deadline_at, 'La fecha límite');
      if (body.capacity === null || body.capacity === '') update.capacity = null;
      else if (body.capacity !== undefined) {
        const cap = Number(body.capacity);
        if (!Number.isInteger(cap) || cap < 1 || cap > 100000) throw new HttpError('El aforo no es válido.');
        update.capacity = cap;
      }
      const { data: current } = await db.from('events').select('starts_at, deadline_at').eq('id', eventId).maybeSingle();
      if (!current) throw new HttpError('No se ha encontrado el evento.', 404);
      const starts = String(update.starts_at ?? current.starts_at);
      const deadline = String(update.deadline_at ?? current.deadline_at);
      if (Date.parse(deadline) > Date.parse(starts)) throw new HttpError('La fecha límite debe ser anterior o igual al inicio del evento.');
      if (update.capacity !== undefined && update.capacity !== null) {
        const { count: activeCount } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', eventId).neq('status', 'cancelled');
        if ((activeCount ?? 0) > Number(update.capacity)) throw new HttpError('El nuevo aforo es inferior al número de asistentes que ya están apuntados.');
      }
      const { data: event, error } = await db.from('events').update(update).eq('id', eventId).select('*').single();
      if (error) throw new HttpError('No se pudo actualizar el evento.', 400);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, event_id: eventId, action: 'event.updated', details: { fields: Object.keys(update) } });
      return json(req, { ok: true, event });
    }

    if (action === 'create_group') {
      const label = assertString(body.label, 'El nombre del grupo', 100);
      const responsible = assertString(body.responsible_name, 'El responsable', 120);
      const eventIds = Array.isArray(body.event_ids) ? [...new Set(body.event_ids.filter((x: unknown) => typeof x === 'string'))] as string[] : [];
      if (!eventIds.length) throw new HttpError('Asigna al grupo al menos un evento.');
      const { data: events, error: eventError } = await db.from('events').select('id').in('id', eventIds);
      if (eventError || (events?.length ?? 0) !== eventIds.length) throw new HttpError('Uno de los eventos seleccionados no existe.');
      const code = makeCode();
      const codeHash = await hmacHex(env('CODE_HASH_SECRET'), code);
      const { data: group, error } = await db.from('groups').insert({
        label, responsible_name: responsible, contact: typeof body.contact === 'string' ? body.contact.slice(0, 160) : '',
        code_hash: codeHash, code_last4: code.slice(-4), created_by: admin.id,
      }).select('id, label, responsible_name, contact, active, code_last4, created_at').single();
      if (error) throw new HttpError('No se pudo crear el grupo.', 500);
      const assignments = eventIds.map(event_id => ({ event_id, group_id: group.id }));
      const { error: assignmentError } = await db.from('event_groups').insert(assignments);
      if (assignmentError) {
        await db.from('groups').delete().eq('id', group.id);
        throw new HttpError('No se pudieron asignar los eventos al grupo.', 500);
      }
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: group.id, action: 'group.created', details: { label, assigned_events: eventIds.length } });
      // The full access code is only returned once. It is never stored in plaintext.
      return json(req, { ok: true, group, code });
    }

    if (action === 'list_groups') {
      const { data: groups, error } = await db.from('groups')
        .select('id, label, responsible_name, contact, active, code_last4, created_at').order('created_at', { ascending: false });
      if (error) throw new HttpError('No se pudieron cargar los grupos.', 500);
      const result = [];
      for (const group of groups ?? []) {
        const { data: assignments } = await db.from('event_groups').select('event_id').eq('group_id', group.id);
        result.push({ ...group, event_ids: (assignments ?? []).map((a: any) => a.event_id) });
      }
      return json(req, { ok: true, groups: result });
    }

    if (action === 'update_group') {
      const groupId = String(body.group_id ?? '');
      const label = assertString(body.label, 'El nombre del grupo', 100);
      const responsible = assertString(body.responsible_name, 'El responsable', 120);
      const eventIds = Array.isArray(body.event_ids) ? [...new Set(body.event_ids.filter((x: unknown) => typeof x === 'string'))] as string[] : [];
      if (!eventIds.length) throw new HttpError('El grupo debe tener al menos un evento asignado.');
      const { data: current } = await db.from('groups').select('id').eq('id', groupId).maybeSingle();
      if (!current) throw new HttpError('No se ha encontrado el grupo.', 404);
      const { data: oldAssignments } = await db.from('event_groups').select('event_id').eq('group_id', groupId);
      const oldIds = (oldAssignments ?? []).map((a: any) => a.event_id);
      const removeIds = oldIds.filter((id: string) => !eventIds.includes(id));
      for (const eventId of removeIds) {
        const { count } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('group_id', groupId);
        if ((count ?? 0) > 0) throw new HttpError('No puedes quitar un evento que ya tiene asistentes registrados en este grupo.');
      }
      const { error: updateError } = await db.from('groups').update({
        label, responsible_name: responsible, contact: typeof body.contact === 'string' ? body.contact.slice(0, 160) : '',
      }).eq('id', groupId);
      if (updateError) throw new HttpError('No se pudo actualizar el grupo.', 500);
      if (removeIds.length) await db.from('event_groups').delete().eq('group_id', groupId).in('event_id', removeIds);
      const addIds = eventIds.filter((id: string) => !oldIds.includes(id));
      if (addIds.length) {
        const { error } = await db.from('event_groups').insert(addIds.map(event_id => ({ event_id, group_id: groupId })));
        if (error) throw new HttpError('No se pudieron actualizar los eventos del grupo.', 500);
      }
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: groupId, action: 'group.updated', details: { assigned_events: eventIds.length } });
      return json(req, { ok: true });
    }

    if (action === 'regenerate_group_code') {
      const groupId = String(body.group_id ?? '');
      const { data: group } = await db.from('groups').select('id').eq('id', groupId).maybeSingle();
      if (!group) throw new HttpError('No se ha encontrado el grupo.', 404);
      const code = await saveGroupCode(db, groupId);
      await db.from('portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('group_id', groupId).is('revoked_at', null);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: groupId, action: 'group.code_regenerated', details: {} });
      return json(req, { ok: true, code });
    }

    if (action === 'set_group_active') {
      const groupId = String(body.group_id ?? '');
      const active = body.active === true;
      const { error } = await db.from('groups').update({ active }).eq('id', groupId);
      if (error) throw new HttpError('No se pudo cambiar el estado del grupo.', 500);
      if (!active) await db.from('portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('group_id', groupId).is('revoked_at', null);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: groupId, action: active ? 'group.activated' : 'group.deactivated', details: {} });
      return json(req, { ok: true });
    }

    if (action === 'event_detail') {
      return json(req, { ok: true, ...(await getEventDetail(db, String(body.event_id ?? ''))) });
    }

    if (action === 'save_attendee') {
      const groupId = String(body.group_id ?? '');
      const eventId = String(body.event_id ?? '');
      const { data: assignment } = await db.from('event_groups').select('group_id').eq('event_id', eventId).eq('group_id', groupId).maybeSingle();
      if (!assignment) throw new HttpError('Este grupo no está asignado al evento.');
      await eventIsEditable(db, eventId);
      const attendee = await storeAttendee(db, { ...(body.attendee ?? {}), event_id: eventId }, groupId, 'admin');
      return json(req, { ok: true, attendee });
    }

    if (action === 'set_attendee_paid') {
      const attendeeId = String(body.attendee_id ?? '');
      const paid = body.paid === true;
      const { data: attendee } = await db.from('attendees').select('id, event_id, group_id, full_name, paid, status').eq('id', attendeeId).maybeSingle();
      if (!attendee) throw new HttpError('No se ha encontrado el asistente.', 404);
      if (attendee.status === 'cancelled') throw new HttpError('No se puede marcar el pago de una persona cancelada.');
      const { error } = await db.from('attendees').update({ paid }).eq('id', attendeeId);
      if (error) throw new HttpError('No se pudo actualizar el pago.', 500);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: attendee.group_id, event_id: attendee.event_id, action: paid ? 'attendee.marked_paid' : 'attendee.marked_unpaid', details: { attendee_id: attendeeId, full_name: attendee.full_name } });
      return json(req, { ok: true, paid });
    }

    if (action === 'cancel_attendee') {
      const attendeeId = String(body.attendee_id ?? '');
      const { data: attendee } = await db.from('attendees').select('id, event_id, group_id, full_name').eq('id', attendeeId).maybeSingle();
      if (!attendee) throw new HttpError('No se ha encontrado el asistente.', 404);
      await eventIsEditable(db, attendee.event_id);
      const { error } = await db.from('attendees').update({ status: 'cancelled', updated_by_type: 'admin' }).eq('id', attendeeId);
      if (error) throw new HttpError('No se pudo cancelar el asistente.', 500);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: attendee.group_id, event_id: attendee.event_id, action: 'attendee.cancelled_by_admin', details: { attendee_id: attendeeId } });
      return json(req, { ok: true });
    }

    if (action === 'close_event' || action === 'publish_snapshot') {
      const eventId = String(body.event_id ?? '');
      const { data: currentEvent } = await db.from('events').select('status').eq('id', eventId).maybeSingle();
      if (!currentEvent) throw new HttpError('No se ha encontrado el evento.', 404);
      if (action === 'close_event' && currentEvent.status === 'closed') throw new HttpError('El evento ya está cerrado. Usa «Publicar nueva versión» si has realizado correcciones.');
      if (action === 'publish_snapshot' && currentEvent.status !== 'closed') throw new HttpError('Cierra el evento antes de publicar una versión adicional.');
      if (action === 'close_event') {
        const { data: claimed, error: claimError } = await db.from('events').update({ status: 'closed' })
          .eq('id', eventId).eq('status', 'open').select('id').maybeSingle();
        if (claimError || !claimed) throw new HttpError('El evento ya se ha cerrado. Actualiza la vista antes de continuar.', 409);
      }
      const snapshot = await createOfficialSnapshot(db, eventId, admin.id, 'admin');
      return json(req, { ok: true, snapshot });
    }

    if (action === 'reopen_event') {
      const eventId = String(body.event_id ?? '');
      const deadlineAt = parseIso(body.deadline_at, 'La nueva fecha límite');
      const { data: event } = await db.from('events').select('starts_at').eq('id', eventId).maybeSingle();
      if (!event) throw new HttpError('No se ha encontrado el evento.', 404);
      if (Date.parse(deadlineAt) < Date.now() || Date.parse(deadlineAt) > Date.parse(event.starts_at)) throw new HttpError('La nueva fecha límite debe ser futura y anterior al inicio del evento.');
      const { error } = await db.from('events').update({ status: 'open', deadline_at: deadlineAt }).eq('id', eventId);
      if (error) throw new HttpError('No se pudo reabrir el evento.', 500);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, event_id: eventId, action: 'event.reopened', details: { deadline_at: deadlineAt } });
      return json(req, { ok: true });
    }

    if (action === 'cancel_event') {
      const eventId = String(body.event_id ?? '');
      const { error } = await db.from('events').update({ status: 'cancelled' }).eq('id', eventId);
      if (error) throw new HttpError('No se pudo cancelar el evento.', 500);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, event_id: eventId, action: 'event.cancelled', details: {} });
      return json(req, { ok: true });
    }

    if (action === 'download_snapshot') {
      const snapshotId = String(body.snapshot_id ?? '');
      const { data: snapshot, error } = await db.from('official_snapshots').select('*').eq('id', snapshotId).maybeSingle();
      if (error || !snapshot) throw new HttpError('No se ha encontrado esa versión oficial.', 404);
      const payload = JSON.parse(await decryptText(snapshot.payload_ciphertext, snapshot.payload_iv));
      return json(req, { ok: true, snapshot: { id: snapshot.id, version: snapshot.version, created_at: snapshot.created_at, ...payload } });
    }

    if (action === 'audit') {
      const { data, error } = await db.from('audit_log').select('id, actor_type, actor_id, group_id, event_id, action, details, created_at').order('created_at', { ascending: false }).limit(150);
      if (error) throw new HttpError('No se pudo cargar el historial.', 500);
      return json(req, { ok: true, entries: data ?? [] });
    }

    throw new HttpError('Acción no reconocida.', 404);
  } catch (error) {
    console.error('admin error:', error);
    if (error instanceof HttpError) return fail(req, error.message, error.status, error.code);
    return fail(req, 'Se ha producido un error interno. Inténtalo de nuevo.', 500);
  }
});
