-- Atomically mark / reverse the amount remitted to the event establishment and write its audit entry.
create or replace function public.set_attendee_establishment_paid(
  p_attendee_id uuid,
  p_admin_id uuid,
  p_paid boolean
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  attendee_row record;
  paid_at_value timestamptz;
  paid_amount_value numeric(10,2);
begin
  if p_admin_id is null then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select id, event_id, group_id, full_name, status, paid, price_paid,
         establishment_paid_at, establishment_paid_amount
    into attendee_row
  from public.attendees
  where id = p_attendee_id
  for update;

  if not found then
    raise exception 'ATTENDEE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_paid then
    if attendee_row.status = 'cancelled' then
      raise exception 'ATTENDEE_CANCELLED' using errcode = '23514';
    end if;
    if attendee_row.paid is distinct from true then
      raise exception 'CUSTOMER_PAYMENT_REQUIRED' using errcode = '23514';
    end if;
    if attendee_row.price_paid is null then
      raise exception 'ATTENDEE_PRICE_REQUIRED' using errcode = '23514';
    end if;

    if attendee_row.establishment_paid_at is null then
      paid_at_value := now();
      paid_amount_value := attendee_row.price_paid;

      update public.attendees
      set establishment_paid_at = paid_at_value,
          establishment_paid_amount = paid_amount_value,
          establishment_paid_by = p_admin_id
      where id = p_attendee_id;

      insert into public.audit_log (
        actor_type, actor_id, group_id, event_id, attendee_id, action, details
      ) values (
        'admin', p_admin_id, attendee_row.group_id, attendee_row.event_id, p_attendee_id,
        'attendee.marked_paid_to_establishment',
        jsonb_build_object(
          'attendee_id', p_attendee_id,
          'full_name', attendee_row.full_name,
          'amount', paid_amount_value,
          'paid_at', paid_at_value
        )
      );
    else
      paid_at_value := attendee_row.establishment_paid_at;
      paid_amount_value := attendee_row.establishment_paid_amount;
    end if;

    return jsonb_build_object(
      'paid_to_establishment', true,
      'amount', paid_amount_value,
      'paid_at', paid_at_value
    );
  end if;

  if attendee_row.establishment_paid_at is not null then
    paid_at_value := attendee_row.establishment_paid_at;
    paid_amount_value := attendee_row.establishment_paid_amount;

    update public.attendees
    set establishment_paid_at = null,
        establishment_paid_amount = null,
        establishment_paid_by = null
    where id = p_attendee_id;

    insert into public.audit_log (
      actor_type, actor_id, group_id, event_id, attendee_id, action, details
    ) values (
      'admin', p_admin_id, attendee_row.group_id, attendee_row.event_id, p_attendee_id,
      'attendee.unmarked_paid_to_establishment',
      jsonb_build_object(
        'attendee_id', p_attendee_id,
        'full_name', attendee_row.full_name,
        'previous_amount', paid_amount_value,
        'previous_paid_at', paid_at_value
      )
    );
  end if;

  return jsonb_build_object('paid_to_establishment', false);
end;
$function$;

revoke all on function public.set_attendee_establishment_paid(uuid, uuid, boolean) from public;
revoke all on function public.set_attendee_establishment_paid(uuid, uuid, boolean) from anon;
revoke all on function public.set_attendee_establishment_paid(uuid, uuid, boolean) from authenticated;
grant execute on function public.set_attendee_establishment_paid(uuid, uuid, boolean) to service_role;
