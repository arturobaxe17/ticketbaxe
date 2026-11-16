-- Once a ticket has ever reached the paid + numbered state, the group-side
-- edit lock remains permanent. Admin can still correct the record.
create or replace function public.prevent_group_changes_to_locked_attendees()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.price_frozen_at is not null
      or (old.paid is true and old.entry_number is not null))
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
