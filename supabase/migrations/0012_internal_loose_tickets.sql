-- Internal groups are reserved for administrator-only records such as loose tickets.
alter table public.groups
  add column if not exists is_internal boolean not null default false;

create unique index if not exists groups_single_internal_group
  on public.groups (is_internal)
  where is_internal = true;

comment on column public.groups.is_internal is
  'Internal administrator-only group. It has no usable portal code and is hidden from normal group management.';

-- Internal groups must not inflate the count of responsible groups in the admin dashboard.
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
    join public.groups g on g.id = eg.group_id
    where g.is_internal = false
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
