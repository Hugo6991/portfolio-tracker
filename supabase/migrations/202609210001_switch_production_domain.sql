begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  v_production_url_id uuid;
  v_job_id bigint;
begin
  select secrets.id
  into v_production_url_id
  from vault.secrets as secrets
  where secrets.name = 'portfolio_production_url'
  order by secrets.updated_at desc
  limit 1;

  if v_production_url_id is null then
    raise exception 'Supabase Vault secret portfolio_production_url is required';
  end if;
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'portfolio_cron_secret'
      and nullif(trim(decrypted_secret), '') is not null
  ) then
    raise exception 'Supabase Vault secret portfolio_cron_secret is required';
  end if;

  perform vault.update_secret(
    v_production_url_id,
    'https://your-app.vercel.app',
    'portfolio_production_url',
    'Canonical Portfolio production URL used by database-owned sync jobs'
  );

  for v_job_id in
    select jobs.jobid
    from cron.job as jobs
    where
      jobs.jobname in (
        'portfolio-cex-sync-15m',
        'portfolio-current-sync-15m',
        'portfolio-full-sync-daily',
        'portfolio-full-sync-daily-retry'
      ) or
      jobs.command ilike '%/api/cron/cex%' or
      jobs.command ilike '%/api/cron/portfolio%'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'portfolio-cex-sync-15m',
    '*/15 * * * *',
    $cron$
      select net.http_get(
        url := rtrim(
          (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url'),
          '/'
        ) || '/api/cron/cex',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );

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
    '30 0 * * *',
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
