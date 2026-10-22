create table if not exists public.expense_events (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  operation text not null check (operation in ('upsert', 'delete')),
  record_id text not null,
  record jsonb,
  updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint expense_events_record_shape check (
    (operation = 'delete' and record is null)
    or (operation = 'upsert' and record is not null)
  )
);

create index if not exists expense_events_created_at_idx
  on public.expense_events (created_at asc);

create index if not exists expense_events_record_id_idx
  on public.expense_events (record_id);

alter table public.expense_events enable row level security;

comment on table public.expense_events is
  'Server-only append-only expense ledger used by receipt and statement ingestion.';
