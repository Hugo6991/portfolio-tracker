begin;

-- A main-branch deployment on 2026-09-04 restored the pre-reconciliation Gate
-- adapter. Those rows contain only gate-spot even though the Finance account
-- remained funded. Keep the raw rows, but mark the affected window incomplete
-- so it cannot be interpreted as a real portfolio loss.
do $$
declare
  v_bad_start constant timestamptz := '2026-09-04T09:45:00Z';
  v_recovered_at timestamptz;
begin
  select min(snapshots.captured_at)
  into v_recovered_at
  from public.cex_snapshots as snapshots
  where
    snapshots.exchange = 'gate' and
    snapshots.captured_at >= v_bad_start and
    snapshots.status = 'live' and
    (
      exists (
        select 1
        from jsonb_array_elements(coalesce(snapshots.accounts, '[]'::jsonb)) as account
        where account ->> 'id' <> 'gate-spot'
      ) or
      exists (
        select 1
        from jsonb_array_elements(coalesce(snapshots.holdings, '[]'::jsonb)) as holding
        where holding ->> 'symbol' = 'GATE-ESTIMATE'
      )
    );

  v_recovered_at := coalesce(v_recovered_at, clock_timestamp());

  update public.cex_snapshots as snapshots
  set status = 'partial'
  where
    snapshots.exchange = 'gate' and
    snapshots.captured_at >= v_bad_start and
    snapshots.captured_at < v_recovered_at and
    snapshots.status = 'live' and
    jsonb_array_length(coalesce(snapshots.accounts, '[]'::jsonb)) = 1 and
    snapshots.accounts -> 0 ->> 'id' = 'gate-spot' and
    not exists (
      select 1
      from jsonb_array_elements(coalesce(snapshots.holdings, '[]'::jsonb)) as holding
      where holding ->> 'symbol' = 'GATE-ESTIMATE'
    );

  update public.portfolio_value_snapshots as snapshots
  set
    is_partial = true,
    quality_status = 'degraded',
    quality = coalesce(snapshots.quality, '{}'::jsonb) || jsonb_build_object(
      'correctionReason', 'gate-spot-only',
      'correctedAt', clock_timestamp()
    )
  where snapshots.captured_at >= v_bad_start and snapshots.captured_at < v_recovered_at;

  update public.portfolio_snapshots as snapshots
  set
    is_partial = true,
    quality_status = 'degraded',
    quality = coalesce(snapshots.quality, '{}'::jsonb) || jsonb_build_object(
      'correctionReason', case
        when snapshots.source_count < 7 then 'legacy-five-source-writer'
        else 'gate-spot-only'
      end,
      'correctedAt', clock_timestamp()
    )
  where snapshots.captured_at >= v_bad_start and snapshots.captured_at < v_recovered_at;
end $$;

-- New code writes both history tables only through finish_portfolio_sync_v2.
-- NOT VALID preserves the old audit rows while still rejecting future writes
-- from deployments that predate the fenced writer.
alter table public.portfolio_snapshots
  drop constraint if exists portfolio_snapshots_verified_writer_check;

alter table public.portfolio_snapshots
  add constraint portfolio_snapshots_verified_writer_check
  check (sync_run_id is not null and quality_status = 'complete') not valid;

alter table public.portfolio_value_snapshots
  drop constraint if exists portfolio_value_snapshots_verified_writer_check;

alter table public.portfolio_value_snapshots
  add constraint portfolio_value_snapshots_verified_writer_check
  check (sync_run_id is not null and quality_status = 'complete') not valid;

-- Once the fenced writer has produced its first verified row, later legacy rows
-- are audit-only. They must not outrank verified compact/full snapshots in the
-- public chart merely because they were captured later in the same bucket.
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
  with verified_cutover as (
    select min(rows.captured_at) as captured_at
    from (
      select compact.captured_at
      from public.portfolio_value_snapshots as compact
      where compact.sync_run_id is not null and compact.quality_status = 'complete'
      union all
      select snapshots.captured_at
      from public.portfolio_snapshots as snapshots
      where snapshots.sync_run_id is not null and snapshots.quality_status = 'complete'
    ) as rows
  )
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
      cross join verified_cutover
      where
        compact.captured_at >= p_from and
        (
          (compact.sync_run_id is not null and compact.quality_status = 'complete') or
          compact.captured_at < coalesce(verified_cutover.captured_at, 'infinity'::timestamptz)
        )

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
      cross join verified_cutover
      where
        snapshots.captured_at >= p_from and
        (
          (snapshots.sync_run_id is not null and snapshots.quality_status = 'complete') or
          snapshots.captured_at < coalesce(verified_cutover.captured_at, 'infinity'::timestamptz)
        )
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
  'Returns verified portfolio history after the fenced-writer cutover and preserves only pre-cutover legacy history.';

notify pgrst, 'reload schema';

commit;
