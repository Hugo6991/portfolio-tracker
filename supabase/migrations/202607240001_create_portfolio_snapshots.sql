create table if not exists public.portfolio_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null,
  net_worth_usd numeric(20, 4) not null,
  is_partial boolean not null default false,
  source_count integer not null default 0,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_snapshots_captured_at_idx
  on public.portfolio_snapshots (captured_at desc);

alter table public.portfolio_snapshots enable row level security;

comment on table public.portfolio_snapshots is
  'Server-only portfolio snapshots. Access is restricted to the Supabase service role.';
