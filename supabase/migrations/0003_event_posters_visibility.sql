alter table public.events
  add column if not exists is_published boolean not null default true,
  add column if not exists poster_url text null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-posters', 'event-posters', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view event posters" on storage.objects;
create policy "Public can view event posters" on storage.objects
  for select using (bucket_id = 'event-posters');

drop policy if exists "Admins with MFA can upload event posters" on storage.objects;
create policy "Admins with MFA can upload event posters" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'event-posters'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and auth.jwt() ->> 'aal' = 'aal2'
  );

drop policy if exists "Admins with MFA can update event posters" on storage.objects;
create policy "Admins with MFA can update event posters" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'event-posters'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and auth.jwt() ->> 'aal' = 'aal2'
  )
  with check (
    bucket_id = 'event-posters'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and auth.jwt() ->> 'aal' = 'aal2'
  );

drop policy if exists "Admins with MFA can delete event posters" on storage.objects;
create policy "Admins with MFA can delete event posters" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'event-posters'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and auth.jwt() ->> 'aal' = 'aal2'
  );
