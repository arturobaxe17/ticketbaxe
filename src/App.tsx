import { useEffect, useState, type FormEvent } from 'react';
import { adminApi, portalApi } from './lib/api';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import { dateTime, downloadCsv, maskDocument, toIso, toLocalInput } from './lib/utils';

type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;
type EventRecord = {
  id: string; name: string; description: string; starts_at: string; deadline_at: string;
  capacity: number | null; status: 'open' | 'closed' | 'cancelled'; poster_url?: string | null; is_published?: boolean;
  attendee_count?: number; confirmed_count?: number; pending_count?: number; group_count?: number;
  group_attendee_count?: number; total_attendee_count?: number; editable?: boolean;
};
type AttendeeForm = { id: string; full_name: string; document_type: 'DNI' | 'NIE' | 'PASSPORT'; document: string; status: 'pending' | 'confirmed' };
type Attendee = {
  id: string; event_id: string; group_id: string; full_name: string; document_type: 'DNI' | 'NIE' | 'PASSPORT';
  document: string; status: 'pending' | 'confirmed' | 'cancelled'; paid?: boolean; name_duplicate?: boolean; created_at?: string; updated_at?: string;
};
type GroupRecord = {
  id: string; label: string; responsible_name: string; contact: string; active: boolean;
  code_last4: string; event_ids: string[]; created_at: string;
};

const emptyAttendee: AttendeeForm = { id: '', full_name: '', document_type: 'DNI', document: '', status: 'confirmed' };

function App() {
  if (!hasSupabaseConfig) return <SetupNotice />;
  return window.location.pathname.startsWith('/admin') ? <AdminApp /> : <PortalApp />;
}

function SetupNotice() {
  return <main className="setup-shell"><div className="setup-card">
    <BrandMark />
    <span className="eyebrow">CONFIGURACIÓN INICIAL</span>
    <h1>La plataforma aún no está conectada.</h1>
    <p>Falta configurar la URL y la clave pública de tu proyecto Supabase en el archivo <code>.env</code>.</p>
    <div className="setup-code">VITE_SUPABASE_URL=...<br />VITE_SUPABASE_ANON_KEY=...</div>
    <p className="muted">Encontrarás los pasos completos en el README del proyecto.</p>
  </div></main>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}>
    <div className="brand-icon">✦</div>
    <div><div className="brand-name">TICKET<span>BAXE</span></div><div className="brand-caption">GESTIÓN DE INVITADOS</div></div>
  </div>;
}

function StatusPill({ status, editable }: { status: string; editable?: boolean }) {
  if (status === 'cancelled') return <span className="pill pill-red">Cancelado</span>;
  if (status === 'closed' || editable === false) return <span className="pill pill-muted">Cerrado</span>;
  if (status === 'pending') return <span className="pill pill-amber">Pendiente</span>;
  return <span className="pill pill-green">{status === 'open' ? 'Abierto' : 'Confirmado'}</span>;
}

function NoticeBar({ notice, clear }: { notice: Notice; clear: () => void }) {
  if (!notice) return null;
  return <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.text}</span><button className="notice-close" onClick={clear} aria-label="Cerrar aviso">×</button></div>;
}

