-- TicketBaxe: private guest-list manager.
-- All application data is accessed through Edge Functions; direct client table access is revoked.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text not null default '',
  starts_at timestamptz not null,
  deadline_at timestamptz not null,
  capacity integer null check (capacity is null or capacity > 0),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_deadline_before_start check (deadline_at <= starts_at)
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(trim(label)) between 2 and 100),
  responsible_name text not null check (char_length(trim(responsible_name)) between 2 and 120),
  contact text not null default '',
  code_hash text not null unique,
  code_last4 text not null,
  active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_groups (
  event_id uuid not null references public.events(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, group_id)
);

create table if not exists public.attendees (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  group_id uuid not null references public.groups(id) on delete restrict,
  full_name text not null check (char_length(trim(full_name)) between 2 and 140),
  document_type text not null check (document_type in ('DNI', 'NIE', 'PASSPORT')),
  document_ciphertext text not null,
  document_iv text not null,
  document_hash text not null,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_type text not null default 'group' check (created_by_type in ('group', 'admin')),
  updated_by_type text not null default 'group' check (updated_by_type in ('group', 'admin')),
  constraint attendee_event_group_fk foreign key (event_id, group_id)
    references public.event_groups(event_id, group_id) on delete restrict
);

-- One non-cancelled attendee/document can only be registered once in an event.
create unique index if not exists attendees_unique_active_document
  on public.attendees(event_id, document_hash)
  where status <> 'cancelled';
create index if not exists attendees_event_status_idx on public.attendees(event_id, status);
create index if not exists attendees_group_event_idx on public.attendees(group_id, event_id);

create table if not exists public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists portal_sessions_group_idx on public.portal_sessions(group_id);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_type text not null check (actor_type in ('admin', 'group', 'system')),
  actor_id uuid null,
  group_id uuid null references public.groups(id) on delete set null,
  event_id uuid null references public.events(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on public.audit_log(created_at desc);
create index if not exists audit_log_event_idx on public.audit_log(event_id, created_at desc);

-- A snapshot contains a complete, encrypted copy of the official attendee list.
-- It is immutable from the application; a new version is created for later corrections.
create table if not exists public.official_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  version integer not null check (version > 0),
  attendee_count integer not null default 0,
  confirmed_count integer not null default 0,
  pending_count integer not null default 0,
  payload_ciphertext text not null,
  payload_iv text not null,
  created_by uuid null,
  created_by_type text not null default 'admin' check (created_by_type in ('admin', 'system')),
  created_at timestamptz not null default now(),
  unique (event_id, version)
);
create index if not exists official_snapshots_event_idx on public.official_snapshots(event_id, version desc);

