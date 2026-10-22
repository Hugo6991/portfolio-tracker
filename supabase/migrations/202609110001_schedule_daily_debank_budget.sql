begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  v_job_id bigint;
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'portfolio_cron_secret'
      and nullif(trim(decrypted_secret), '') is not null
  ) then
    raise exception 'Supabase Vault secret portfolio_cron_secret is required';
  end if;

  for v_job_id in
    select jobid
    from cron.job
    where jobname in ('portfolio-full-sync-daily', 'portfolio-full-sync-daily-retry')
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  -- 00:30 UTC = 08:30 Asia/Taipei. Normal days refresh wallet totals only;
  -- the first day of each month refreshes full token/protocol composition.
  -- The daily lease prevents duplicate delivery from rescanning DeBank.
  perform cron.schedule(
    'portfolio-full-sync-daily',
    '30 0 * * *',
    $cron$
      select net.http_get(
        url := 'https://your-old-app.vercel.app/api/cron/portfolio',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end $$;

commit;
