-- Query efficiency for larger events and group lists.
create index if not exists attendees_event_group_idx
  on public.attendees(event_id, group_id);
create index if not exists audit_log_group_id_idx
  on public.audit_log(group_id);
create index if not exists event_groups_group_id_idx
  on public.event_groups(group_id);

-- Return dashboard counters in one database round-trip.
create or replace function public.get_admin_event_metrics()
returns table (
  event_id uuid,
  attendee_count bigint,
  confirmed_count bigint,
  pending_count bigint,
  group_count bigint
)
language sql
stable
set search_path = ''
as $$
  with attendee_metrics as (
    select
      a.event_id,
      count(*) filter (where a.status <> 'cancelled') as attendee_count,
      count(*) filter (where a.status = 'confirmed') as confirmed_count,
      count(*) filter (where a.status = 'pending') as pending_count
    from public.attendees a
    group by a.event_id
  ),
  group_metrics as (
    select eg.event_id, count(*) as group_count
    from public.event_groups eg
    group by eg.event_id
  )
  select
    e.id,
    coalesce(am.attendee_count, 0),
    coalesce(am.confirmed_count, 0),
    coalesce(am.pending_count, 0),
    coalesce(gm.group_count, 0)
  from public.events e
  left join attendee_metrics am on am.event_id = e.id
  left join group_metrics gm on gm.event_id = e.id;
$$;

revoke all on function public.get_admin_event_metrics() from public, anon, authenticated;
grant execute on function public.get_admin_event_metrics() to service_role;

-- Return the current group's event totals with a single grouped query.
create or replace function public.get_group_event_metrics(
  p_group_id uuid,
  p_event_ids uuid[]
)
returns table (
  event_id uuid,
  group_attendee_count bigint,
  total_attendee_count bigint
)
language sql
stable
set search_path = ''
as $$
  with target_events as (
    select distinct unnest(coalesce(p_event_ids, array[]::uuid[])) as event_id
  ),
  attendee_metrics as (
    select
      a.event_id,
      count(*) filter (
        where a.group_id = p_group_id and a.status <> 'cancelled'
      ) as group_attendee_count,
      count(*) filter (
        where a.status <> 'cancelled'
      ) as total_attendee_count
    from public.attendees a
    inner join target_events t on t.event_id = a.event_id
    group by a.event_id
  )
  select
    t.event_id,
    coalesce(am.group_attendee_count, 0),
    coalesce(am.total_attendee_count, 0)
  from target_events t
  left join attendee_metrics am on am.event_id = t.event_id;
$$;

revoke all on function public.get_group_event_metrics(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_group_event_metrics(uuid, uuid[]) to service_role;

-- Daily housekeeping: keep expired/revoked session and OTP rows from accumulating.
create or replace function public.cleanup_ticketbaxe_expired_sessions()
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.admin_email_challenges
   where expires_at < now() - interval '1 day'
      or used_at < now() - interval '1 day';

  delete from public.admin_email_sessions
   where expires_at < now() - interval '1 day'
      or revoked_at < now() - interval '1 day';

  delete from public.portal_sessions
   where expires_at < now() - interval '7 days'
      or revoked_at < now() - interval '7 days';

  delete from public.portal_login_attempts
   where window_started_at < now() - interval '2 days'
     and (blocked_until is null or blocked_until < now() - interval '2 days');
end;
$$;

revoke all on function public.cleanup_ticketbaxe_expired_sessions() from public, anon, authenticated;
grant execute on function public.cleanup_ticketbaxe_expired_sessions() to service_role;

do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'ticketbaxe-daily-cleanup'
  ) then
    perform cron.schedule(
      'ticketbaxe-daily-cleanup',
      '15 3 * * *',
      'select public.cleanup_ticketbaxe_expired_sessions();'
    );
  end if;
end;
$$;
