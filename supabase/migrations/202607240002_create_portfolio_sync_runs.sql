create table if not exists public.portfolio_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  trigger text not null check (trigger in ('cron', 'manual')),
  status text not null check (status in ('success', 'partial', 'skipped_degraded', 'failed')),
  duration_ms integer not null default 0,
  net_worth_usd numeric(20, 4),
  source_count integer not null default 0,
  error_count integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_sync_runs_started_at_idx
  on public.portfolio_sync_runs (started_at desc);

alter table public.portfolio_sync_runs enable row level security;

comment on table public.portfolio_sync_runs is
  'Server-only health log for scheduled and manual portfolio synchronization.';
