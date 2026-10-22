begin;

-- Preserve the full snapshots for audit. Charts receive only the latest trusted
-- record per Taipei day, with fields required by the existing quality rules.
create or replace function public.read_portfolio_chart_snapshots(
  p_from timestamptz,
  p_view text
)
returns table (
  captured_at timestamptz,
  net_worth_usd numeric,
  is_partial boolean,
  source_count integer,
  snapshot jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with cutover as (
    select min(s.captured_at) as captured_at
    from public.portfolio_snapshots s
    where s.sync_run_id is not null and s.quality_status = 'complete'
  ), daily as (
    select distinct on ((s.captured_at at time zone 'Asia/Taipei')::date)
      s.captured_at, s.net_worth_usd, s.is_partial, s.source_count, s.snapshot
    from public.portfolio_snapshots s
    cross join cutover
    where s.captured_at >= p_from
      and p_view in ('wallets', 'assets')
      and (
        (s.sync_run_id is not null and s.quality_status = 'complete')
        or (s.sync_run_id is null and s.quality_status is null
          and s.captured_at < coalesce(cutover.captured_at, 'infinity'::timestamptz))
      )
    order by (s.captured_at at time zone 'Asia/Taipei')::date, s.captured_at desc
  )
  select d.captured_at, d.net_worth_usd, d.is_partial, d.source_count,
    jsonb_build_object(
      'liveValueUsd', d.snapshot->'liveValueUsd',
      'groups', d.snapshot->'groups',
      'sources', d.snapshot->'sources',
      'holdings', case when p_view = 'assets' then d.snapshot->'holdings' else '[]'::jsonb end,
      'wallets', case when p_view = 'wallets' then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', wallet->'id', 'name', wallet->'name', 'address', wallet->'address',
          'valueUsd', wallet->'valueUsd', 'debankValueUsd', wallet->'debankValueUsd',
          'hyperliquidValueUsd', wallet->'hyperliquidValueUsd', 'status', wallet->'status'
        )), '[]'::jsonb)
        from jsonb_array_elements(case
          when jsonb_typeof(d.snapshot->'wallets') = 'array' then d.snapshot->'wallets'
          else '[]'::jsonb end) wallet
      ) else '[]'::jsonb end
    ) as snapshot
  from daily d
  order by d.captured_at;
$$;

revoke all on function public.read_portfolio_chart_snapshots(timestamptz, text) from public;
grant execute on function public.read_portfolio_chart_snapshots(timestamptz, text) to service_role;

comment on function public.read_portfolio_chart_snapshots(timestamptz, text) is
  'Compact daily chart input; preserves trusted cutover, missing wallet membership and source quality without token/position payloads.';

notify pgrst, 'reload schema';
commit;
