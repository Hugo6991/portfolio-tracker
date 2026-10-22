create table if not exists public.cex_snapshots (
  id bigint generated always as identity primary key,
  exchange text not null check (exchange in ('binance', 'okx', 'bitget')),
  bucket_at timestamptz not null,
  captured_at timestamptz not null,
  status text not null check (status in ('live', 'partial', 'stale', 'error')),
  total_usd numeric(20, 4) not null default 0,
  item_count integer not null default 0,
  accounts jsonb not null default '[]'::jsonb,
  holdings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (exchange, bucket_at)
);

create index if not exists cex_snapshots_exchange_captured_at_idx
  on public.cex_snapshots (exchange, captured_at desc);

alter table public.cex_snapshots enable row level security;

comment on table public.cex_snapshots is
  'Server-only, permanent 15-minute CEX holdings snapshots. Access is restricted to the Supabase service role.';

create table if not exists public.cex_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  status text not null check (status in ('success', 'partial', 'failed')),
  duration_ms integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cex_sync_runs_started_at_idx
  on public.cex_sync_runs (started_at desc);

alter table public.cex_sync_runs enable row level security;

comment on table public.cex_sync_runs is
  'Server-only health log for 15-minute CEX synchronization.';
