-- Record amounts already transferred from TicketBaxe to the event establishment.
-- Keep the amount as a snapshot so exceptional later price corrections produce a balance adjustment.
alter table public.attendees
  add column if not exists establishment_paid_at timestamptz,
  add column if not exists establishment_paid_amount numeric(10,2),
  add column if not exists establishment_paid_by uuid;

alter table public.attendees
  add constraint attendees_establishment_paid_amount_nonnegative
  check (establishment_paid_amount is null or establishment_paid_amount >= 0);

alter table public.attendees
  add constraint attendees_establishment_payment_consistent
  check (
    (establishment_paid_at is null and establishment_paid_amount is null and establishment_paid_by is null)
    or
    (establishment_paid_at is not null and establishment_paid_amount is not null and establishment_paid_by is not null)
  );

create index if not exists attendees_establishment_paid_event_idx
  on public.attendees (event_id, establishment_paid_at desc)
  where establishment_paid_at is not null;