function PortalApp() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem('navidad_portal_token'));
  const [group, setGroup] = useState<any>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [loginCode, setLoginCode] = useState('');
  const [form, setForm] = useState<AttendeeForm>({ ...emptyAttendee });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(Boolean(token));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const notify = (kind: NonNullable<Notice>['kind'], text: string) => setNotice({ kind, text });

  async function loadPortal(activeToken: string) {
    setLoading(true);
    try {
      const response = await portalApi<{ group: any; events: EventRecord[] }>('me', {}, activeToken);
      setGroup(response.group);
      setEvents(response.events ?? []);
    } catch (error) {
      sessionStorage.removeItem('navidad_portal_token');
      setToken(null); setGroup(null); setEvents([]);
      notify('error', (error as Error).message);
    } finally { setLoading(false); }
  }

  useEffect(() => { if (token) void loadPortal(token); else setLoading(false); }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault(); setLoading(true); setNotice(null);
    try {
      const response = await portalApi<{ token: string; group: any }>('login', { code: loginCode.trim() });
      sessionStorage.setItem('navidad_portal_token', response.token);
      setToken(response.token); setGroup(response.group);
      await loadPortal(response.token);
      setLoginCode('');
      notify('success', 'Acceso correcto. Ya puedes gestionar tus listas.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setLoading(false); }
  }

  async function openEvent(item: EventRecord) {
    if (!token) return;
    setLoading(true); setNotice(null);
    try {
      const response = await portalApi<{ event: EventRecord; attendees: Attendee[] }>('event', { event_id: item.id }, token);
      setSelectedEvent(response.event); setAttendees(response.attendees ?? []); setShowForm(false);
    } catch (error) { notify('error', (error as Error).message); }
    finally { setLoading(false); }
  }

  async function refreshSelected() {
    if (selectedEvent) await openEvent(selectedEvent);
    if (token) await loadPortal(token);
  }

  function startNew() { setForm({ ...emptyAttendee }); setShowForm(true); }
  function startEdit(attendee: Attendee) {
    setForm({ id: attendee.id, full_name: attendee.full_name, document_type: attendee.document_type, document: attendee.document, status: attendee.status === 'pending' ? 'pending' : 'confirmed' });
    setShowForm(true);
  }

  async function saveAttendee(event: FormEvent) {
    event.preventDefault();
    if (!selectedEvent || !token) return;
    setSaving(true); setNotice(null);
    try {
      await portalApi('save_attendee', {
        event_id: selectedEvent.id,
        attendee: { ...form, id: form.id || undefined },
      }, token);
      setShowForm(false); await refreshSelected();
      notify('success', form.id ? 'Asistente actualizado.' : 'Asistente añadido a tu lista.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setSaving(false); }
  }

  async function cancelAttendee(attendee: Attendee) {
    if (!selectedEvent || !token || !window.confirm(`¿Cancelar a ${attendee.full_name}? Se conservará el registro en el historial.`)) return;
    setSaving(true);
    try {
      await portalApi('cancel_attendee', { event_id: selectedEvent.id, attendee_id: attendee.id }, token);
      await refreshSelected(); notify('success', 'Asistente cancelado.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setSaving(false); }
  }

  async function logout() {
    if (token) await portalApi('logout', {}, token).catch(() => undefined);
    sessionStorage.removeItem('navidad_portal_token'); setToken(null); setGroup(null); setEvents([]); setSelectedEvent(null); setAttendees([]);
  }

  const activeAttendees = attendees.filter(person => person.status !== 'cancelled');
  const confirmedCount = activeAttendees.filter(person => person.status === 'confirmed').length;

  return <div className="app-shell portal-shell">
    <header className="topbar"><BrandMark compact /><div className="topbar-right"><span className="topbar-tag">ACCESO PRIVADO</span>{group && <button className="button button-ghost button-small" onClick={logout}>Cerrar sesión</button>}</div></header>
    <main className="main-wrap">
      <NoticeBar notice={notice} clear={() => setNotice(null)} />
      {loading && !group && <div className="loading-panel"><div className="spinner" />Comprobando acceso…</div>}
      {!token && !loading && <section className="login-layout">
        <div className="login-copy">
          <span className="eyebrow"><i className="status-dot" /> PORTAL DE RESPONSABLES</span>
          <h1>Tus invitados.<br /><em>Tu lista, siempre al día.</em></h1>
          <p>Gestiona las personas de tu grupo para cada concierto y evento de Navidad. Puedes modificar los datos hasta la fecha límite indicada.</p>
          <div className="feature-note"><span className="feature-icon">✓</span><span>Tu identificador solo permite acceder a los eventos asignados a tu grupo.</span></div>
        </div>
        <form className="login-card" onSubmit={handleLogin}>
          <div className="card-kicker">ÁREA PRIVADA</div><h2>Entrar a mis listas</h2><p>Introduce el identificador que te ha facilitado la organización.</p>
          <label className="field-label" htmlFor="group-code">Identificador de acceso</label>
          <input id="group-code" className="input input-code" autoComplete="off" autoCapitalize="characters" placeholder="NAV-XXXXXXXXXXXX" value={loginCode} onChange={e => setLoginCode(e.target.value.toUpperCase())} required />
          <button className="button button-primary button-full" disabled={loading || loginCode.trim().length < 8}>{loading ? 'Entrando…' : 'Acceder a mis listas'} <span>→</span></button>
          <div className="login-foot">¿No tienes tu identificador? Contacta con la organización.</div>
        </form>
      </section>}

      {token && group && !selectedEvent && <>
        <section className="welcome-row"><div><span className="eyebrow">ESPACIO DE RESPONSABLE</span><h1>Hola, {group.responsible_name.split(' ')[0]}.</h1><p>Gestionas el grupo <strong>{group.label}</strong>. Selecciona un evento para revisar tus asistentes.</p></div><div className="secure-chip"><span>●</span> Sesión privada</div></section>
        <div className="section-heading"><div><h2>Tus eventos</h2><p>Solo aparecen los eventos asignados a tu identificador.</p></div><span className="count-chip">{events.length} eventos</span></div>
        {events.length === 0 ? <EmptyState title="Todavía no tienes eventos asignados" text="Contacta con la organización para que asigne eventos a tu grupo." /> : <div className="event-grid">
          {events.map(item => <button className="event-card" key={item.id} onClick={() => void openEvent(item)}>
            <div className="event-card-top"><span className="event-date-tag">{new Date(item.starts_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span><StatusPill status={item.status} editable={item.editable} /></div>
            {item.poster_url && <img className="event-poster-thumb" src={item.poster_url} alt={`Cartel de ${item.name}`} />}<h3>{item.name}</h3><p className="event-date-full">{dateTime(item.starts_at)}</p>
            <div className="event-card-bottom"><span><strong>{item.group_attendee_count ?? 0}</strong> en tu grupo</span>{item.capacity ? <span>{item.total_attendee_count ?? 0}/{item.capacity} plazas</span> : <span>Sin aforo indicado</span>}<b>→</b></div>
            {item.editable ? <div className="deadline-line">Modificable hasta {dateTime(item.deadline_at)}</div> : <div className="deadline-line deadline-closed">Plazo de edición finalizado</div>}
          </button>)}
        </div>}
      </>}

      {selectedEvent && <>
        <button className="back-link" onClick={() => { setSelectedEvent(null); setShowForm(false); void loadPortal(token!); }}>← Volver a mis eventos</button>
        <section className="event-detail-header">{selectedEvent.poster_url && <img className="event-poster-detail" src={selectedEvent.poster_url} alt={`Cartel de ${selectedEvent.name}`} />}<div><span className="eyebrow">GESTIÓN DE ASISTENTES</span><h1>{selectedEvent.name}</h1><p>{dateTime(selectedEvent.starts_at)} <span className="dot-separator">·</span> Responsable: {group?.responsible_name}</p></div><StatusPill status={selectedEvent.status} editable={selectedEvent.editable} /></section>
        <div className="detail-stats"><div><span>Asistentes de tu grupo</span><strong>{activeAttendees.length}</strong></div><div><span>Entradas confirmadas</span><strong>{confirmedCount}</strong></div><div><span>Plazo de modificación</span><strong className="stat-date">{dateTime(selectedEvent.deadline_at)}</strong></div></div>
        {!selectedEvent.editable && <div className="locked-banner"><span>🔒</span><div><strong>La edición está cerrada.</strong><p>La organización ha cerrado este evento o ha terminado el plazo. Contacta con ella si necesitas solicitar un cambio.</p></div></div>}
        <div className="section-heading attendee-heading"><div><h2>Personas de tu grupo</h2><p>Cada persona activa cuenta como una entrada. Añade también al responsable si va a asistir.</p></div>{selectedEvent.editable && <button className="button button-primary" onClick={startNew}>＋ Añadir asistente</button>}</div>
        {attendees.length === 0 ? <EmptyState title="Aún no has añadido asistentes" text="Añade a las personas que forman parte de tu grupo para este evento." /> : <div className="table-card"><div className="table-scroll"><table><thead><tr><th>Nombre y apellidos</th><th>Documento</th><th>Estado</th><th>Pago</th><th className="action-cell">Acciones</th></tr></thead><tbody>
          {attendees.map(person => <tr key={person.id} className={person.status === 'cancelled' ? 'row-cancelled' : ''}><td><strong>{person.full_name}</strong></td><td><span className="document-type">{person.document_type}</span> {person.document}</td><td><StatusPill status={person.status} /></td><td>{person.status !== 'cancelled' ? (person.paid ? <span className="paid-label">✓ Pagado</span> : <span className="unpaid-label">Pendiente</span>) : '—'}</td><td className="action-cell">{selectedEvent.editable && <div className="row-actions"><button className="text-button" onClick={() => startEdit(person)}>{person.status === 'cancelled' ? 'Reactivar / editar' : 'Editar'}</button>{person.status !== 'cancelled' && <button className="text-button text-danger" onClick={() => void cancelAttendee(person)}>Cancelar</button>}</div>}</td></tr>)}
        </tbody></table></div><div className="table-foot">Los datos se guardan en el servidor. Las personas canceladas se conservan en el historial, pero no cuentan como entrada.</div></div>}
      </>}
    </main>
    <footer className="footer"><span>© {new Date().getFullYear()} · Listas privadas de eventos</span><span>Protección de datos · Acceso restringido</span></footer>

    {showForm && selectedEvent && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowForm(false); }}><form className="modal-card" onSubmit={saveAttendee}>
      <div className="modal-head"><div><span className="eyebrow">{form.id ? 'MODIFICAR REGISTRO' : 'NUEVA PERSONA'}</span><h2>{form.id ? 'Editar asistente' : 'Añadir asistente'}</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)}>×</button></div>
      <p className="modal-description">Una persona equivale a una entrada. Comprueba que el documento esté bien escrito.</p>
      <label className="field-label">Nombre y apellidos</label><input className="input" value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} required minLength={2} maxLength={140} placeholder="Nombre completo" />
      <div className="form-two"><div><label className="field-label">Tipo de documento</label><select className="input" value={form.document_type} onChange={e => setForm({ ...form, document_type: e.target.value as Attendee['document_type'] })}><option value="DNI">DNI</option><option value="NIE">NIE</option><option value="PASSPORT">Pasaporte</option></select></div><div><label className="field-label">Número de documento</label><input className="input" value={form.document} onChange={e => setForm({ ...form, document: e.target.value.toUpperCase() })} required maxLength={20} placeholder="00000000X" autoCapitalize="characters" /></div></div>
      <label className="field-label">Estado de la asistencia</label><select className="input" value={form.status} onChange={e => setForm({ ...form, status: e.target.value as 'pending' | 'confirmed' })}><option value="confirmed">Confirmada</option><option value="pending">Pendiente de confirmar</option></select>
      <div className="form-note">El DNI/NIE se valida antes de guardar. No se admiten documentos duplicados dentro del mismo evento.</div>
      <div className="modal-actions"><button type="button" className="button button-light" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar asistente'}</button></div>
    </form></div>}
  </div>;
}

function AdminApp() {
  const [session, setSession] = useState<any>(null);
  const [authStage, setAuthStage] = useState<'checking' | 'login' | 'verify' | 'enroll' | 'app'>('checking');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState('');
  const [factorId, setFactorId] = useState(''); const [qrCode, setQrCode] = useState(''); const [totpSecret, setTotpSecret] = useState('');
  const [notice, setNotice] = useState<Notice>(null); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'dashboard' | 'groups' | 'audit'>('dashboard');
  const [events, setEvents] = useState<EventRecord[]>([]); const [activeGroups, setActiveGroups] = useState(0);
  const [groups, setGroups] = useState<GroupRecord[]>([]); const [auditEntries, setAuditEntries] = useState<any[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [showEventForm, setShowEventForm] = useState(false); const [showGroupForm, setShowGroupForm] = useState(false);
  const [showAdminAttendeeForm, setShowAdminAttendeeForm] = useState(false); const [adminAttendeeForm, setAdminAttendeeForm] = useState<AttendeeForm & { group_id: string }>({ ...emptyAttendee, group_id: '' });
  const [newCode, setNewCode] = useState(''); const [newCodeGroupLabel, setNewCodeGroupLabel] = useState('');
  const [eventForm, setEventForm] = useState({ id: '', name: '', description: '', starts_at: '', deadline_at: '', capacity: '', is_published: true, poster_url: '' });
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [groupForm, setGroupForm] = useState({ id: '', label: '', responsible_name: '', contact: '', event_ids: [] as string[] });
  const [reopenDeadline, setReopenDeadline] = useState('');

  const notify = (kind: NonNullable<Notice>['kind'], text: string) => setNotice({ kind, text });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      if (data.session) { setSession(data.session); await prepareMfa(data.session); }
      else setAuthStage('login');
    })();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, current) => {
      if (!alive) return;
      setSession(current);
      if (!current) setAuthStage('login');
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);

  async function prepareMfa(currentSession: any) {
    if (currentSession.user?.app_metadata?.role !== 'admin') {
      await supabase.auth.signOut(); setAuthStage('login'); notify('error', 'Esta cuenta no tiene permisos de administrador.'); return;
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') { setAuthStage('app'); await loadDashboard(); return; }
    const { data: factorsData } = await supabase.auth.mfa.listFactors();
    const verified = factorsData?.totp?.find((item: any) => item.status === 'verified');
    if (verified) { setFactorId(verified.id); setAuthStage('verify'); }
    else {
      const unverified = factorsData?.totp?.filter((item: any) => item.status !== 'verified') ?? [];
      for (const factor of unverified) await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => undefined);
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Administrador TicketBaxe' });
      if (error || !data) { notify('error', error?.message || 'No se pudo iniciar la configuración de MFA.'); setAuthStage('login'); return; }
      setFactorId(data.id); setQrCode(data.totp.qr_code); setTotpSecret(data.totp.secret); setAuthStage('enroll');
    }
  }

  async function handleAdminLogin(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) throw new Error(error?.message || 'No se pudo iniciar sesión.');
      setSession(data.session);
      if (data.user.app_metadata?.role !== 'admin') { await supabase.auth.signOut(); throw new Error('Esta cuenta no tiene permisos de administrador.'); }
      await prepareMfa(data.session);
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function verifyMfa(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: totp.trim() });
      if (error) throw error;
      const { data } = await supabase.auth.getSession(); setSession(data.session);
      setAuthStage('app'); await loadDashboard(); notify('success', 'Verificación completada.');
    } catch (error) { notify('error', (error as Error).message || 'El código no es correcto.'); }
    finally { setBusy(false); setTotp(''); }
  }

  async function confirmEnrollment(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: totp.trim() });
      if (error) throw error;
      const { data } = await supabase.auth.getSession(); setSession(data.session);
      setAuthStage('app'); await loadDashboard(); notify('success', 'Verificación en dos pasos activada.');
    } catch (error) { notify('error', (error as Error).message || 'No se pudo verificar el código.'); }
    finally { setBusy(false); setTotp(''); }
  }

  async function loadDashboard() {
    try { const data = await adminApi<{ events: EventRecord[]; active_groups: number }>('dashboard'); setEvents(data.events ?? []); setActiveGroups(data.active_groups ?? 0); }
    catch (error) { notify('error', (error as Error).message); }
  }

  async function loadGroups() {
    try { const data = await adminApi<{ groups: GroupRecord[] }>('list_groups'); setGroups(data.groups ?? []); }
    catch (error) { notify('error', (error as Error).message); }
  }

  async function loadAudit() {
    try { const data = await adminApi<{ entries: any[] }>('audit'); setAuditEntries(data.entries ?? []); }
    catch (error) { notify('error', (error as Error).message); }
  }

  useEffect(() => { if (authStage === 'app') { if (tab === 'dashboard') void loadDashboard(); if (tab === 'groups') void loadGroups(); if (tab === 'audit') void loadAudit(); } }, [authStage, tab]);

  async function openAdminEvent(item: EventRecord) {
    setBusy(true);
    try { const data = await adminApi<any>('event_detail', { event_id: item.id }); setSelectedEvent(data); setReopenDeadline(toLocalInput(new Date(Date.now() + 60 * 60 * 1000).toISOString())); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function createOrUpdateEvent(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const payload = { name: eventForm.name, description: eventForm.description, starts_at: toIso(eventForm.starts_at), deadline_at: toIso(eventForm.deadline_at), capacity: eventForm.capacity ? Number(eventForm.capacity) : null, is_published: eventForm.is_published, poster_url: eventForm.poster_url || null };
      let savedEventId = eventForm.id;
      if (eventForm.id) await adminApi('update_event', { event_id: eventForm.id, ...payload });
      else {
        const created = await adminApi<{ event: EventRecord }>('create_event', payload);
        savedEventId = created.event.id;
      }
      if (savedEventId) setEventForm(current => ({ ...current, id: savedEventId }));
      if (posterFile && savedEventId) {
        const extension = posterFile.type === 'image/png' ? 'png' : posterFile.type === 'image/webp' ? 'webp' : 'jpg';
        const objectPath = `${savedEventId}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from('event-posters').upload(objectPath, posterFile, { cacheControl: '3600', upsert: false, contentType: posterFile.type });
        if (uploadError) throw uploadError;
        const publicUrl = supabase.storage.from('event-posters').getPublicUrl(objectPath).data.publicUrl;
        await adminApi('update_event', { event_id: savedEventId, poster_url: publicUrl });
      }
      setShowEventForm(false); setPosterFile(null); setEventForm({ id: '', name: '', description: '', starts_at: '', deadline_at: '', capacity: '', is_published: true, poster_url: '' });
      await loadDashboard(); notify('success', eventForm.id ? 'Evento actualizado.' : 'Evento creado.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (groupForm.id) {
        await adminApi('update_group', { group_id: groupForm.id, label: groupForm.label, responsible_name: groupForm.responsible_name, contact: groupForm.contact, event_ids: groupForm.event_ids });
        setShowGroupForm(false); setGroupForm({ id: '', label: '', responsible_name: '', contact: '', event_ids: [] });
        await loadGroups(); notify('success', 'Grupo actualizado.');
      } else {
        const result = await adminApi<{ group: GroupRecord; code: string }>('create_group', groupForm);
        setShowGroupForm(false); setGroupForm({ id: '', label: '', responsible_name: '', contact: '', event_ids: [] });
        setNewCode(result.code); setNewCodeGroupLabel(result.group.label); await loadGroups(); await loadDashboard();
        notify('success', 'Grupo creado. Copia el identificador: solo se mostrará esta vez.');
      }
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  function editGroup(group: GroupRecord) {
    setGroupForm({ id: group.id, label: group.label, responsible_name: group.responsible_name, contact: group.contact ?? '', event_ids: [...group.event_ids] });
    setShowGroupForm(true);
  }

  function editEvent(item: EventRecord) {
    setEventForm({ id: item.id, name: item.name, description: item.description ?? '', starts_at: toLocalInput(item.starts_at), deadline_at: toLocalInput(item.deadline_at), capacity: item.capacity ? String(item.capacity) : '', is_published: item.is_published !== false, poster_url: item.poster_url ?? '' });
    setPosterFile(null);
    setShowEventForm(true);
  }

  function editAdminAttendee(person: Attendee) {
    setAdminAttendeeForm({ id: person.id, group_id: person.group_id, full_name: person.full_name, document_type: person.document_type, document: person.document, status: person.status === 'pending' ? 'pending' : 'confirmed' });
    setShowAdminAttendeeForm(true);
  }

  async function regenerateCode(group: GroupRecord) {
    if (!window.confirm(`El identificador anterior de «${group.label}» dejará de funcionar. ¿Continuar?`)) return;
    setBusy(true);
    try { const result = await adminApi<{ code: string }>('regenerate_group_code', { group_id: group.id }); setNewCode(result.code); setNewCodeGroupLabel(group.label); notify('success', 'Identificador renovado. El anterior ha quedado revocado.'); await loadGroups(); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function toggleGroup(group: GroupRecord) {
    setBusy(true);
    try { await adminApi('set_group_active', { group_id: group.id, active: !group.active }); await loadGroups(); notify('success', group.active ? 'Grupo bloqueado.' : 'Grupo activado.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function closeEvent() {
    if (!selectedEvent) return;
    if (!window.confirm('Se bloquearán las modificaciones y se creará una versión oficial de la lista. ¿Cerrar este evento?')) return;
    setBusy(true);
    try { await adminApi('close_event', { event_id: selectedEvent.event.id }); await openAdminEvent(selectedEvent.event); await loadDashboard(); notify('success', 'Evento cerrado y lista oficial creada.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function publishSnapshot() {
    if (!selectedEvent) return;
    if (!window.confirm('Se creará una nueva versión oficial con los datos actuales. La versión anterior seguirá guardada. ¿Continuar?')) return;
    setBusy(true);
    try { await adminApi('publish_snapshot', { event_id: selectedEvent.event.id }); await openAdminEvent(selectedEvent.event); await loadDashboard(); notify('success', 'Nueva versión oficial publicada.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function reopenEvent() {
    if (!selectedEvent || !reopenDeadline) return;
    setBusy(true);
    try { await adminApi('reopen_event', { event_id: selectedEvent.event.id, deadline_at: toIso(reopenDeadline) }); await openAdminEvent(selectedEvent.event); await loadDashboard(); notify('success', 'Evento reabierto. Se conserva la versión oficial anterior.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function cancelEvent() {
    if (!selectedEvent || !window.confirm('¿Cancelar este evento? Los registros se conservarán, pero los responsables ya no podrán editar.')) return;
    setBusy(true);
    try { await adminApi('cancel_event', { event_id: selectedEvent.event.id }); await openAdminEvent(selectedEvent.event); await loadDashboard(); notify('success', 'Evento cancelado.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function saveAdminAttendee(event: FormEvent) {
    event.preventDefault(); if (!selectedEvent) return; setBusy(true);
    try {
      await adminApi('save_attendee', { event_id: selectedEvent.event.id, group_id: adminAttendeeForm.group_id, attendee: { id: adminAttendeeForm.id || undefined, full_name: adminAttendeeForm.full_name, document_type: adminAttendeeForm.document_type, document: adminAttendeeForm.document, status: adminAttendeeForm.status } });
      setShowAdminAttendeeForm(false); await openAdminEvent(selectedEvent.event); notify('success', 'Asistente guardado por administración.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function toggleAttendeePaid(person: Attendee) {
    if (!selectedEvent) return;
    setBusy(true);
    try {
      await adminApi('set_attendee_paid', { attendee_id: person.id, paid: !person.paid });
      await openAdminEvent(selectedEvent.event);
      notify('success', person.paid ? 'Pago marcado como pendiente.' : 'Asistente marcado como pagado.');
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function cancelAdminAttendee(person: Attendee) {
    if (!window.confirm(`¿Cancelar a ${person.full_name}?`)) return;
    setBusy(true);
    try { await adminApi('cancel_attendee', { attendee_id: person.id }); await openAdminEvent(selectedEvent.event); notify('success', 'Asistente cancelado.'); }
    catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function downloadSnapshot(snapshotId: string) {
    setBusy(true);
    try {
      const result = await adminApi<{ snapshot: any }>('download_snapshot', { snapshot_id: snapshotId });
      const snapshot = result.snapshot;
      const rows = (snapshot.records ?? []).map((person: any) => ({
        Evento: snapshot.event?.name ?? '', Responsable: person.group_label, Nombre: person.full_name,
        Tipo_documento: person.document_type, Documento: person.document,
        Estado: person.status === 'confirmed' ? 'Confirmado' : 'Pendiente', Pago: person.paid ? 'Pagado' : 'Pendiente',
      }));
      downloadCsv(`${(snapshot.event?.name ?? 'evento').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-lista-oficial-v${snapshot.version}.csv`, rows);
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function printSnapshot(snapshotId: string) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) { notify('error', 'El navegador ha bloqueado la ventana de impresión. Permite ventanas emergentes para este sitio.'); return; }
    setBusy(true);
    try {
      const result = await adminApi<{ snapshot: any }>('download_snapshot', { snapshot_id: snapshotId });
      const snapshot = result.snapshot;
      const escape = (value: unknown) => { const replacements: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }; return String(value ?? '').replace(/[&<>"']/g, char => replacements[char] ?? char); };
      const rows = (snapshot.records ?? []).map((person: any) => `<tr><td>${escape(person.group_label)}</td><td>${escape(person.full_name)}</td><td>${escape(person.document_type)}</td><td>${escape(person.document)}</td><td>${person.status === 'confirmed' ? 'Confirmado' : 'Pendiente'}</td><td>${person.paid ? 'Pagado' : 'Pendiente'}</td></tr>`).join('');
      printWindow.onload = () => printWindow.print();
      printWindow.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Lista oficial ${escape(snapshot.event?.name)}</title><style>body{font:12px Arial,sans-serif;color:#18243a;padding:28px}h1{font-size:22px;margin:0 0 6px}p{color:#59667a;margin:4px 0 18px}.meta{font-size:11px;color:#69758a;margin-bottom:18px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border:1px solid #d8dee7;font-size:11px}th{background:#eef1f5;text-transform:uppercase;font-size:9px;letter-spacing:.05em}.foot{margin-top:18px;color:#8b95a5;font-size:9px}@media print{body{padding:0}}</style></head><body><h1>${escape(snapshot.event?.name ?? 'Lista oficial')}</h1><p>${escape(dateTime(snapshot.event?.starts_at ?? ''))} · Versión oficial V${snapshot.version}</p><div class="meta">Generada: ${escape(dateTime(snapshot.generated_at ?? snapshot.created_at))} · ${snapshot.records?.length ?? 0} personas</div><table><thead><tr><th>Grupo</th><th>Nombre y apellidos</th><th>Tipo</th><th>Documento</th><th>Estado</th><th>Pago</th></tr></thead><tbody>${rows}</tbody></table><div class="foot">Documento interno de organización. Contiene datos personales; conserva y distribuye con acceso restringido.</div></body></html>`);
      printWindow.document.close();
    } catch (error) { printWindow.close(); notify('error', (error as Error).message); }
    finally { setBusy(false); }
  }

  async function downloadWorkingList() {
    if (!selectedEvent) return;
    const rows = (selectedEvent.attendees ?? []).filter((p: Attendee) => p.status !== 'cancelled').map((person: Attendee) => ({
      Grupo: selectedEvent.groups.find((g: GroupRecord) => g.id === person.group_id)?.label ?? '',
      Nombre: person.full_name, Tipo_documento: person.document_type, Documento: person.document,
      Estado: person.status === 'confirmed' ? 'Confirmado' : 'Pendiente', Pago: person.paid ? 'Pagado' : 'Pendiente',
    }));
    if (!rows.length) { notify('info', 'No hay asistentes activos para exportar.'); return; }
    downloadCsv(`${selectedEvent.event.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-lista-provisional.csv`, rows);
  }

  async function logoutAdmin() { await supabase.auth.signOut(); setSession(null); setAuthStage('login'); setSelectedEvent(null); }

  if (authStage !== 'app') return <div className="admin-auth-shell">
    <div className="admin-auth-top"><BrandMark compact /><a className="back-link" href="/">← Volver al portal</a></div>
    <div className="admin-auth-card">
      {authStage === 'checking' ? <div className="loading-panel"><div className="spinner" />Comprobando sesión…</div> : <>
        <div className="admin-lock">⌑</div><span className="eyebrow">ADMINISTRACIÓN PRIVADA</span>
        {authStage === 'login' && <><h1>Panel de control</h1><p>Accede con la cuenta de administrador.</p><form onSubmit={handleAdminLogin} className="stack-form"><label className="field-label">Correo electrónico</label><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" /><label className="field-label">Contraseña</label><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" /><button className="button button-primary button-full" disabled={busy}>{busy ? 'Accediendo…' : 'Entrar al panel →'}</button></form></>}
        {authStage === 'verify' && <><h1>Verificación en dos pasos</h1><p>Introduce el código de seis cifras de tu aplicación de autenticación.</p><form onSubmit={verifyMfa} className="stack-form"><label className="field-label">Código de autenticación</label><input className="input input-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))} required /><button className="button button-primary button-full" disabled={busy || totp.length !== 6}>{busy ? 'Verificando…' : 'Verificar y entrar'}</button></form></>}
        {authStage === 'enroll' && <><h1>Activa la verificación</h1><p>Escanea este QR con Google Authenticator, Microsoft Authenticator o una aplicación TOTP compatible.</p>{qrCode && <div className="qr-holder"><img src={`data:image/svg+xml;utf8,${encodeURIComponent(qrCode)}`} alt="Código QR para configurar MFA" /></div>}<div className="secret-box"><span>Clave manual</span><code>{totpSecret}</code></div><form onSubmit={confirmEnrollment} className="stack-form"><label className="field-label">Código de seis cifras</label><input className="input input-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))} required /><button className="button button-primary button-full" disabled={busy || totp.length !== 6}>{busy ? 'Activando…' : 'Activar y entrar'}</button></form></>}
        <NoticeBar notice={notice} clear={() => setNotice(null)} />
      </>}
      <div className="auth-bottom">Acceso restringido · Se requiere segundo factor de autenticación.</div>
    </div>
  </div>;

  return <div className="app-shell admin-shell">
    <header className="topbar"><BrandMark compact /><div className="topbar-right"><span className="admin-name">ADMINISTRADOR</span><button className="button button-ghost button-small" onClick={logoutAdmin}>Cerrar sesión</button></div></header>
    <main className="main-wrap admin-main"><NoticeBar notice={notice} clear={() => setNotice(null)} />
      {selectedEvent ? <>
        <button className="back-link" onClick={() => { setSelectedEvent(null); void loadDashboard(); }}>← Volver al panel</button>
        <section className="event-detail-header admin-detail-header"><div><span className="eyebrow">DETALLE DEL EVENTO</span><h1>{selectedEvent.event.name}</h1><p>{dateTime(selectedEvent.event.starts_at)} <span className="dot-separator">·</span> Cierre: {dateTime(selectedEvent.event.deadline_at)}</p></div><StatusPill status={selectedEvent.event.status} editable={selectedEvent.event.status === 'open' && new Date(selectedEvent.event.deadline_at).getTime() > Date.now()} /></section>
        <div className="detail-stats"><div><span>Asistentes activos</span><strong>{selectedEvent.attendees.filter((p: Attendee) => p.status !== 'cancelled').length}</strong></div><div><span>Grupos asignados</span><strong>{selectedEvent.groups.length}</strong></div><div><span>Aforo</span><strong className="stat-date">{selectedEvent.event.capacity ?? 'Sin límite'}</strong></div></div>
        <div className="admin-action-row">
          <button className="button button-light" onClick={() => editEvent(selectedEvent.event)}>Editar datos del evento</button>
          {selectedEvent.event.status === 'open' ? <button className="button button-primary" onClick={() => void closeEvent()} disabled={busy}>🔒 Cerrar y generar lista oficial</button> : selectedEvent.event.status === 'closed' ? <button className="button button-primary" onClick={() => void publishSnapshot()} disabled={busy}>＋ Publicar nueva versión oficial</button> : <span className="pill pill-red">Evento cancelado</span>}
          <button className="button button-light" onClick={downloadWorkingList}>Descargar lista provisional CSV</button>
          <button className="button button-danger-light" onClick={() => void cancelEvent()} disabled={selectedEvent.event.status === 'cancelled' || busy}>Cancelar evento</button>
        </div>
        {selectedEvent.event.status !== 'open' && selectedEvent.event.status !== 'cancelled' && <div className="reopen-panel"><div><strong>¿Necesitas abrirlo de nuevo?</strong><p>La versión oficial actual no se modifica. Al cerrar otra vez se generará una versión nueva.</p></div><div className="reopen-controls"><input type="datetime-local" className="input" value={reopenDeadline} onChange={e => setReopenDeadline(e.target.value)} /><button className="button button-light" onClick={() => void reopenEvent()} disabled={busy}>Reabrir evento</button></div></div>}
        <div className="section-heading"><div><h2>Asistentes registrados</h2><p>Los DNI solo se muestran dentro del panel protegido de administración.</p></div>{selectedEvent.event.status === 'open' && new Date(selectedEvent.event.deadline_at).getTime() > Date.now() && <button className="button button-primary" onClick={() => { setAdminAttendeeForm({ ...emptyAttendee, group_id: selectedEvent.groups[0]?.id ?? '' }); setShowAdminAttendeeForm(true); }}>＋ Añadir asistente</button>}</div>
        {(selectedEvent.event.status !== 'open' || new Date(selectedEvent.event.deadline_at).getTime() <= Date.now()) && selectedEvent.event.status !== 'cancelled' && <div className="locked-banner"><span>🔒</span><div><strong>Edición bloqueada.</strong><p>Para corregir un dato, reabre el evento con un nuevo plazo. Después podrás generar una nueva versión oficial.</p></div></div>}
        {selectedEvent.attendees.some((person: Attendee) => person.name_duplicate) && <div className="duplicate-alert"><strong>⚠ Posibles nombres repetidos detectados</strong><span>Revisa los avisos marcados en la lista y consúltalo con el responsable del grupo. No se bloquean automáticamente porque pueden ser personas distintas con el mismo nombre.</span></div>}
        <div className="table-card"><div className="table-scroll"><table><thead><tr><th>Grupo responsable</th><th>Nombre</th><th>Documento</th><th>Estado</th><th>Pago</th><th className="action-cell">Acciones</th></tr></thead><tbody>
          {selectedEvent.attendees.map((person: Attendee) => <tr key={person.id} className={person.status === 'cancelled' ? 'row-cancelled' : ''}><td>{selectedEvent.groups.find((g: GroupRecord) => g.id === person.group_id)?.label ?? '—'}</td><td><strong>{person.full_name}</strong></td><td><span className="document-type">{person.document_type}</span> {person.document}</td><td><StatusPill status={person.status} /></td><td>{person.status !== 'cancelled' ? <button className={`paid-toggle ${person.paid ? 'is-paid' : ''}`} onClick={() => void toggleAttendeePaid(person)} disabled={busy}>{person.paid ? '✓ Pagado' : 'Marcar pagado'}</button> : '—'}</td><td className="action-cell">{person.name_duplicate && <span className="duplicate-warning" title="Coincide con otro nombre de este evento">⚠ Nombre repetido</span>}{selectedEvent.event.status === 'open' && new Date(selectedEvent.event.deadline_at).getTime() > Date.now() && person.status !== 'cancelled' && <div className="row-actions"><button className="text-button" onClick={() => editAdminAttendee(person)}>Editar</button><button className="text-button text-danger" onClick={() => void cancelAdminAttendee(person)}>Cancelar</button></div>}</td></tr>)}
          {selectedEvent.attendees.length === 0 && <tr><td colSpan={6} className="empty-cell">No hay asistentes registrados.</td></tr>}
        </tbody></table></div></div>
        <div className="section-heading snapshots-heading"><div><h2>Versiones oficiales</h2><p>Cada versión queda congelada y se conserva aunque reabras el evento.</p></div></div>
        <div className="snapshot-list">{selectedEvent.snapshots.length === 0 ? <div className="empty-inline">Todavía no se ha generado una lista oficial.</div> : selectedEvent.snapshots.map((snapshot: any) => <div className="snapshot-row" key={snapshot.id}><div className="snapshot-badge">V{snapshot.version}</div><div className="snapshot-meta"><strong>Lista oficial · Versión {snapshot.version}</strong><span>{dateTime(snapshot.created_at)} · {snapshot.attendee_count} personas · {snapshot.confirmed_count} confirmadas · {snapshot.pending_count} pendientes</span></div><div className="snapshot-actions"><button className="button button-light button-small" onClick={() => void downloadSnapshot(snapshot.id)} disabled={busy}>Descargar CSV ↓</button><button className="button button-light button-small" onClick={() => void printSnapshot(snapshot.id)} disabled={busy}>Imprimir / PDF</button></div></div>)}</div>
        <div className="section-heading"><div><h2>Grupos asignados</h2><p>Responsables que pueden gestionar este evento.</p></div></div>
        <div className="group-chip-grid">{selectedEvent.groups.map((g: GroupRecord) => <div className="group-mini-card" key={g.id}><strong>{g.label}</strong><span>{g.responsible_name}</span><small>{g.active ? `Código terminado en ${g.code_last4}` : 'Acceso bloqueado'}</small></div>)}</div>
      </> : <>
        <div className="admin-title-row"><div><span className="eyebrow">CENTRO DE CONTROL</span><h1>Panel de administración</h1><p>Controla los eventos, los grupos y las listas oficiales.</p></div><div className="admin-title-actions"><button className="button button-light" onClick={() => { setEventForm({ id: '', name: '', description: '', starts_at: '', deadline_at: '', capacity: '', is_published: true, poster_url: '' }); setPosterFile(null); setShowEventForm(true); }}>＋ Crear evento</button><button className="button button-primary" onClick={() => { setGroupForm({ id: '', label: '', responsible_name: '', contact: '', event_ids: [] }); setShowGroupForm(true); void loadGroups(); }}>＋ Crear grupo</button></div></div>
        <nav className="admin-tabs"><button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>Eventos</button><button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}>Grupos y accesos</button><button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>Historial de actividad</button></nav>
        {tab === 'dashboard' && <>
          <div className="overview-cards"><div className="overview-card"><span>EVENTOS</span><strong>{events.length}</strong><small>En el calendario</small></div><div className="overview-card"><span>GRUPOS ACTIVOS</span><strong>{activeGroups}</strong><small>Con acceso habilitado</small></div><div className="overview-card"><span>PERSONAS APUNTADAS</span><strong>{events.reduce((sum, event) => sum + (event.attendee_count ?? 0), 0)}</strong><small>Suma de todos los eventos</small></div></div>
          <div className="section-heading"><div><h2>Calendario de eventos</h2><p>Abre cualquier evento para revisar las listas y generar su versión oficial.</p></div><button className="text-button" onClick={() => void loadDashboard()}>↻ Actualizar</button></div>
          {events.length === 0 ? <EmptyState title="Todavía no has creado eventos" text="Crea el primer concierto o evento navideño para empezar." /> : <div className="admin-event-list">{events.map(item => <button className="admin-event-row" key={item.id} onClick={() => void openAdminEvent(item)}>
            <div className="admin-event-date"><strong>{new Date(item.starts_at).toLocaleDateString('es-ES', { day: '2-digit' })}</strong><span>{new Date(item.starts_at).toLocaleDateString('es-ES', { month: 'short' }).replace('.', '')}</span></div>
            <div className="admin-event-name"><strong>{item.name}</strong><span>{dateTime(item.starts_at)} · {item.group_count ?? 0} grupos asignados</span></div>
            <div className="admin-event-count"><strong>{item.attendee_count ?? 0}</strong><span>asistentes</span></div>
            <div className="admin-event-confirmed"><strong>{item.confirmed_count ?? 0}</strong><span>confirmados</span></div>
            <StatusPill status={item.status} editable={item.status === 'open' && new Date(item.deadline_at).getTime() > Date.now()} /><b className="row-arrow">→</b>
          </button>)}</div>}
        </>}
        {tab === 'groups' && <>
          <div className="section-heading"><div><h2>Responsables y grupos</h2><p>Cada responsable recibe un identificador privado para gestionar sus invitados.</p></div><button className="button button-primary" onClick={() => { setGroupForm({ id: '', label: '', responsible_name: '', contact: '', event_ids: [] }); setShowGroupForm(true); }}>＋ Crear grupo</button></div>
          {groups.length === 0 ? <EmptyState title="No hay grupos creados" text="Crea un grupo, asígnale eventos y entrega su identificador al responsable." /> : <div className="group-list">{groups.map(group => <div className="group-row" key={group.id}><div className="group-avatar">{group.label.slice(0, 1).toUpperCase()}</div><div className="group-row-info"><strong>{group.label}</strong><span>{group.responsible_name}{group.contact ? ` · ${group.contact}` : ''}</span><small>Código terminado en {group.code_last4} · {group.event_ids.length} eventos asignados</small></div><span className={`group-active ${group.active ? 'is-active' : 'is-disabled'}`}>{group.active ? 'Activo' : 'Bloqueado'}</span><div className="row-actions"><button className="text-button" onClick={() => editGroup(group)}>Editar</button><button className="text-button" onClick={() => void regenerateCode(group)}>Renovar código</button><button className="text-button" onClick={() => void toggleGroup(group)}>{group.active ? 'Bloquear' : 'Activar'}</button></div></div>)}</div>}
        </>}
        {tab === 'audit' && <>
          <div className="section-heading"><div><h2>Actividad reciente</h2><p>Registro de cambios, accesos y cierres realizados en la plataforma.</p></div><button className="text-button" onClick={() => void loadAudit()}>↻ Actualizar</button></div>
          <div className="table-card"><div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Detalles</th></tr></thead><tbody>{auditEntries.map(entry => <tr key={entry.id}><td>{dateTime(entry.created_at)}</td><td><span className="document-type">{entry.actor_type}</span></td><td><strong>{entry.action}</strong></td><td>{Object.entries(entry.details ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '—'}</td></tr>)}{auditEntries.length === 0 && <tr><td colSpan={4} className="empty-cell">Todavía no hay actividad.</td></tr>}</tbody></table></div></div>
        </>}
      </>}
    </main>
    <footer className="footer"><span>© {new Date().getFullYear()} · TicketBaxe</span><span>Panel protegido con MFA · Datos cifrados</span></footer>

    {showEventForm && <div className="modal-backdrop"><form className="modal-card modal-wide" onSubmit={createOrUpdateEvent}><div className="modal-head"><div><span className="eyebrow">CALENDARIO</span><h2>{eventForm.id ? 'Editar evento' : 'Crear evento'}</h2></div><button type="button" className="icon-button" onClick={() => setShowEventForm(false)}>×</button></div><label className="field-label">Nombre del evento</label><input className="input" value={eventForm.name} onChange={e => setEventForm({ ...eventForm, name: e.target.value })} required maxLength={120} placeholder="Ej. Concierto Navidad · 19 de diciembre" /><label className="field-label">Descripción (opcional)</label><textarea className="input textarea" value={eventForm.description} onChange={e => setEventForm({ ...eventForm, description: e.target.value })} maxLength={800} placeholder="Información adicional para los responsables" /><div className="form-two"><div><label className="field-label">Fecha y hora del evento</label><input className="input" type="datetime-local" value={eventForm.starts_at} onChange={e => setEventForm({ ...eventForm, starts_at: e.target.value })} required /></div><div><label className="field-label">Límite para modificar listas</label><input className="input" type="datetime-local" value={eventForm.deadline_at} onChange={e => setEventForm({ ...eventForm, deadline_at: e.target.value })} required /></div></div><label className="field-label">Aforo máximo (opcional)</label><input className="input" type="number" min="1" max="100000" value={eventForm.capacity} onChange={e => setEventForm({ ...eventForm, capacity: e.target.value })} placeholder="Dejar vacío si no hay límite" /><label className="field-label">Cartel del evento (JPG, PNG o WEBP · máximo 5 MB)</label><input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setPosterFile(e.target.files?.[0] ?? null)} />{eventForm.poster_url && !posterFile && <div className="poster-current"><img src={eventForm.poster_url} alt="Cartel actual" /><span>Cartel actual guardado</span></div>}<label className="checkbox-option publish-option"><input type="checkbox" checked={eventForm.is_published} onChange={e => setEventForm({ ...eventForm, is_published: e.target.checked })} /><span><strong>Evento visible para los responsables</strong><small>Desmarca para ocultarlo sin eliminarlo ni perder sus listas.</small></span></label><div className="form-note">La hora se interpreta en la zona horaria del navegador (España peninsular). El servidor bloqueará las modificaciones al llegar al límite.</div><div className="modal-actions"><button type="button" className="button button-light" onClick={() => setShowEventForm(false)}>Cancelar</button><button className="button button-primary" disabled={busy}>{busy ? 'Guardando…' : eventForm.id ? 'Guardar cambios' : 'Guardar evento'}</button></div></form></div>}

    {showGroupForm && <div className="modal-backdrop"><form className="modal-card modal-wide" onSubmit={createGroup}><div className="modal-head"><div><span className="eyebrow">RESPONSABLES</span><h2>{groupForm.id ? 'Editar grupo' : 'Crear grupo'}</h2></div><button type="button" className="icon-button" onClick={() => setShowGroupForm(false)}>×</button></div><label className="field-label">Nombre del grupo</label><input className="input" value={groupForm.label} onChange={e => setGroupForm({ ...groupForm, label: e.target.value })} required placeholder="Ej. Grupo Juan" /><label className="field-label">Nombre del responsable</label><input className="input" value={groupForm.responsible_name} onChange={e => setGroupForm({ ...groupForm, responsible_name: e.target.value })} required placeholder="Nombre y apellidos" /><label className="field-label">Contacto (opcional)</label><input className="input" value={groupForm.contact} onChange={e => setGroupForm({ ...groupForm, contact: e.target.value })} placeholder="Teléfono o correo interno" /><label className="field-label">Eventos a los que tendrá acceso</label><div className="checkbox-grid">{events.map(item => <label className="checkbox-option" key={item.id}><input type="checkbox" checked={groupForm.event_ids.includes(item.id)} onChange={e => setGroupForm({ ...groupForm, event_ids: e.target.checked ? [...groupForm.event_ids, item.id] : groupForm.event_ids.filter(id => id !== item.id) })} /><span><strong>{item.name}</strong><small>{dateTime(item.starts_at)}</small></span></label>)}</div>{events.length === 0 && <p className="form-note">Primero debes crear al menos un evento.</p>}<div className="form-note">El identificador se mostrará una sola vez al crear el grupo. Cópialo y entrégaselo al responsable por un canal privado.</div><div className="modal-actions"><button type="button" className="button button-light" onClick={() => setShowGroupForm(false)}>Cancelar</button><button className="button button-primary" disabled={busy || events.length === 0 || groupForm.event_ids.length === 0}>{busy ? 'Guardando…' : groupForm.id ? 'Guardar cambios' : 'Crear grupo y generar código'}</button></div></form></div>}

    {showAdminAttendeeForm && selectedEvent && <div className="modal-backdrop"><form className="modal-card" onSubmit={saveAdminAttendee}><div className="modal-head"><div><span className="eyebrow">CORRECCIÓN ADMINISTRATIVA</span><h2>{adminAttendeeForm.id ? 'Editar asistente' : 'Añadir asistente'}</h2></div><button type="button" className="icon-button" onClick={() => setShowAdminAttendeeForm(false)}>×</button></div><label className="field-label">Grupo responsable</label><select className="input" value={adminAttendeeForm.group_id} onChange={e => setAdminAttendeeForm({ ...adminAttendeeForm, group_id: e.target.value })} required>{selectedEvent.groups.map((g: GroupRecord) => <option key={g.id} value={g.id}>{g.label} — {g.responsible_name}</option>)}</select><label className="field-label">Nombre y apellidos</label><input className="input" value={adminAttendeeForm.full_name} onChange={e => setAdminAttendeeForm({ ...adminAttendeeForm, full_name: e.target.value })} required /><div className="form-two"><div><label className="field-label">Tipo</label><select className="input" value={adminAttendeeForm.document_type} onChange={e => setAdminAttendeeForm({ ...adminAttendeeForm, document_type: e.target.value as Attendee['document_type'] })}><option value="DNI">DNI</option><option value="NIE">NIE</option><option value="PASSPORT">Pasaporte</option></select></div><div><label className="field-label">Documento</label><input className="input" value={adminAttendeeForm.document} onChange={e => setAdminAttendeeForm({ ...adminAttendeeForm, document: e.target.value.toUpperCase() })} required /></div></div><label className="field-label">Estado</label><select className="input" value={adminAttendeeForm.status} onChange={e => setAdminAttendeeForm({ ...adminAttendeeForm, status: e.target.value as 'confirmed' | 'pending' })}><option value="confirmed">Confirmado</option><option value="pending">Pendiente</option></select><div className="modal-actions"><button type="button" className="button button-light" onClick={() => setShowAdminAttendeeForm(false)}>Cancelar</button><button className="button button-primary" disabled={busy}>{busy ? 'Guardando…' : adminAttendeeForm.id ? 'Guardar cambios' : 'Guardar'}</button></div></form></div>}

    {newCode && <div className="modal-backdrop"><div className="modal-card code-card"><button type="button" className="icon-button modal-corner" onClick={() => setNewCode('')}>×</button><div className="success-emblem">✓</div><span className="eyebrow">IDENTIFICADOR GENERADO</span><h2>{newCodeGroupLabel}</h2><p>Entrega este código al responsable por un canal privado. No volverá a mostrarse completo.</p><div className="generated-code">{newCode}</div><button className="button button-primary button-full" onClick={() => { void navigator.clipboard.writeText(newCode); notify('success', 'Identificador copiado.'); }}>Copiar identificador</button><button className="text-button code-close" onClick={() => setNewCode('')}>Ya lo he guardado</button></div></div>}
  </div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-symbol">✦</div><strong>{title}</strong><p>{text}</p></div>;
}

export default App;
