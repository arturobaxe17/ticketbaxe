import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const encoder = new TextEncoder();

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta configurar el secreto ${name}.`);
  return value;
}

const appSecretCache = new Map<string, string>();

export async function appSecret(name: string): Promise<string> {
  const configured = Deno.env.get(name);
  if (configured) return configured;
  const cached = appSecretCache.get(name);
  if (cached) return cached;
  const { data, error } = await adminDb().rpc('get_app_secret', { p_name: name });
  if (error || typeof data !== 'string' || !data) throw new Error(`Falta configurar el secreto ${name} en Supabase Vault.`);
  appSecretCache.set(name, data);
  return data;
}

function getSecretKey(): string {
  const modern = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed.default) return parsed.default;
    } catch { /* legacy fallback below */ }
  }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}

export function adminDb(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), getSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function authDb(accessToken: string): SupabaseClient {
  let key = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!key) {
    const keys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
    if (keys) {
      try { key = JSON.parse(keys).default ?? ''; } catch { /* ignored */ }
    }
  }
  if (!key) throw new Error('Falta configurar SUPABASE_ANON_KEY o SUPABASE_PUBLISHABLE_KEYS.');
  return createClient(env('SUPABASE_URL'), key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function corsHeaders(req: Request): Record<string, string> {
  const configured = Deno.env.get('ALLOWED_ORIGIN');
  const origin = req.headers.get('origin') ?? '';
  const allowOrigin = !configured || configured.split(',').map(x => x.trim()).includes(origin)
    ? (origin || '*')
    : configured.split(',')[0].trim();
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-portal-session, x-admin-email-session, x-admin-password-session, x-cron-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function fail(req: Request, message: string, status = 400, code?: string): Response {
  return json(req, { ok: false, error: message, ...(code ? { code } : {}) }, status);
}

export function getBearer(req: Request): string | null {
  const value = req.headers.get('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(decoded);
  } catch {
    throw new Error('La sesión no es válida.');
  }
}

export async function requireAdmin(req: Request): Promise<{ id: string; email: string | null }> {
  const token = getBearer(req);
  if (!token) throw new HttpError('Inicia sesión como administrador.', 401, 'AUTH_REQUIRED');
  const payload = jwtPayload(token);
  const methods = Array.isArray(payload.amr) ? payload.amr as Array<Record<string, unknown>> : [];
  if (!methods.some(method => method.method === 'otp')) {
    throw new HttpError('Debes completar el código enviado al correo.', 403, 'EMAIL_MFA_REQUIRED');
  }
  const client = authDb(token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError('La sesión de administrador ha caducado.', 401, 'AUTH_INVALID');
  if (data.user.app_metadata?.role !== 'admin') {
    throw new HttpError('Esta cuenta no tiene permisos de administración.', 403, 'ADMIN_REQUIRED');
  }
  const emailSessionToken = req.headers.get('x-admin-email-session') ?? '';
  if (emailSessionToken.length < 32) {
    throw new HttpError('Completa la verificación por correo para continuar.', 403, 'EMAIL_MFA_REQUIRED');
  }
  const sessionHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), `admin-email-session:${emailSessionToken}`);
  const { data: emailSession, error: sessionError } = await adminDb().from('admin_email_sessions')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', sessionHash).maybeSingle();
  if (sessionError || !emailSession || emailSession.user_id !== data.user.id || emailSession.revoked_at ||
      new Date(emailSession.expires_at).getTime() <= Date.now()) {
    throw new HttpError('La verificación por correo ha caducado. Vuelve a entrar.', 401, 'EMAIL_MFA_EXPIRED');
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message); this.status = status; this.code = code;
  }
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 24): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  data.forEach(v => binary += String.fromCharCode(v));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(v => binary += String.fromCharCode(v));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function encryptionKey(): Promise<CryptoKey> {
  const key = fromBase64(await appSecret('DNI_ENCRYPTION_KEY'));
  if (key.length !== 32) throw new Error('DNI_ENCRYPTION_KEY debe ser una clave Base64 de 32 bytes.');
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(plain: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), encoder.encode(plain));
  return { ciphertext: base64(new Uint8Array(encrypted)), iv: base64(iv) };
}

export async function decryptText(ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await encryptionKey(), fromBase64(ciphertext));
  return new TextDecoder().decode(decrypted);
}

export function normalizeDocument(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '').trim();
}

export function validateDocument(type: string, value: string): string {
  const normalized = normalizeDocument(value);
  if (type === 'PASSPORT') {
    if (!/^[A-Z0-9]{5,20}$/.test(normalized)) throw new HttpError('Pasaporte incorrecto. Comprueba el formato.');
    return normalized;
  }
  if (type === 'DNI') {
    if (!/^\d{8}[A-Z]$/.test(normalized)) throw new HttpError('DNI incorrecto. Debe tener 8 números y una letra.');
    const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
    if (letters[Number(normalized.slice(0, 8)) % 23] !== normalized[8]) throw new HttpError('DNI incorrecto. Comprueba el número y la letra.');
    return normalized;
  }
  if (type === 'NIE') {
    if (!/^[XYZ]\d{7}[A-Z]$/.test(normalized)) throw new HttpError('NIE incorrecto. Comprueba el formato.');
    const mapped = normalized.replace(/^X/, '0').replace(/^Y/, '1').replace(/^Z/, '2');
    const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
    if (letters[Number(mapped.slice(0, 8)) % 23] !== normalized[8]) throw new HttpError('NIE incorrecto. Comprueba el número y la letra.');
    return normalized;
  }
  throw new HttpError('Tipo de documento no válido.');
}

export async function documentHash(normalized: string): Promise<string> {
  return hmacHex(await appSecret('DNI_HASH_SECRET'), normalized);
}

export async function writeAudit(
  db: SupabaseClient,
  values: { actor_type: 'admin' | 'group' | 'system'; actor_id?: string | null; group_id?: string | null; event_id?: string | null; action: string; details?: Record<string, unknown> },
): Promise<void> {
  const { error } = await db.from('audit_log').insert({
    actor_type: values.actor_type,
    actor_id: values.actor_id ?? null,
    group_id: values.group_id ?? null,
    event_id: values.event_id ?? null,
    action: values.action,
    details: values.details ?? {},
  });
  if (error) console.error('No se pudo guardar auditoría:', error.message);
}

export async function decryptAttendee(row: Record<string, any>): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    event_id: row.event_id,
    group_id: row.group_id,
    full_name: row.full_name,
    document_type: row.document_type,
    document: await decryptText(row.document_ciphertext, row.document_iv),
    status: row.status,
    paid: row.paid === true,
    entry_number: row.entry_number ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by_type: row.created_by_type,
  };
}

export function assertString(value: unknown, label: string, max = 140): string {
  if (typeof value !== 'string') throw new HttpError(`${label} es obligatorio.`);
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > max) throw new HttpError(`${label} debe tener entre 2 y ${max} caracteres.`);
  return trimmed;
}

export async function getGroupSession(req: Request, db: SupabaseClient): Promise<{ sessionId: string; group: Record<string, any> }> {
  const token = req.headers.get('x-portal-session');
  if (!token || token.length < 20) throw new HttpError('Introduce de nuevo tu identificador.', 401, 'PORTAL_AUTH');
  const tokenHash = await hmacHex(await appSecret('SESSION_HASH_SECRET'), token);
  const { data: session, error } = await db.from('portal_sessions')
    .select('id, group_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash).maybeSingle();
  if (error || !session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    throw new HttpError('El acceso ha caducado. Vuelve a introducir tu identificador.', 401, 'PORTAL_AUTH');
  }
  const { data: group } = await db.from('groups')
    .select('id, label, responsible_name, contact, active')
    .eq('id', session.group_id).maybeSingle();
  if (!group?.active) throw new HttpError('Este identificador ha sido desactivado. Contacta con la organización.', 403, 'GROUP_DISABLED');
  return { sessionId: session.id, group };
}

export async function eventIsEditable(db: SupabaseClient, eventId: string): Promise<Record<string, any>> {
  const { data: event, error } = await db.from('events').select('*').eq('id', eventId).maybeSingle();
  if (error || !event) throw new HttpError('No se ha encontrado el evento.', 404, 'EVENT_NOT_FOUND');
  if (event.status !== 'open' || new Date(event.deadline_at).getTime() <= Date.now()) {
    throw new HttpError('El plazo de modificación de este evento ha terminado.', 409, 'EVENT_CLOSED');
  }
  return event;
}

export async function storeAttendee(
  db: SupabaseClient,
  input: Record<string, unknown>,
  groupId: string,
  actorType: 'admin' | 'group',
): Promise<Record<string, unknown>> {
  const eventId = typeof input.event_id === 'string' ? input.event_id : '';
  if (!eventId) throw new HttpError('Falta seleccionar el evento.');
  const id = typeof input.id === 'string' && input.id ? input.id : null;
  const fullName = assertString(input.full_name, 'El nombre', 140);
  const documentType = input.document_type;
  if (documentType !== 'DNI' && documentType !== 'NIE' && documentType !== 'PASSPORT') throw new HttpError('Selecciona un tipo de documento válido.');
  const normalized = validateDocument(documentType, String(input.document ?? ''));
  const status = input.status === 'pending' ? 'pending' : 'confirmed';
  const hash = await documentHash(normalized);
  const encrypted = await encryptText(normalized);

  if (id) {
    const { data: existing, error: existingError } = await db.from('attendees')
      .select('id, group_id, event_id, full_name, document_type, document_hash, paid, entry_number')
      .eq('id', id).maybeSingle();
    if (existingError || !existing || existing.group_id !== groupId || existing.event_id !== eventId) {
      throw new HttpError('No puedes modificar este asistente.', 404, 'ATTENDEE_NOT_FOUND');
    }
    const identityChanged =
      existing.full_name !== fullName ||
      existing.document_type !== documentType ||
      existing.document_hash !== hash;
    const updateValues: Record<string, unknown> = {
      full_name: fullName, document_type: documentType, document_ciphertext: encrypted.ciphertext,
      document_iv: encrypted.iv, document_hash: hash, status, updated_by_type: actorType,
    };
    // Explicitly reset here as well as in the DB trigger. Changing identity details
    // means the old payment confirmation no longer refers to the same attendee.
    if (identityChanged) {
      updateValues.paid = false;
      updateValues.entry_number = null;
    }
    const { data, error } = await db.from('attendees').update(updateValues)
      .eq('id', id).select('id, event_id, group_id, full_name, document_type, status, paid, entry_number, updated_at').single();
    if (error) {
      if (error.code === '23505') throw new HttpError('Este DNI/NIE/pasaporte ya está registrado en este evento.', 409, 'DUPLICATE_DOCUMENT');
      if (error.message.includes('CAPACITY_REACHED')) throw new HttpError('Se ha alcanzado el aforo máximo del evento.', 409, 'CAPACITY_REACHED');
      throw new HttpError('No se pudo guardar el asistente. Revisa los datos e inténtalo de nuevo.', 500);
    }
    await writeAudit(db, {
      actor_type: actorType, actor_id: groupId, group_id: groupId, event_id: eventId,
      action: 'attendee.updated',
      details: {
        attendee_id: id,
        status,
        identity_changed: identityChanged,
        payment_reset: identityChanged && existing.paid === true,
      entry_number_reset: identityChanged && existing.entry_number !== null,
        entry_number_reset: identityChanged && existing.entry_number !== null,
      },
    });
    return {
      ...data,
      document: normalized,
      payment_reset: identityChanged && existing.paid === true,
    };
  }

  const { data, error } = await db.from('attendees').insert({
    event_id: eventId, group_id: groupId, full_name: fullName, document_type: documentType,
    document_ciphertext: encrypted.ciphertext, document_iv: encrypted.iv, document_hash: hash,
    status, created_by_type: actorType, updated_by_type: actorType,
  }).select('id, event_id, group_id, full_name, document_type, status, created_at').single();
  if (error) {
    if (error.code === '23505') throw new HttpError('Este DNI/NIE/pasaporte ya está registrado en este evento.', 409, 'DUPLICATE_DOCUMENT');
    if (error.message.includes('CAPACITY_REACHED')) throw new HttpError('Se ha alcanzado el aforo máximo del evento.', 409, 'CAPACITY_REACHED');
    throw new HttpError('No se pudo guardar el asistente. Revisa los datos e inténtalo de nuevo.', 500);
  }
  await writeAudit(db, { actor_type: actorType, actor_id: groupId, group_id: groupId, event_id: eventId, action: 'attendee.created', details: { attendee_id: data.id, status } });
  return { ...data, document: normalized };
}

export async function createOfficialSnapshot(
  db: SupabaseClient,
  eventId: string,
  actorId: string | null,
  actorType: 'admin' | 'system',
): Promise<Record<string, unknown>> {
  const { data: event, error: eventError } = await db.from('events').select('id, name, starts_at, deadline_at, capacity, status').eq('id', eventId).single();
  if (eventError || !event) throw new HttpError('No se ha encontrado el evento.', 404);
  if (event.status !== 'closed') throw new HttpError('El evento debe estar cerrado antes de crear una lista oficial.', 409, 'EVENT_NOT_CLOSED');
  const { data: rows, error: rowsError } = await db.from('attendees')
    .select('id, group_id, full_name, document_type, document_ciphertext, document_iv, status, paid, entry_number, created_at, updated_at')
    .eq('event_id', eventId).neq('status', 'cancelled').order('full_name');
  if (rowsError) throw new HttpError('No se pudo preparar la lista oficial.', 500);
  const groupIds = [...new Set((rows ?? []).map((r: any) => r.group_id))];
  const groupMap: Record<string, string> = {};
  if (groupIds.length) {
    const { data: groups } = await db.from('groups').select('id, label, responsible_name').in('id', groupIds);
    for (const group of groups ?? []) groupMap[group.id] = group.label;
  }
  const records = [];
  for (const row of rows ?? []) {
    records.push({
      id: row.id, group_id: row.group_id, group_label: groupMap[row.group_id] ?? 'Grupo',
      full_name: row.full_name, document_type: row.document_type,
      document: await decryptText(row.document_ciphertext, row.document_iv), status: row.status, paid: row.paid === true,
      entry_number: row.entry_number ?? null,
      created_at: row.created_at, updated_at: row.updated_at,
    });
  }
  const { ciphertext, iv } = await encryptText(JSON.stringify({ event, records, generated_at: new Date().toISOString() }));
  const confirmed = records.filter((r: any) => r.status === 'confirmed').length;
  const pending = records.filter((r: any) => r.status === 'pending').length;
  const { data: snapshot, error } = await db.rpc('insert_official_snapshot', {
    p_event_id: eventId,
    p_attendee_count: records.length,
    p_confirmed_count: confirmed,
    p_pending_count: pending,
    p_payload_ciphertext: ciphertext,
    p_payload_iv: iv,
    p_created_by: actorId,
    p_created_by_type: actorType,
  });
  if (error || !snapshot) throw new HttpError('No se pudo guardar la versión oficial.', 500);
  await writeAudit(db, { actor_type: actorType === 'system' ? 'system' : 'admin', actor_id: actorId, event_id: eventId, action: 'event.snapshot_created', details: { version: snapshot.version, attendee_count: records.length } });
  return snapshot;
}

export async function closeDueEvents(db: SupabaseClient): Promise<number> {
  const { data: due, error } = await db.from('events').select('id').eq('status', 'open').lte('deadline_at', new Date().toISOString()).limit(100);
  if (error) throw new HttpError('No se han podido comprobar los cierres automáticos.', 500);
  let closed = 0;
  for (const event of due ?? []) {
    try {
      // Claim the event by changing its state before reading its list. The row
      // update is serialized with attendee writes by the database trigger.
      const { data: claimed, error: claimError } = await db.from('events')
        .update({ status: 'closed' }).eq('id', event.id).eq('status', 'open')
        .lte('deadline_at', new Date().toISOString()).select('id').maybeSingle();
      if (claimError || !claimed) continue;
      await createOfficialSnapshot(db, event.id, null, 'system');
      closed += 1;
    } catch (error) {
      console.error('Fallo cerrando evento', event.id, error);
    }
  }
  return closed;
}
