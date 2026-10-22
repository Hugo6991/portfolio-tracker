create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id from cron.job where jobname = 'portfolio-cex-sync-15m';
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'portfolio-cex-sync-15m',
    '*/15 * * * *',
    $cron$
      select net.http_get(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url') || '/api/cron/cex',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end $$;
