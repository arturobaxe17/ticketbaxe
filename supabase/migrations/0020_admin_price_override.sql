-- Let administration make a documented price correction on an already nominative entry.
-- Group users remain unable to change the price after it is frozen.
create or replace function public.prevent_locked_attendee_price_changes()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if old.price_frozen_at is not null
     and new.price_paid is distinct from old.price_paid
     and current_setting('ticketbaxe.admin_price_override', true) is distinct from 'on' then
    raise exception using
      message = 'ATTENDEE_PRICE_LOCKED',
      errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function public.admin_override_attendee_price(
  p_attendee_id uuid,
  p_price_paid numeric
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_price_paid is not null and (p_price_paid < 0 or p_price_paid > 99999999.99 or round(p_price_paid, 2) <> p_price_paid) then
    raise exception 'INVALID_PRICE' using errcode = '22023';
  end if;

  perform set_config('ticketbaxe.admin_price_override', 'on', true);

  update public.attendees
  set price_paid = p_price_paid
  where id = p_attendee_id;

  if not found then
    raise exception 'ATTENDEE_NOT_FOUND' using errcode = 'P0002';
  end if;
end;
$function$;

revoke all on function public.admin_override_attendee_price(uuid, numeric) from public;
revoke all on function public.admin_override_attendee_price(uuid, numeric) from anon;
revoke all on function public.admin_override_attendee_price(uuid, numeric) from authenticated;
grant execute on function public.admin_override_attendee_price(uuid, numeric) to service_role;
