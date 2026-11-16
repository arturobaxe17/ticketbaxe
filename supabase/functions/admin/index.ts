import {
  adminDb, appSecret, assertString, authDb, closeDueEvents, createOfficialSnapshot, corsHeaders, decryptAttendee, decryptText,
  env, eventIsEditable, fail, getBearer, hmacHex, HttpError, json, jwtPayload, randomToken, requireAdmin, storeAttendee, writeAudit,
} from '../_shared/common.ts';

function makeCode(): string {
  return `NAV-${randomToken(18).replace(/-/g, '').replace(/_/g, '').toUpperCase()}`;
}

async function saveGroupCode(db: ReturnType<typeof adminDb>, groupId: string): Promise<string> {
  const code = makeCode();
  const hash = await hmacHex(await appSecret('CODE_HASH_SECRET'), code);
  const { error } = await db.from('groups').update({ code_hash: hash, code_last4: code.slice(-4) }).eq('id', groupId);
  if (error) throw new HttpError('No se pudo generar el identificador.', 500);
  return code;
}

async function getOrCreateLooseGroup(db: ReturnType<typeof adminDb>) {
  const { data: existing, error: lookupError } = await db.from('groups')
    .select('id, label, responsible_name, contact, active, code_last4')
    .eq('is_internal', true).maybeSingle();
  if (lookupError) throw new HttpError('No se pudo preparar Entradas sueltas.', 500);
  if (existing) return existing;

  // The internal group has no distributed access code and is permanently inactive.
  const secretCode = `INTERNAL-${randomToken(32)}`;
  const codeHash = await hmacHex(await appSecret('CODE_HASH_SECRET'), secretCode);
  const { data: created, error: createError } = await db.from('groups').insert({
    label: 'Entradas sueltas',
    responsible_name: 'Administración',
    contact: '',
    code_hash: codeHash,
    code_last4: '----',
    active: false,
    is_internal: true,
    created_by: null,
  }).select('id, label, responsible_name, contact, active, code_last4').single();

  if (createError?.code === '23505') {
    const { data: raced, error: raceError } = await db.from('groups')
      .select('id, label, responsible_name, contact, active, code_last4')
      .eq('is_internal', true).maybeSingle();
    if (!raceError && raced) return raced;
  }
  if (createError || !created) throw new HttpError('No se pudo preparar Entradas sueltas.', 500);
  return created;
}

async function getEventDetail(db: ReturnType<typeof adminDb>, eventId: string) {
  const { data: event, error } = await db.from('events').select('*').eq('id', eventId).maybeSingle();
  if (error || !event) throw new HttpError('No se ha encontrado el evento.', 404);
  const looseGroup = await getOrCreateLooseGroup(db);
  const { error: looseAssignmentError } = await db.from('event_groups').upsert(
    { event_id: eventId, group_id: looseGroup.id },
    { onConflict: 'event_id,group_id', ignoreDuplicates: true },
  );
  if (looseAssignmentError) throw new HttpError('No se pudo habilitar Entradas sueltas para este evento.', 500);
  const { data: assignments } = await db.from('event_groups').select('group_id').eq('event_id', eventId);
  const groupIds = (assignments ?? []).map((x: any) => x.group_id);
  let groups: any[] = [];
  if (groupIds.length) {
    const { data } = await db.from('groups').select('id, label, responsible_name, contact, active, code_last4').in('id', groupIds).eq('is_internal', false).order('label');
    groups = data ?? [];
  }
  const { data: rows, error: attendeeError } = await db.from('attendees')
    .select('id, event_id, group_id, full_name, document_type, document_ciphertext, document_iv, status, paid, entry_number, price_paid, created_at, updated_at')
    .eq('event_id', eventId).order('full_name');
  if (attendeeError) throw new HttpError('No se pudieron cargar los asistentes.', 500);
  const attendees = [];
  for (const row of rows ?? []) attendees.push({
    ...(await decryptAttendee(row)),
    paid: row.paid === true,
    is_loose: row.group_id === looseGroup.id,
  });
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
  return { event, groups, loose_group: looseGroup, attendees, snapshots: snapshots ?? [] };
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new HttpError(`${label} no es válida.`);
  return new Date(value).toISOString();
}


