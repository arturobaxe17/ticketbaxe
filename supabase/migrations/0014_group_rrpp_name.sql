alter table public.groups
  add column if not exists rrpp_name text;

comment on column public.groups.rrpp_name is
  'Nombre del RR.PP. asignado a este grupo. Lo gestiona administración y lo ve el grupo al acceder con su código NAV.';
