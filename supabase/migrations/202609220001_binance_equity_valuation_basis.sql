begin;
alter table public.cex_snapshots add column if not exists pricing_basis text;
comment on column public.cex_snapshots.pricing_basis is
  'Valuation methodology identifier; NULL denotes historical pricing. No historical backfill.';
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
    writer_version,
    pricing_basis
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
    'cex-rpc-v2',
    p_snapshot ->> 'pricing_basis'
  )
  on conflict (exchange, bucket_at) do update set
    captured_at = excluded.captured_at,
    status = excluded.status,
    total_usd = excluded.total_usd,
    item_count = excluded.item_count,
    accounts = excluded.accounts,
    holdings = excluded.holdings,
    errors = excluded.errors,
    writer_version = excluded.writer_version,
    pricing_basis = excluded.pricing_basis
  where excluded.captured_at >= public.cex_snapshots.captured_at;

  get diagnostics v_row_count = row_count;
  return v_row_count = 1;
end;
$$;

create or replace function public.read_portfolio_history_v2(
  p_from timestamptz, p_interval text, p_valuation_basis text
)
returns table (captured_at timestamptz, net_worth_usd numeric,
  exchanges_usd numeric, wallets_usd numeric, banks_usd numeric,
  is_partial boolean, source_count integer)
language sql stable security invoker set search_path = public as $$
  with combined as (
    select c.captured_at, c.net_worth_usd, c.exchanges_usd, c.wallets_usd,
      c.banks_usd, c.is_partial, c.source_count
    from public.portfolio_value_snapshots c
    where c.captured_at >= p_from and c.sync_run_id is not null
      and c.quality_status = 'complete' and not c.is_partial
      and c.quality->>'valuationBasis' = p_valuation_basis
    union all
    select s.captured_at, s.net_worth_usd,
      (s.snapshot #>> '{groups,exchangesUsd}')::numeric,
      (s.snapshot #>> '{groups,walletsUsd}')::numeric,
      (s.snapshot #>> '{groups,banksUsd}')::numeric,
      s.is_partial, s.source_count
    from public.portfolio_snapshots s
    where s.captured_at >= p_from and s.sync_run_id is not null
      and s.quality_status = 'complete' and not s.is_partial
      and s.quality->>'valuationBasis' = p_valuation_basis
  ), bucketed as (
    select *, date_trunc(case when p_interval = 'hourly' then 'hour' else 'day' end,
      combined.captured_at at time zone 'Asia/Taipei') as bucket from combined
  )
  select distinct on (b.bucket) b.captured_at, b.net_worth_usd, b.exchanges_usd,
    b.wallets_usd, b.banks_usd, b.is_partial, b.source_count
  from bucketed b
  where b.exchanges_usd is not null and b.wallets_usd is not null and b.banks_usd is not null
  order by b.bucket, b.captured_at desc;
$$;

create or replace function public.read_portfolio_chart_snapshots_v2(
  p_from timestamptz, p_view text, p_valuation_basis text
)
returns table (captured_at timestamptz, net_worth_usd numeric,
  is_partial boolean, source_count integer, snapshot jsonb)
language sql stable security invoker set search_path = public as $$
  select distinct on ((s.captured_at at time zone 'Asia/Taipei')::date)
    s.captured_at, s.net_worth_usd, s.is_partial, s.source_count,
    jsonb_build_object(
      'valuationBasis', s.quality->'valuationBasis',
      'liveValueUsd', s.snapshot->'liveValueUsd',
      'groups', s.snapshot->'groups', 'sources', s.snapshot->'sources',
      'holdings', s.snapshot->'holdings', 'wallets', '[]'::jsonb)
  from public.portfolio_snapshots s
  where s.captured_at >= p_from and p_view = 'assets'
    and s.sync_run_id is not null and s.quality_status = 'complete'
    and not s.is_partial and s.quality->>'valuationBasis' = p_valuation_basis
  order by (s.captured_at at time zone 'Asia/Taipei')::date, s.captured_at desc;
$$;

revoke all on function public.upsert_cex_snapshot_v2(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_cex_snapshot_v2(jsonb) to service_role;
revoke all on function public.read_portfolio_history_v2(timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.read_portfolio_chart_snapshots_v2(timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.read_portfolio_history_v2(timestamptz,text,text) to service_role;
grant execute on function public.read_portfolio_chart_snapshots_v2(timestamptz,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
