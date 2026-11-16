alter table public.events
  add column if not exists rrpp_name text;

comment on column public.events.rrpp_name is
  'Nombre público del RR.PP. asignado al evento, introducido y administrado por TicketBaxe admin.';
