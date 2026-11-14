
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://tbqokrqeznaxepxcjrvg.supabase.co', 'project_url', 'TicketBaxe hosted Supabase project URL');
  end if;
  if not exists (select 1 from vault.secrets where name = 'publishable_key') then
    perform vault.create_secret('sb_publishable_SgBI5XA9TELRTXuxji8gGg_TFMEW_uT', 'publishable_key', 'TicketBaxe public API key for scheduled Edge Function calls');
  end if;
end;
$$;

select cron.schedule(
  'ticketbaxe-close-due-events',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/close-due-events',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'publishable_key'),
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CRON_SECRET')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$
);
