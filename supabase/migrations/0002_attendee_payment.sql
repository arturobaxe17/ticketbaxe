alter table public.attendees
  add column if not exists paid boolean not null default false;

comment on column public.attendees.paid is
  'Payment status managed only by administrators; visible to the attendee group portal.';
