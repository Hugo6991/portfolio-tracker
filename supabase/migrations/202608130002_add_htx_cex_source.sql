alter table public.cex_snapshots
  drop constraint if exists cex_snapshots_exchange_check;

alter table public.cex_snapshots
  add constraint cex_snapshots_exchange_check
  check (exchange in ('binance', 'okx', 'bitget', 'htx'));
