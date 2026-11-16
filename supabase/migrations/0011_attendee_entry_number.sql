-- Administrator-assigned entry numbers. Each number is unique within its event.
alter table public.attendees
  add column if not exists entry_number integer;

alter table public.attendees
  drop constraint if exists attendees_entry_number_positive;

alter table public.attendees
  add constraint attendees_entry_number_positive
  check (entry_number is null or entry_number > 0);

create unique index if not exists attendees_event_entry_number_unique
  on public.attendees (event_id, entry_number)
  where entry_number is not null;

comment on column public.attendees.entry_number is
  'Entry number assigned only by administrators; visible to the responsible group.';

-- Editing identity details invalidates both the previous payment confirmation
-- and any entry number assigned to the previous identity.
create or replace function public.reset_attendee_payment_on_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.full_name is distinct from old.full_name
     or new.document_type is distinct from old.document_type
     or new.document_hash is distinct from old.document_hash then
    new.paid := false;
    new.entry_number := null;
  end if;

  return new;
end;
$$;

revoke all on function public.reset_attendee_payment_on_identity_change() from public, anon, authenticated;
grant execute on function public.reset_attendee_payment_on_identity_change() to service_role;

drop trigger if exists attendees_reset_paid_on_identity_change on public.attendees;
create trigger attendees_reset_paid_on_identity_change
before update of full_name, document_type, document_hash
on public.attendees
for each row
execute function public.reset_attendee_payment_on_identity_change();
