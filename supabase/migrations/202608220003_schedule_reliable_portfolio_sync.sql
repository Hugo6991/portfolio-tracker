begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'portfolio_production_url' and nullif(trim(decrypted_secret), '') is not null
  ) then
    raise exception 'Supabase Vault secret portfolio_production_url is required';
  end if;
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'portfolio_cron_secret' and nullif(trim(decrypted_secret), '') is not null
  ) then
    raise exception 'Supabase Vault secret portfolio_cron_secret is required';
  end if;

  for existing_job_id in
    select jobid
    from cron.job
    where jobname in (
      'portfolio-full-sync-hourly',
      'portfolio-full-sync-daily',
      'portfolio-full-sync-daily-retry',
      'portfolio-value-sync-hourly',
      'portfolio-current-sync-15m'
    )
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'portfolio-current-sync-15m',
    '7,22,37,52 * * * *',
    $cron$
      select net.http_get(
        url := rtrim(
          (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url'),
          '/'
        ) || '/api/cron/portfolio-value',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );

  perform cron.schedule(
    'portfolio-full-sync-daily',
    '12 1 * * *',
    $cron$
      select net.http_get(
        url := rtrim(
          (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url'),
          '/'
        ) || '/api/cron/portfolio',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );

  perform cron.schedule(
    'portfolio-full-sync-daily-retry',
    '42 1 * * *',
    $cron$
      select net.http_get(
        url := rtrim(
          (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url'),
          '/'
        ) || '/api/cron/portfolio',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end $$;

commit;