-- Version allocation and snapshot insertion happen in one transaction while
-- locking the parent event. Concurrent admin clicks cannot create the same version.
create or replace function public.insert_official_snapshot(
  p_event_id uuid,
  p_attendee_count integer,
  p_confirmed_count integer,
  p_pending_count integer,
  p_payload_ciphertext text,
  p_payload_iv text,
  p_created_by uuid,
  p_created_by_type text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  locked_event public.events%rowtype;
  next_version integer;
  saved_snapshot public.official_snapshots%rowtype;
begin
  select * into locked_event from public.events where id = p_event_id for update;
  if not found or locked_event.status <> 'closed' then
    raise exception 'EVENT_NOT_CLOSED' using errcode = '23514';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.official_snapshots where event_id = p_event_id;

  insert into public.official_snapshots (
    event_id, version, attendee_count, confirmed_count, pending_count,
    payload_ciphertext, payload_iv, created_by, created_by_type
  ) values (
    p_event_id, next_version, p_attendee_count, p_confirmed_count, p_pending_count,
    p_payload_ciphertext, p_payload_iv, p_created_by, p_created_by_type
  ) returning * into saved_snapshot;

  return jsonb_build_object(
    'id', saved_snapshot.id,
    'event_id', saved_snapshot.event_id,
    'version', saved_snapshot.version,
    'attendee_count', saved_snapshot.attendee_count,
    'confirmed_count', saved_snapshot.confirmed_count,
    'pending_count', saved_snapshot.pending_count,
    'created_at', saved_snapshot.created_at,
    'created_by_type', saved_snapshot.created_by_type
  );
end;
$$;

revoke all on function public.insert_official_snapshot(uuid, integer, integer, integer, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.insert_official_snapshot(uuid, integer, integer, integer, text, text, uuid, text) to service_role;

create table if not exists public.portal_login_attempts (
  ip_hash text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  blocked_until timestamptz null
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger events_touch_updated_at before update on public.events
for each row execute function public.touch_updated_at();
create trigger groups_touch_updated_at before update on public.groups
for each row execute function public.touch_updated_at();
create trigger attendees_touch_updated_at before update on public.attendees
for each row execute function public.touch_updated_at();

-- Serializes all attendee writes against the parent event. All application writes are
-- checked against status/deadline inside the same transaction that writes the
-- attendee (including administrator corrections), so a request cannot pass a
-- stale application-level check and save after an administrator closes the event.
create or replace function public.enforce_attendee_write_rules()
returns trigger language plpgsql as $$
declare
  event_row public.events%rowtype;
  current_total integer;
begin
  select * into event_row
  from public.events
  where id = new.event_id
  for update;

  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = '23503';
  end if;

  if event_row.status <> 'open' or event_row.deadline_at <= now() then
    raise exception 'EVENT_CLOSED' using errcode = '23514';
  end if;

  if new.status <> 'cancelled' and event_row.capacity is not null then
    select count(*) into current_total
    from public.attendees
    where event_id = new.event_id
      and status <> 'cancelled'
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    if current_total >= event_row.capacity then
      raise exception 'CAPACITY_REACHED' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger attendees_write_rules
before insert or update of event_id, status, updated_by_type on public.attendees
for each row execute function public.enforce_attendee_write_rules();

-- A capacity reduction cannot silently put an event over its limit. The event
-- row is already locked by the UPDATE, which serializes it with attendee writes.
create or replace function public.enforce_event_capacity_change()
returns trigger language plpgsql as $$
declare
  current_total integer;
begin
  if new.capacity is not null then
    select count(*) into current_total
    from public.attendees
    where event_id = new.id and status <> 'cancelled';
    if current_total > new.capacity then
      raise exception 'CAPACITY_BELOW_CURRENT_ATTENDANCE' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger events_capacity_guard
before update of capacity on public.events
for each row execute function public.enforce_event_capacity_change();

-- Atomic rate-limit counter for group-code login. Ten failed attempts per
-- 15-minute window temporarily block the source IP hash.
create or replace function public.portal_login_allowed(p_ip_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  attempt_row public.portal_login_attempts%rowtype;
begin
  insert into public.portal_login_attempts(ip_hash, window_started_at, attempts)
  values (p_ip_hash, now(), 0)
  on conflict (ip_hash) do nothing;

  select * into attempt_row
  from public.portal_login_attempts
  where ip_hash = p_ip_hash
  for update;

  if attempt_row.blocked_until is not null and attempt_row.blocked_until > now() then
    return false;
  end if;

  if attempt_row.window_started_at < now() - interval '15 minutes' then
    update public.portal_login_attempts
      set window_started_at = now(), attempts = 1, blocked_until = null
      where ip_hash = p_ip_hash;
    return true;
  end if;

  update public.portal_login_attempts
    set attempts = attempts + 1,
        blocked_until = case when attempts + 1 > 10 then now() + interval '15 minutes' else null end
    where ip_hash = p_ip_hash;

  return attempt_row.attempts < 10;
end;
$$;

create or replace function public.clear_portal_login_attempt(p_ip_hash text)
returns void language sql security definer set search_path = public as $$
  delete from public.portal_login_attempts where ip_hash = p_ip_hash;
$$;

-- Direct access to these tables is intentionally unavailable to browser roles.
alter table public.events enable row level security;
alter table public.groups enable row level security;
alter table public.event_groups enable row level security;
alter table public.attendees enable row level security;
alter table public.portal_sessions enable row level security;
alter table public.audit_log enable row level security;
alter table public.official_snapshots enable row level security;
alter table public.portal_login_attempts enable row level security;

revoke all on public.events, public.groups, public.event_groups, public.attendees,
  public.portal_sessions, public.audit_log, public.official_snapshots,
  public.portal_login_attempts from anon, authenticated;

grant all on public.events, public.groups, public.event_groups, public.attendees,
  public.portal_sessions, public.audit_log, public.official_snapshots,
  public.portal_login_attempts to service_role;

grant execute on function public.portal_login_allowed(text) to service_role;
grant execute on function public.clear_portal_login_attempt(text) to service_role;
revoke all on function public.portal_login_allowed(text) from public, anon, authenticated;
revoke all on function public.clear_portal_login_attempt(text) from public, anon, authenticated;
