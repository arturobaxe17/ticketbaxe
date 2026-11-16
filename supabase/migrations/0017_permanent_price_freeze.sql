alter table public.attendees
  add column if not exists price_frozen_at timestamptz;

comment on column public.attendees.price_frozen_at is
  'Timestamp at which price_paid became immutable after the attendee was marked paid and assigned an entry number.';

create or replace function public.freeze_attendee_price_on_nominative_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.price_frozen_at is null
     and new.paid is true
     and new.entry_number is not null
     and new.price_paid is not null then
    new.price_frozen_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.freeze_attendee_price_on_nominative_lock() from public, anon, authenticated;
grant execute on function public.freeze_attendee_price_on_nominative_lock() to service_role;

drop trigger if exists attendees_freeze_price_on_nominative_lock on public.attendees;
create trigger attendees_freeze_price_on_nominative_lock
before update of paid, entry_number, price_paid
on public.attendees
for each row
execute function public.freeze_attendee_price_on_nominative_lock();

create or replace function public.prevent_locked_attendee_price_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.price_frozen_at is not null
     and new.price_paid is distinct from old.price_paid then
    raise exception using
      message = 'ATTENDEE_PRICE_LOCKED',
      errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_locked_attendee_price_changes() from public, anon, authenticated;
grant execute on function public.prevent_locked_attendee_price_changes() to service_role;
