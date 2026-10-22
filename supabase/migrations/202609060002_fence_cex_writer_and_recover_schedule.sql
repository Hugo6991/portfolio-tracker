begin;

-- Direct PostgREST upserts let any still-running deployment reuse the shared
-- service-role key and overwrite a newer CEX bucket. New deployments write
-- through this audited security-definer function; direct table mutations are
-- revoked below so old code fails closed.
alter table public.cex_snapshots
  add column if not exists writer_version text;

update public.cex_snapshots as snapshots
set
  status = 'partial',
  writer_version = coalesce(snapshots.writer_version, 'legacy-spot-only'),
  errors = coalesce(snapshots.errors, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'accountType', 'Coverage',
      'message', 'Legacy Gate Spot-only snapshot quarantined'
    )
  )
where
  snapshots.exchange = 'gate' and
  snapshots.captured_at >= '2026-09-04T09:45:00Z' and
  snapshots.status = 'live' and
  jsonb_array_length(coalesce(snapshots.accounts, '[]'::jsonb)) = 1 and
  snapshots.accounts -> 0 ->> 'id' = 'gate-spot' and
  not exists (
    select 1
    from jsonb_array_elements(coalesce(snapshots.holdings, '[]'::jsonb)) as holding
    where holding ->> 'symbol' = 'GATE-ESTIMATE'
  );

alter table public.cex_snapshots
  drop constraint if exists cex_snapshots_verified_writer_check;

alter table public.cex_snapshots
  add constraint cex_snapshots_verified_writer_check
  check (writer_version = 'cex-rpc-v2') not valid;

create or replace function public.upsert_cex_snapshot_v2(p_snapshot jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_exchange text;
  v_bucket_at timestamptz;
  v_captured_at timestamptz;
  v_status text;
  v_total_usd numeric;
  v_item_count integer;
  v_accounts jsonb;
  v_holdings jsonb;
  v_errors jsonb;
  v_row_count integer;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'CEX snapshot must be a JSON object' using errcode = '22023';
  end if;

  begin
    v_exchange := p_snapshot ->> 'exchange';
    v_bucket_at := (p_snapshot ->> 'bucket_at')::timestamptz;
    v_captured_at := (p_snapshot ->> 'captured_at')::timestamptz;
    v_status := p_snapshot ->> 'status';
    v_total_usd := (p_snapshot ->> 'total_usd')::numeric;
    v_item_count := (p_snapshot ->> 'item_count')::integer;
    v_accounts := p_snapshot -> 'accounts';
    v_holdings := p_snapshot -> 'holdings';
    v_errors := p_snapshot -> 'errors';
  exception when others then
    raise exception 'CEX snapshot fields are invalid' using errcode = '22023';
  end;

  if v_exchange not in ('binance', 'okx', 'bitget', 'htx', 'gate') then
    raise exception 'Unsupported CEX exchange' using errcode = '22023';
  end if;
  if v_status not in ('live', 'partial', 'stale', 'error') then
    raise exception 'Unsupported CEX status' using errcode = '22023';
  end if;
  if v_bucket_at is null or v_captured_at is null or
     v_bucket_at <> to_timestamp(floor(extract(epoch from v_captured_at) / 900) * 900) then
    raise exception 'CEX bucket does not match captured time' using errcode = '22023';
  end if;
  if v_total_usd is null or v_total_usd < 0 or v_item_count is null or v_item_count < 0 then
    raise exception 'CEX totals are invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(v_accounts) is distinct from 'array' or
     jsonb_typeof(v_holdings) is distinct from 'array' or
     jsonb_typeof(v_errors) is distinct from 'array' then
    raise exception 'CEX account, holding, and error fields must be arrays' using errcode = '22023';
  end if;

  insert into public.cex_snapshots (
    exchange,
    bucket_at,
    captured_at,
    status,
    total_usd,
    item_count,
    accounts,
    holdings,
    errors,
    writer_version
  ) values (
    v_exchange,
    v_bucket_at,
    v_captured_at,
    v_status,
    v_total_usd,
    v_item_count,
    v_accounts,
    v_holdings,
    v_errors,
    'cex-rpc-v2'
  )
  on conflict (exchange, bucket_at) do update set
    captured_at = excluded.captured_at,
    status = excluded.status,
    total_usd = excluded.total_usd,
    item_count = excluded.item_count,
    accounts = excluded.accounts,
    holdings = excluded.holdings,
    errors = excluded.errors,
    writer_version = excluded.writer_version
  where excluded.captured_at >= public.cex_snapshots.captured_at;

  get diagnostics v_row_count = row_count;
  return v_row_count = 1;
end;
$$;

revoke all on function public.upsert_cex_snapshot_v2(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_cex_snapshot_v2(jsonb) to service_role;

revoke insert, update, delete, truncate
  on table public.cex_snapshots
  from anon, authenticated, service_role;

comment on column public.cex_snapshots.writer_version is
  'Identifies snapshots written through the fenced CEX writer.';

comment on function public.upsert_cex_snapshot_v2(jsonb) is
  'Validates and upserts one CEX snapshot while rejecting stale writes. Direct table writes are revoked.';

-- The Vault URL had drifted to an old immutable Vercel deployment. Point every
-- aggregate job back at the canonical alias and remove any duplicate job whose
-- command still references a cron endpoint.
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
    where name = 'portfolio_cron_secret' and nullif(trim(decrypted_secret), '') is not null
  ) then
    raise exception 'Supabase Vault secret portfolio_cron_secret is required';
  end if;

  perform vault.update_secret(
    v_production_url_id,
    'https://your-old-app.vercel.app',
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
        url := 'https://your-old-app.vercel.app/api/cron/cex',
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
        url := 'https://your-old-app.vercel.app/api/cron/portfolio-value',
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
        url := 'https://your-old-app.vercel.app/api/cron/portfolio',
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
        url := 'https://your-old-app.vercel.app/api/cron/portfolio',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end $$;

notify pgrst, 'reload schema';

commit;
