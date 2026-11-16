-- Price updates are an administrator-only Edge Function operation.
-- Do not depend on updated_by_type here: the table's event-closing trigger
-- deliberately treats changes to that audit column as attendee-list writes.
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
  return new;
end;
$$;

revoke all on function public.prevent_locked_attendee_price_changes() from public, anon, authenticated;
grant execute on function public.prevent_locked_attendee_price_changes() to service_role;
