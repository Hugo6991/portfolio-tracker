create table if not exists public.portfolio_value_snapshots (
  id bigint generated always as identity primary key,
  bucket_at timestamptz not null,
  captured_at timestamptz not null,
  net_worth_usd numeric(20, 4) not null,
  exchanges_usd numeric(20, 4) not null,
  wallets_usd numeric(20, 4) not null,
  banks_usd numeric(20, 4) not null,
  is_partial boolean not null default false,
  source_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (bucket_at)
);

create index if not exists portfolio_value_snapshots_captured_at_idx
  on public.portfolio_value_snapshots (captured_at desc);

alter table public.portfolio_value_snapshots enable row level security;

comment on table public.portfolio_value_snapshots is
  'Compact hourly total-value history. Full daily and manual payloads remain in portfolio_snapshots.';

create or replace function public.upsert_portfolio_value_snapshot(
  p_bucket_at timestamptz,
  p_captured_at timestamptz,
  p_net_worth_usd numeric,
  p_exchanges_usd numeric,
  p_wallets_usd numeric,
  p_banks_usd numeric,
  p_is_partial boolean,
  p_source_count integer
)
returns void
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.portfolio_value_snapshots (
    bucket_at,
    captured_at,
    net_worth_usd,
    exchanges_usd,
    wallets_usd,
    banks_usd,
    is_partial,
    source_count
  ) values (
    p_bucket_at,
    p_captured_at,
    p_net_worth_usd,
    p_exchanges_usd,
    p_wallets_usd,
    p_banks_usd,
    p_is_partial,
    p_source_count
  )
  on conflict (bucket_at) do update set
    captured_at = excluded.captured_at,
    net_worth_usd = excluded.net_worth_usd,
    exchanges_usd = excluded.exchanges_usd,
    wallets_usd = excluded.wallets_usd,
    banks_usd = excluded.banks_usd,
    is_partial = excluded.is_partial,
    source_count = excluded.source_count
  where
    (
      public.portfolio_value_snapshots.is_partial = true and
      excluded.is_partial = false
    ) or (
      public.portfolio_value_snapshots.is_partial = excluded.is_partial and
      excluded.captured_at >= public.portfolio_value_snapshots.captured_at
    );
$$;

revoke all on function public.upsert_portfolio_value_snapshot(
  timestamptz,
  timestamptz,
  numeric,
  numeric,
  numeric,
  numeric,
  boolean,
  integer
) from public;
grant execute on function public.upsert_portfolio_value_snapshot(
  timestamptz,
  timestamptz,
  numeric,
  numeric,
  numeric,
  numeric,
  boolean,
  integer
) to service_role;

comment on function public.upsert_portfolio_value_snapshot(
  timestamptz,
  timestamptz,
  numeric,
  numeric,
  numeric,
  numeric,
  boolean,
  integer
) is 'Keeps the latest complete hourly point, or the latest partial point when no complete point exists.';

create or replace function public.read_portfolio_history(
  p_from timestamptz,
  p_interval text default 'daily'
)
returns table (
  captured_at timestamptz,
  net_worth_usd numeric,
  exchanges_usd numeric,
  wallets_usd numeric,
  banks_usd numeric,
  is_partial boolean,
  source_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (bucket_at)
    history.captured_at,
    history.net_worth_usd,
    history.exchanges_usd,
    history.wallets_usd,
    history.banks_usd,
    history.is_partial,
    history.source_count
  from (
    select
      combined.captured_at,
      combined.net_worth_usd,
      combined.exchanges_usd,
      combined.wallets_usd,
      combined.banks_usd,
      combined.is_partial,
      combined.source_count,
      case
        when p_interval = 'hourly'
          then date_trunc('hour', combined.captured_at at time zone 'Asia/Taipei')
        else date_trunc('day', combined.captured_at at time zone 'Asia/Taipei')
      end as bucket_at
    from (
      select
        compact.captured_at,
        compact.net_worth_usd,
        compact.exchanges_usd,
        compact.wallets_usd,
        compact.banks_usd,
        compact.is_partial,
        compact.source_count
      from public.portfolio_value_snapshots as compact
      where compact.captured_at >= p_from

      union all

      select
        snapshots.captured_at,
        snapshots.net_worth_usd,
        case
          when jsonb_typeof(snapshots.snapshot #> '{groups,exchangesUsd}') = 'number'
            then (snapshots.snapshot #>> '{groups,exchangesUsd}')::numeric
        end as exchanges_usd,
        case
          when jsonb_typeof(snapshots.snapshot #> '{groups,walletsUsd}') = 'number'
            then (snapshots.snapshot #>> '{groups,walletsUsd}')::numeric
        end as wallets_usd,
        case
          when jsonb_typeof(snapshots.snapshot #> '{groups,banksUsd}') = 'number'
            then (snapshots.snapshot #>> '{groups,banksUsd}')::numeric
        end as banks_usd,
        snapshots.is_partial,
        snapshots.source_count
      from public.portfolio_snapshots as snapshots
      where snapshots.captured_at >= p_from
    ) as combined
  ) as history
  where
    history.exchanges_usd is not null and
    history.wallets_usd is not null and
    history.banks_usd is not null
  order by bucket_at asc, history.is_partial asc, history.captured_at desc;
$$;

revoke all on function public.read_portfolio_history(timestamptz, text) from public;
grant execute on function public.read_portfolio_history(timestamptz, text) to service_role;

comment on function public.read_portfolio_history(timestamptz, text) is
  'Returns the latest real portfolio snapshot per Taipei day or hour without synthesizing missing buckets.';

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname in ('portfolio-full-sync-hourly', 'portfolio-value-sync-hourly')
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'portfolio-value-sync-hourly',
    '7 * * * *',
    $cron$
      select net.http_get(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_production_url') || '/api/cron/portfolio-value',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'portfolio_cron_secret')
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end $$;
