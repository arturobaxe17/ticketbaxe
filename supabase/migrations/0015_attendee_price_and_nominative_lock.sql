alter table public.attendees
  add column if not exists price_paid numeric(10,2);

alter table public.attendees
  drop constraint if exists attendees_price_paid_nonnegative;

alter table public.attendees
  add constraint attendees_price_paid_nonnegative
  check (price_paid is null or (price_paid >= 0 and price_paid <= 99999999.99));

comment on column public.attendees.price_paid is
  'Final amount paid by this attendee in EUR. Set by administrators; immutable after payment is confirmed and an entry number is assigned.';

-- Once an attendee is paid and has an entry number, a group cannot alter
-- nominative identity or cancel/reactivate that record. Admin changes remain
-- possible and the identity trigger will reset paid and entry_number.
create or replace function public.prevent_group_changes_to_locked_attendees()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.paid is true
     and old.entry_number is not null
     and new.updated_by_type = 'group'
     and (
       new.full_name is distinct from old.full_name
       or new.document_type is distinct from old.document_type
       or new.document_hash is distinct from old.document_hash
       or new.document_ciphertext is distinct from old.document_ciphertext
       or new.document_iv is distinct from old.document_iv
       or new.status is distinct from old.status
     ) then
    raise exception using
      message = 'ATTENDEE_LOCKED',
      errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_group_changes_to_locked_attendees() from public, anon, authenticated;
grant execute on function public.prevent_group_changes_to_locked_attendees() to service_role;

drop trigger if exists attendees_prevent_group_changes_locked on public.attendees;
create trigger attendees_prevent_group_changes_locked
before update of full_name, document_type, document_hash, document_ciphertext, document_iv, status, updated_by_type
on public.attendees
for each row
execute function public.prevent_group_changes_to_locked_attendees();

-- A recorded price is frozen after the payment + entry number combination.
-- Legacy rows with no recorded price can still have their price entered once.
create or replace function public.prevent_locked_attendee_price_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.paid is true
     and old.entry_number is not null
     and old.price_paid is not null
     and new.price_paid is distinct from old.price_paid then
    raise exception using
      message = 'ATTENDEE_PRICE_LOCKED',
      errcode = '23514';
  end if;

  if new.updated_by_type = 'group'
     and new.price_paid is distinct from old.price_paid then
    raise exception using
      message = 'ATTENDEE_PRICE_ADMIN_ONLY',
      errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_locked_attendee_price_changes() from public, anon, authenticated;
grant execute on function public.prevent_locked_attendee_price_changes() to service_role;

drop trigger if exists attendees_prevent_locked_price_changes on public.attendees;
create trigger attendees_prevent_locked_price_changes
before update of price_paid
on public.attendees
for each row
execute function public.prevent_locked_attendee_price_changes();
