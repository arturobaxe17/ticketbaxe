-- Pause controls and attendee-level history
alter table public.events
  add column if not exists is_paused boolean not null default false;

alter table public.groups
  add column if not exists is_paused boolean not null default false;

-- Keep audit trails even if an attendee record is later removed.
alter table public.audit_log
  add column if not exists attendee_id uuid;

update public.audit_log
set attendee_id = (details->>'attendee_id')::uuid
where attendee_id is null
  and details ? 'attendee_id'
  and (details->>'attendee_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

create index if not exists audit_log_attendee_history_idx
  on public.audit_log (attendee_id, created_at desc)
  where attendee_id is not null;

create or replace function public.enforce_attendee_write_rules()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  event_row public.events%rowtype;
  current_total integer;
  group_paused boolean;
  group_write boolean;
begin
  select * into event_row
  from public.events
  where id = new.event_id
  for update;

  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = '23503';
  end if;

  group_write := (tg_op = 'INSERT' and new.created_by_type = 'group')
    or (tg_op = 'UPDATE' and new.updated_by_type = 'group');

  if group_write then
    if event_row.is_paused then
      raise exception 'EVENT_PAUSED' using errcode = '23514';
    end if;

    select is_paused into group_paused
    from public.groups
    where id = new.group_id;

    if coalesce(group_paused, false) then
      raise exception 'GROUP_PAUSED' using errcode = '23514';
    end if;
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
$function$;
