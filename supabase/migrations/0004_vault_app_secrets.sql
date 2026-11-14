
create or replace function public.get_app_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_value text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select ds.decrypted_secret into secret_value
  from vault.decrypted_secrets as ds
  where ds.name = p_name
  limit 1;
  if secret_value is null then
    raise exception 'secret not configured' using errcode = 'P0002';
  end if;
  return secret_value;
end;
$$;

revoke all on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'DNI_ENCRYPTION_KEY') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'DNI_ENCRYPTION_KEY', 'TicketBaxe AES-256-GCM document encryption key');
  end if;
  if not exists (select 1 from vault.secrets where name = 'DNI_HASH_SECRET') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'DNI_HASH_SECRET', 'TicketBaxe HMAC key for document duplicate detection');
  end if;
  if not exists (select 1 from vault.secrets where name = 'SESSION_HASH_SECRET') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'SESSION_HASH_SECRET', 'TicketBaxe HMAC key for portal sessions and IP rate limiting');
  end if;
  if not exists (select 1 from vault.secrets where name = 'CODE_HASH_SECRET') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'CODE_HASH_SECRET', 'TicketBaxe HMAC key for private group access codes');
  end if;
  if not exists (select 1 from vault.secrets where name = 'CRON_SECRET') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'CRON_SECRET', 'TicketBaxe scheduled event closure authorization');
  end if;
end;
$$;
