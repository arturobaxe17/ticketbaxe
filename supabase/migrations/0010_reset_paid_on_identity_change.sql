-- Any change to attendee identity details invalidates the previous payment confirmation.
-- This is enforced in PostgreSQL so it applies to both group and admin edits.
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
