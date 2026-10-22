begin;

-- The verified-writer constraints are NOT VALID but still guard updates to
-- existing rows. Drop them inside this transaction, repair the known incident
-- window, then restore the exact same future-write fence before committing.
alter table public.portfolio_value_snapshots
  drop constraint if exists portfolio_value_snapshots_verified_writer_check;

alter table public.portfolio_snapshots
  drop constraint if exists portfolio_snapshots_verified_writer_check;

-- A transient DefiLlama misprice valued the BSC BINANCE DIAMOND contract as
-- native BNB beginning at 2026-09-11 14:28 UTC. Preserve the affected rows for
-- audit, but remove them from the verified history reader by degrading quality.
update public.portfolio_value_snapshots as snapshots
set
  is_partial = true,
  quality_status = 'degraded',
  quality = coalesce(snapshots.quality, '{}'::jsonb) || jsonb_build_object(
    'correctionReason', 'debank-unverified-token-misprice',
    'correctedAt', clock_timestamp()
  )
where
  snapshots.captured_at >= '2026-09-11T14:28:14.227Z'::timestamptz and
  snapshots.net_worth_usd >= 700000 and
  snapshots.wallets_usd >= 700000;

update public.portfolio_snapshots as snapshots
set
  is_partial = true,
  quality_status = 'degraded',
  quality = coalesce(snapshots.quality, '{}'::jsonb) || jsonb_build_object(
    'correctionReason', 'debank-unverified-token-misprice',
    'correctedAt', clock_timestamp()
  )
where
  snapshots.captured_at >= '2026-09-11T14:28:14.227Z'::timestamptz and
  snapshots.net_worth_usd >= 700000 and
  coalesce((snapshots.snapshot #>> '{groups,walletsUsd}')::numeric, 0) >= 700000;

alter table public.portfolio_value_snapshots
  add constraint portfolio_value_snapshots_verified_writer_check
  check (sync_run_id is not null and quality_status = 'complete') not valid;

alter table public.portfolio_snapshots
  add constraint portfolio_snapshots_verified_writer_check
  check (sync_run_id is not null and quality_status = 'complete') not valid;

commit;