function hasAuthMethod(payload: Record<string, unknown>, method: string): boolean {
  const methods = Array.isArray(payload.amr) ? payload.amr as Array<Record<string, unknown>> : [];
  return methods.some(item => item?.method === method);
}

function isFreshAuth(payload: Record<string, unknown>, maxAgeMinutes = 10): boolean {
  const issuedAt = Number(payload.iat ?? 0) * 1000;
  return Number.isFinite(issuedAt) && issuedAt > 0 &&
    issuedAt <= Date.now() + 60_000 && Date.now() - issuedAt <= maxAgeMinutes * 60_000;
}

function maskEmail(value: string): string {
  const [name, domain] = value.split('@');
  if (!name || !domain) return 'tu correo';
  return `${name.slice(0, 1)}•••@${domain}`;
}

async function requestAdminEmailCode(req: Request, db: ReturnType<typeof adminDb>) {
  const token = getBearer(req);
  if (!token) throw new HttpError('Inicia sesión con tu contraseña primero.', 401, 'AUTH_REQUIRED');
  const payload = jwtPayload(token);
  if (!hasAuthMethod(payload, 'password') || !isFreshAuth(payload) || typeof payload.session_id !== 'string') {
    throw new HttpError('Vuelve a introducir tu contraseña para solicitar un nuevo código.', 403, 'PASSWORD_REAUTH_REQUIRED');
  }
  const { data, error } = await authDb(token).auth.getUser(token);
  if (error || !data.user) throw new HttpError('La sesión ha caducado. Vuelve a entrar.', 401, 'AUTH_INVALID');
  if (data.user.app_metadata?.role !== 'admin') throw new HttpError('Esta cuenta no tiene permisos de administración.', 403, 'ADMIN_REQUIRED');
  const email = String(data.user.email ?? '').trim().toLowerCase();
  if (!email || !data.user.email_confirmed_at) throw new HttpError('La cuenta debe tener un correo confirmado.', 400, 'EMAIL_NOT_CONFIRMED');

  const recentSince = new Date(Date.now() - 60_000).toISOString();
  const { data: recent, error: recentError } = await db.from('admin_email_challenges')
    .select('id').eq('user_id', data.user.id).gt('created_at', recentSince).limit(1);
  if (recentError) throw new HttpError('No se pudo comprobar el límite de envío.', 500);
  if (recent?.length) throw new HttpError('Espera un minuto antes de solicitar otro código.', 429, 'OTP_RATE_LIMIT');

  // Personal Gmail accounts are limited to 500 sent messages per rolling 24 hours.
  // Keep TicketBaxe well below that threshold even if an admin session is abused.
  const dailySince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count: dailyChallenges, error: dailyError } = await db.from('admin_email_challenges')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', data.user.id)
    .gt('created_at', dailySince);
  if (dailyError) throw new HttpError('No se pudo comprobar el límite diario de correo.', 500);
  if ((dailyChallenges ?? 0) >= 100) {
    throw new HttpError('Se ha alcanzado el límite diario de códigos. Vuelve a intentarlo mañana.', 429, 'OTP_DAILY_LIMIT');
  }

  const ticket = randomToken(32);
  const challengeHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), `admin-email-challenge:${ticket}`);
  const { error: insertError } = await db.from('admin_email_challenges').insert({
    user_id: data.user.id,
    email,
    challenge_hash: challengeHash,
    password_session_id: payload.session_id,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (insertError) throw new HttpError('No se pudo preparar el envío del código.', 500);
  return { ok: true, ticket, masked_email: maskEmail(email), expires_in_seconds: 600 };
}

async function completeAdminEmailCode(req: Request, body: Record<string, unknown>, db: ReturnType<typeof adminDb>) {
  const emailToken = getBearer(req);
  const passwordToken = req.headers.get('x-admin-password-session') ?? '';
  const ticket = typeof body.ticket === 'string' ? body.ticket : '';
  if (!emailToken || passwordToken.length < 40 || ticket.length < 30) {
    throw new HttpError('Falta completar la verificación de contraseña y correo.', 401, 'AUTH_REQUIRED');
  }

  const emailPayload = jwtPayload(emailToken);
  if (!hasAuthMethod(emailPayload, 'otp') || !isFreshAuth(emailPayload)) {
    throw new HttpError('El código de correo no se ha verificado correctamente. Solicita uno nuevo.', 403, 'EMAIL_OTP_REQUIRED');
  }
  const { data: emailAuth, error: emailAuthError } = await authDb(emailToken).auth.getUser(emailToken);
  if (emailAuthError || !emailAuth.user) throw new HttpError('La verificación del correo ha caducado.', 401, 'EMAIL_OTP_INVALID');

  const passwordPayload = jwtPayload(passwordToken);
  if (!hasAuthMethod(passwordPayload, 'password') || !isFreshAuth(passwordPayload) ||
      typeof passwordPayload.session_id !== 'string') {
    throw new HttpError('La comprobación de contraseña ha caducado. Vuelve a entrar.', 403, 'PASSWORD_REAUTH_REQUIRED');
  }
  const { data: passwordAuth, error: passwordAuthError } = await authDb(passwordToken).auth.getUser(passwordToken);
  if (passwordAuthError || !passwordAuth.user || passwordAuth.user.id !== emailAuth.user.id) {
    throw new HttpError('La contraseña y el código deben pertenecer a la misma cuenta.', 403, 'AUTH_MISMATCH');
  }
  if (emailAuth.user.app_metadata?.role !== 'admin' || passwordAuth.user.app_metadata?.role !== 'admin') {
    throw new HttpError('Esta cuenta no tiene permisos de administración.', 403, 'ADMIN_REQUIRED');
  }

  const email = String(emailAuth.user.email ?? '').trim().toLowerCase();
  const challengeHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), `admin-email-challenge:${ticket}`);
  const { data: challenge, error: challengeError } = await db.from('admin_email_challenges')
    .select('id, user_id, email, password_session_id, expires_at, used_at')
    .eq('challenge_hash', challengeHash).eq('user_id', emailAuth.user.id).maybeSingle();
  if (challengeError || !challenge || challenge.used_at ||
      new Date(challenge.expires_at).getTime() <= Date.now() ||
      challenge.email.toLowerCase() !== email ||
      challenge.password_session_id !== passwordPayload.session_id) {
    throw new HttpError('El código ha caducado o ya se ha utilizado. Vuelve a solicitarlo.', 401, 'EMAIL_CHALLENGE_INVALID');
  }

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db.from('admin_email_challenges')
    .update({ used_at: now }).eq('id', challenge.id).is('used_at', null).select('id').maybeSingle();
  if (claimError || !claimed) throw new HttpError('Este código ya se ha utilizado. Solicita otro.', 409, 'EMAIL_CHALLENGE_USED');

  await db.from('admin_email_sessions').update({ revoked_at: now })
    .eq('user_id', emailAuth.user.id).is('revoked_at', null);
  const sessionToken = randomToken(32);
  const tokenHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), `admin-email-session:${sessionToken}`);
  const { error: sessionError } = await db.from('admin_email_sessions').insert({
    user_id: emailAuth.user.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
  });
  if (sessionError) throw new HttpError('No se pudo abrir la sesión de administración.', 500);
  await writeAudit(db, {
    actor_type: 'admin',
    actor_id: emailAuth.user.id,
    action: 'admin.email_otp_verified',
    details: { method: 'email_otp' },
  });
  return { ok: true, session_token: sessionToken, expires_in_seconds: 8 * 60 * 60 };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 'Método no permitido.', 405);

  try {
    const db = adminDb();
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'request_email_code') {
      return json(req, await requestAdminEmailCode(req, db));
    }
    if (action === 'complete_email_code') {
      return json(req, await completeAdminEmailCode(req, body, db));
    }
    const admin = await requireAdmin(req);
    if (action === 'verify_email_session') return json(req, { ok: true, email: admin.email });
    if (action === 'logout_admin_session') {
      const sessionToken = req.headers.get('x-admin-email-session') ?? '';
      const tokenHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), `admin-email-session:${sessionToken}`);
      const { error } = await db.from('admin_email_sessions').update({ revoked_at: new Date().toISOString() })
        .eq('user_id', admin.id).eq('token_hash', tokenHash).is('revoked_at', null);
      if (error) throw new HttpError('No se pudo cerrar la sesión protegida.', 500);
      return json(req, { ok: true });
    }

    if (action === 'create_poster_upload') {
      const eventId = String(body.event_id ?? '');
      const contentType = String(body.content_type ?? '');
      const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const extension = extensions[contentType];
      if (!eventId || !extension) throw new HttpError('Selecciona un evento y un cartel JPG, PNG o WEBP.', 400);
      const { data: event } = await db.from('events').select('id').eq('id', eventId).maybeSingle();
      if (!event) throw new HttpError('No se ha encontrado el evento.', 404);
      const path = `${eventId}/${crypto.randomUUID()}.${extension}`;
      const { data, error } = await db.storage.from('event-posters').createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) throw new HttpError('No se pudo preparar la subida del cartel.', 500);
      const publicUrl = db.storage.from('event-posters').getPublicUrl(path).data.publicUrl;
      return json(req, { ok: true, path, token: data.token, public_url: publicUrl });
    }

    if (action === 'dashboard') {
      await closeDueEvents(db);
      const { data: events, error } = await db.from('events').select('*').order('starts_at');
      if (error) throw new HttpError('No se pudieron cargar los eventos.', 500);
      const { data: metrics, error: metricsError } = await db.rpc('get_admin_event_metrics');
      if (metricsError) throw new HttpError('No se pudieron calcular los contadores de los eventos.', 500);
      const metricsByEvent = new Map((metrics ?? []).map((item: any) => [item.event_id, item]));
      const summary = (events ?? []).map((event: any) => {
        const item: any = metricsByEvent.get(event.id) ?? {};
        return {
          ...event,
          attendee_count: Number(item.attendee_count ?? 0),
          confirmed_count: Number(item.confirmed_count ?? 0),
          pending_count: Number(item.pending_count ?? 0),
          group_count: Number(item.group_count ?? 0),
        };
      });
      const { count: activeGroups } = await db.from('groups').select('id', { count: 'exact', head: true }).eq('active', true).eq('is_internal', false);
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
      const { data: current } = await db.from('events').select('starts_at, deadline_at, poster_url').eq('id', eventId).maybeSingle();
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

      // When a poster is replaced or removed, delete the previous object so Storage
      // does not accumulate orphaned versions of the same event image.
      if (Object.prototype.hasOwnProperty.call(update, 'poster_url') &&
          current.poster_url && current.poster_url !== event.poster_url) {
        try {
          const configuredOrigin = new URL(env('SUPABASE_URL')).origin;
          const previousUrl = new URL(String(current.poster_url));
          const prefix = '/storage/v1/object/public/event-posters/';
          const prefixIndex = previousUrl.pathname.indexOf(prefix);
          if (previousUrl.origin === configuredOrigin && prefixIndex >= 0) {
            const objectPath = decodeURIComponent(previousUrl.pathname.slice(prefixIndex + prefix.length));
            if (objectPath && !objectPath.split('/').some(part => part === '..')) {
              const { error: removeError } = await db.storage.from('event-posters').remove([objectPath]);
              if (removeError) console.error('No se pudo eliminar el cartel anterior:', removeError.message);
            }
          }
        } catch (cleanupError) {
          console.error('No se pudo limpiar el cartel anterior:', cleanupError);
        }
      }

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
      const codeHash = await hmacHex(await appSecret('CODE_HASH_SECRET'), code);
      const { data: group, error } = await db.from('groups').insert({
        label, responsible_name: responsible,
        rrpp_name: typeof body.rrpp_name === 'string' ? body.rrpp_name.trim().slice(0, 120) || null : null,
        contact: typeof body.contact === 'string' ? body.contact.slice(0, 160) : '',
        code_hash: codeHash, code_last4: code.slice(-4), created_by: admin.id,
      }).select('id, label, responsible_name, rrpp_name, contact, active, code_last4, created_at').single();
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
        .select('id, label, responsible_name, rrpp_name, contact, active, code_last4, created_at').eq('is_internal', false).order('created_at', { ascending: false });
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
      const { data: current } = await db.from('groups').select('id, is_internal').eq('id', groupId).maybeSingle();
      if (!current || current.is_internal) throw new HttpError('No puedes modificar este grupo.', 404);
      const { data: oldAssignments } = await db.from('event_groups').select('event_id').eq('group_id', groupId);
      const oldIds = (oldAssignments ?? []).map((a: any) => a.event_id);
      const removeIds = oldIds.filter((id: string) => !eventIds.includes(id));
      for (const eventId of removeIds) {
        const { count } = await db.from('attendees').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('group_id', groupId);
        if ((count ?? 0) > 0) throw new HttpError('No puedes quitar un evento que ya tiene asistentes registrados en este grupo.');
      }
      const { error: updateError } = await db.from('groups').update({
        label, responsible_name: responsible,
        rrpp_name: typeof body.rrpp_name === 'string' ? body.rrpp_name.trim().slice(0, 120) || null : null,
        contact: typeof body.contact === 'string' ? body.contact.slice(0, 160) : '',
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
      const { data: group } = await db.from('groups').select('id, is_internal').eq('id', groupId).maybeSingle();
      if (!group || group.is_internal) throw new HttpError('No se puede renovar este identificador.', 404);
      const code = await saveGroupCode(db, groupId);
      await db.from('portal_sessions').update({ revoked_at: new Date().toISOString() }).eq('group_id', groupId).is('revoked_at', null);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: groupId, action: 'group.code_regenerated', details: {} });
      return json(req, { ok: true, code });
    }

    if (action === 'set_group_active') {
      const groupId = String(body.group_id ?? '');
      const active = body.active === true;
      const { data: targetGroup } = await db.from('groups').select('id, is_internal').eq('id', groupId).maybeSingle();
      if (!targetGroup || targetGroup.is_internal) throw new HttpError('No puedes cambiar el acceso de este grupo.', 404);
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
      const { data: attendee } = await db.from('attendees')
        .select('id, event_id, group_id, full_name, paid, status, price_paid, entry_number')
        .eq('id', attendeeId).maybeSingle();
      if (!attendee) throw new HttpError('No se ha encontrado el asistente.', 404);
      if (attendee.status === 'cancelled') throw new HttpError('No se puede marcar el pago de una persona cancelada.');
      if (paid && attendee.price_paid === null) {
        throw new HttpError('Antes de marcarla como pagada, registra el importe cobrado.');
      }
      const { error } = await db.from('attendees').update({ paid }).eq('id', attendeeId);
      if (error) throw new HttpError('No se pudo actualizar el pago.', 500);
      await writeAudit(db, { actor_type: 'admin', actor_id: admin.id, group_id: attendee.group_id, event_id: attendee.event_id, action: paid ? 'attendee.marked_paid' : 'attendee.marked_unpaid', details: { attendee_id: attendeeId, full_name: attendee.full_name, price_paid: attendee.price_paid } });
      return json(req, { ok: true, paid });
    }

    if (action === 'set_attendee_price') {
      const attendeeId = String(body.attendee_id ?? '');
      const rawPrice = body.price_paid;
      let pricePaid: number | null = null;
      if (rawPrice !== null && rawPrice !== undefined && rawPrice !== '') {
        if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 99999999.99) {
          throw new HttpError('Introduce un precio válido en euros.');
        }
        const cents = Math.round(rawPrice * 100);
        if (Math.abs(rawPrice * 100 - cents) > 0.000001) {
          throw new HttpError('El precio debe tener como máximo dos decimales.');
        }
        pricePaid = cents / 100;
      }
      const { data: attendee, error: attendeeError } = await db.from('attendees')
        .select('id, event_id, group_id, full_name, paid, entry_number, price_paid, status')
        .eq('id', attendeeId).maybeSingle();
      if (attendeeError || !attendee) throw new HttpError('No se ha encontrado el asistente.', 404);
      const locked = attendee.paid === true && attendee.entry_number !== null;
      if (attendee.paid === true && pricePaid === null) {
        throw new HttpError('No puedes quitar el importe mientras el pago siga marcado como pagado.');
      }
      if (locked && attendee.price_paid !== null && pricePaid !== Number(attendee.price_paid)) {
        throw new HttpError('El precio queda fijado cuando el pago está confirmado y se asigna el número de entrada.', 409, 'ATTENDEE_PRICE_LOCKED');
      }
      const { error: updateError } = await db.from('attendees')
        .update({ price_paid: pricePaid }).eq('id', attendeeId);
      if (updateError?.message?.includes('ATTENDEE_PRICE_LOCKED')) {
        throw new HttpError('El precio de esta entrada ya está fijado y no se puede modificar.', 409, 'ATTENDEE_PRICE_LOCKED');
      }
      if (updateError) throw new HttpError('No se pudo guardar el precio.', 500);
      await writeAudit(db, {
        actor_type: 'admin', actor_id: admin.id, group_id: attendee.group_id, event_id: attendee.event_id,
        action: 'attendee.price_updated',
        details: { attendee_id: attendeeId, full_name: attendee.full_name, previous_price: attendee.price_paid, price_paid: pricePaid },
      });
      return json(req, { ok: true, price_paid: pricePaid });
    }

    if (action === 'set_attendee_entry_number') {
      const attendeeId = String(body.attendee_id ?? '');
      const rawNumber = body.entry_number;
      const entryNumber = rawNumber === null || rawNumber === undefined || rawNumber === ''
        ? null
        : rawNumber;
      if (entryNumber !== null && (typeof entryNumber !== 'number' || !Number.isSafeInteger(entryNumber) || entryNumber < 1 || entryNumber > 2147483647)) {
        throw new HttpError('El número de entrada debe ser un entero positivo.');
      }
      const { data: attendee, error: attendeeError } = await db.from('attendees')
        .select('id, event_id, group_id, full_name, entry_number, status, paid, price_paid')
        .eq('id', attendeeId).maybeSingle();
      if (attendeeError || !attendee) throw new HttpError('No se ha encontrado el asistente.', 404);
      if (attendee.status === 'cancelled' && entryNumber !== null) {
        throw new HttpError('No se puede asignar un número de entrada a una persona cancelada.');
      }
      if (attendee.paid === true && entryNumber !== null && attendee.price_paid === null) {
        throw new HttpError('Registra primero el precio cobrado antes de asignar el número de entrada.');
      }
      if (attendee.paid === true && entryNumber === null) {
        throw new HttpError('Para retirar el número, marca primero el pago como pendiente.');
      }
      const { error: updateError } = await db.from('attendees')
        .update({ entry_number: entryNumber }).eq('id', attendeeId);
      if (updateError?.code === '23505') {
        throw new HttpError('Ese número ya está asignado a otra persona de este evento.', 409, 'ENTRY_NUMBER_IN_USE');
      }
      if (updateError) throw new HttpError('No se pudo guardar el número de entrada.', 500);
      await writeAudit(db, {
        actor_type: 'admin', actor_id: admin.id, group_id: attendee.group_id, event_id: attendee.event_id,
        action: entryNumber === null ? 'attendee.entry_number_removed' : 'attendee.entry_number_assigned',
        details: { attendee_id: attendeeId, full_name: attendee.full_name, previous_entry_number: attendee.entry_number, entry_number: entryNumber },
      });
      return json(req, { ok: true, entry_number: entryNumber });
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
