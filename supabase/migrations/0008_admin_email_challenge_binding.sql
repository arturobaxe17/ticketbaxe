alter table public.admin_email_challenges
  add column if not exists password_session_id uuid;
