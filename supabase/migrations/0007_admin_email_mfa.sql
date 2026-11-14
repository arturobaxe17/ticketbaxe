-- Private state for the administrator's password + email-code sign-in.
create table if not exists public.admin_email_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  challenge_hash text not null unique,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 5),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_email_challenges_user_created_idx
  on public.admin_email_challenges (user_id, created_at desc);

create table if not exists public.admin_email_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_email_sessions_user_expires_idx
  on public.admin_email_sessions (user_id, expires_at desc);

alter table public.admin_email_challenges enable row level security;
alter table public.admin_email_sessions enable row level security;

revoke all on public.admin_email_challenges from public, anon, authenticated;
revoke all on public.admin_email_sessions from public, anon, authenticated;
grant all on public.admin_email_challenges to service_role;
grant all on public.admin_email_sessions to service_role;
