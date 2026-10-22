begin;
-- Legacy snapshots predate sync run IDs. Keep their reconstruction separate.
create table public.portfolio_legacy_history_corrections (
  captured_at timestamptz primary key,
  net_worth_usd numeric not null check (net_worth_usd > 0),
  exchanges_usd numeric not null,
  wallets_usd numeric not null,
  banks_usd numeric not null,
  source_count integer not null,
  valuation_basis text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  check (abs(net_worth_usd-exchanges_usd-wallets_usd-banks_usd)<0.05)
);
alter table public.portfolio_legacy_history_corrections enable row level security;
revoke all on public.portfolio_legacy_history_corrections from public,anon,authenticated;
grant select on public.portfolio_legacy_history_corrections to service_role;

create or replace function public.read_portfolio_display_history_v1(p_from timestamptz,p_interval text)
returns table (captured_at timestamptz,net_worth_usd numeric,exchanges_usd numeric,
  wallets_usd numeric,banks_usd numeric,is_partial boolean,source_count integer,
  valuation_basis text,estimated boolean)
language sql stable security invoker set search_path = public as $$
  with observations as (
    select c.captured_at,c.net_worth_usd,c.exchanges_usd,c.wallets_usd,c.banks_usd,
      c.is_partial,c.source_count,coalesce(c.quality->>'valuationBasis','legacy') as valuation_basis,false as estimated
    from portfolio_value_snapshots c
    where c.captured_at>=p_from and c.sync_run_id is not null
      and c.quality_status='complete' and not c.is_partial
    union all
    select s.captured_at,s.net_worth_usd,
      (s.snapshot#>>'{groups,exchangesUsd}')::numeric,(s.snapshot#>>'{groups,walletsUsd}')::numeric,
      (s.snapshot#>>'{groups,banksUsd}')::numeric,s.is_partial,s.source_count,
      coalesce(s.quality->>'valuationBasis','legacy'),false
    from portfolio_snapshots s
    where s.captured_at>=p_from and s.sync_run_id is not null
      and s.quality_status='complete' and not s.is_partial
    union all
    select c.captured_at,c.net_worth_usd,c.exchanges_usd,c.wallets_usd,c.banks_usd,
      false,c.source_count,c.valuation_basis,true
    from portfolio_history_corrections c where c.captured_at>=p_from
      and not exists(select 1 from portfolio_value_snapshots v where v.sync_run_id=c.sync_run_id)
    union all
    select c.captured_at,c.net_worth_usd,c.exchanges_usd,c.wallets_usd,c.banks_usd,
      false,c.source_count,c.valuation_basis,true
    from portfolio_legacy_history_corrections c where c.captured_at>=p_from
      and not exists(select 1 from portfolio_snapshots s where s.captured_at=c.captured_at
        and s.quality_status='complete' and not s.is_partial and s.sync_run_id is not null)
  ), bucketed as (
    select *,date_trunc(case when p_interval='hourly' then 'hour' else 'day' end,
      o.captured_at at time zone 'Asia/Taipei') as bucket from observations o
  )
  select distinct on(b.bucket) b.captured_at,b.net_worth_usd,b.exchanges_usd,b.wallets_usd,
    b.banks_usd,b.is_partial,b.source_count,b.valuation_basis,b.estimated
  from bucketed b where b.exchanges_usd is not null and b.wallets_usd is not null and b.banks_usd is not null
  order by b.bucket,b.captured_at desc,b.estimated;
$$;
revoke all on function public.read_portfolio_display_history_v1(timestamptz,text) from public,anon,authenticated;
grant execute on function public.read_portfolio_display_history_v1(timestamptz,text) to service_role;
notify pgrst,'reload schema';
commit;
