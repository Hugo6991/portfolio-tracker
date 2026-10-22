begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.portfolio_sync_runs
  alter column completed_at drop not null;

alter table public.portfolio_sync_runs
  drop constraint if exists portfolio_sync_runs_status_check;

alter table public.portfolio_sync_runs
  add constraint portfolio_sync_runs_status_check
  check (status in (
    'running',
    'success',
    'partial',
    'skipped_degraded',
    'failed',
    'abandoned'
  ));

alter table public.portfolio_sync_runs
  add column if not exists job_key text,
  add column if not exists sync_kind text,
  add column if not exists lease_key text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt integer not null default 1;

alter table public.portfolio_sync_runs
  drop constraint if exists portfolio_sync_runs_sync_kind_check;

alter table public.portfolio_sync_runs
  add constraint portfolio_sync_runs_sync_kind_check
  check (sync_kind is null or sync_kind in ('full', 'value'));

alter table public.portfolio_sync_runs
  drop constraint if exists portfolio_sync_runs_attempt_check;

alter table public.portfolio_sync_runs
  add constraint portfolio_sync_runs_attempt_check
  check (attempt >= 1);

create unique index if not exists portfolio_sync_runs_job_attempt_idx
  on public.portfolio_sync_runs (job_key, attempt)
  where job_key is not null;

create unique index if not exists portfolio_sync_runs_running_lease_idx
  on public.portfolio_sync_runs (lease_key)
  where status = 'running' and lease_key is not null;

create table if not exists public.portfolio_current (
  id boolean primary key default true check (id),
  captured_at timestamptz not null,
  net_worth_usd numeric(20, 4) not null,
  is_partial boolean not null default false,
  source_count integer not null default 0,
  sync_run_id bigint references public.portfolio_sync_runs(id),
  quality_status text not null default 'complete'
    check (quality_status in ('complete', 'degraded', 'bootstrap', 'rejected')),
  quality jsonb not null default '{}'::jsonb,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_current enable row level security;

comment on table public.portfolio_current is
  'Singleton last-known-good aggregate read by the dashboard. Sync attempts replace it only after quality checks pass.';

insert into public.portfolio_current (
  id,
  captured_at,
  net_worth_usd,
  is_partial,
  source_count,
  quality_status,
  quality,
  snapshot
)
select
  true,
  snapshots.captured_at,
  snapshots.net_worth_usd,
  snapshots.is_partial,
  snapshots.source_count,
  case when snapshots.is_partial then 'degraded' else 'complete' end,
  jsonb_build_object('seededFrom', 'portfolio_snapshots'),
  snapshots.snapshot
from public.portfolio_snapshots as snapshots
where
  snapshots.is_partial = false and
  snapshots.net_worth_usd > 0 and
  snapshots.source_count > 0 and
  case
    when jsonb_typeof(snapshots.snapshot -> 'errors') = 'array'
      then jsonb_array_length(snapshots.snapshot -> 'errors') = 0
    else false
  end and
  case
    when jsonb_typeof(snapshots.snapshot -> 'sources') = 'array'
      then jsonb_array_length(snapshots.snapshot -> 'sources') > 0
    else false
  end and
  not exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(snapshots.snapshot -> 'sources') = 'array'
          then snapshots.snapshot -> 'sources'
        else '[]'::jsonb
      end
    ) as source
    where
      nullif(source ->> 'id', '') is null or
      coalesce(source ->> 'kind', '') not in ('exchange', 'wallet', 'bank') or
      (
        source ->> 'kind' = 'bank' and
        coalesce(source ->> 'status', '') not in ('preview', 'live')
      ) or
      (
        source ->> 'kind' in ('exchange', 'wallet') and
        coalesce(source ->> 'status', '') <> 'live'
      )
  )
order by snapshots.captured_at desc
limit 1
on conflict (id) do nothing;

create table if not exists public.portfolio_source_state (
  source_id text primary key,
  source_name text not null,
  source_kind text not null check (source_kind in ('exchange', 'wallet', 'bank')),
  last_good_status text check (last_good_status is null or last_good_status in ('live', 'preview')),
  last_good_payload jsonb,
  last_good_at timestamptz,
  last_good_value_usd numeric(20, 4),
  last_good_item_count integer,
  last_attempt_at timestamptz not null,
  last_attempt_status text not null check (last_attempt_status in ('live', 'partial', 'preview', 'error')),
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  sync_run_id bigint references public.portfolio_sync_runs(id),
  updated_at timestamptz not null default now()
);

alter table public.portfolio_source_state enable row level security;

comment on table public.portfolio_source_state is
  'Materialized per-source last-known-good state plus the latest attempt outcome. Failed attempts never clear the good payload.';

alter table public.portfolio_snapshots
  add column if not exists sync_run_id bigint references public.portfolio_sync_runs(id),
  add column if not exists quality_status text,
  add column if not exists quality jsonb not null default '{}'::jsonb;

alter table public.portfolio_snapshots
  drop constraint if exists portfolio_snapshots_quality_status_check;

alter table public.portfolio_snapshots
  add constraint portfolio_snapshots_quality_status_check
  check (quality_status is null or quality_status in ('complete', 'degraded', 'bootstrap', 'rejected'));

alter table public.portfolio_value_snapshots
  add column if not exists sync_run_id bigint references public.portfolio_sync_runs(id),
  add column if not exists quality_status text,
  add column if not exists quality jsonb not null default '{}'::jsonb;

alter table public.portfolio_value_snapshots
  drop constraint if exists portfolio_value_snapshots_quality_status_check;

alter table public.portfolio_value_snapshots
  add constraint portfolio_value_snapshots_quality_status_check
  check (quality_status is null or quality_status in ('complete', 'degraded', 'bootstrap', 'rejected'));

create or replace function public.claim_portfolio_sync_v2(
  p_job_key text,
  p_sync_kind text,
  p_trigger text,
  p_started_at timestamptz,
  p_lease_seconds integer default 180
)
returns table (
  claimed boolean,
  run_id bigint,
  lease_token uuid,
  reason text
)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_lease_key constant text := 'portfolio:aggregate';
  v_attempt integer;
begin
  if p_job_key is null or length(trim(p_job_key)) = 0 then
    raise exception 'job key is required';
  end if;
  if p_sync_kind not in ('full', 'value') then
    raise exception 'invalid sync kind';
  end if;
  if p_trigger not in ('cron', 'manual') then
    raise exception 'invalid sync trigger';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_lease_key));

  update public.portfolio_sync_runs
  set
    completed_at = clock_timestamp(),
    status = 'abandoned',
    duration_ms = least(
      2147483647::numeric,
      greatest(
        0::numeric,
        floor(extract(epoch from (clock_timestamp() - started_at)) * 1000)
      )
    )::integer,
    error_count = greatest(error_count, 1),
    detail = detail || jsonb_build_object('reason', 'lease_expired')
  where
    lease_key = v_lease_key and
    status = 'running' and
    lease_expires_at <= clock_timestamp();

  if exists (
    select 1
    from public.portfolio_sync_runs
    where job_key = p_job_key and status = 'success'
  ) then
    claimed := false;
    run_id := null;
    lease_token := null;
    reason := 'already_completed';
    return next;
    return;
  end if;

  select runs.id, runs.lease_token
  into run_id, lease_token
  from public.portfolio_sync_runs as runs
  where
    runs.lease_key = v_lease_key and
    runs.status = 'running' and
    runs.lease_expires_at > clock_timestamp()
  order by runs.started_at desc
  limit 1;

  if run_id is not null then
    claimed := false;
    reason := 'already_running';
    return next;
    return;
  end if;

  select coalesce(max(runs.attempt), 0) + 1
  into v_attempt
  from public.portfolio_sync_runs as runs
  where runs.job_key = p_job_key;

  lease_token := extensions.gen_random_uuid();
  insert into public.portfolio_sync_runs (
    started_at,
    completed_at,
    trigger,
    status,
    duration_ms,
    net_worth_usd,
    source_count,
    error_count,
    detail,
    job_key,
    sync_kind,
    lease_key,
    lease_token,
    lease_expires_at,
    attempt
  ) values (
    p_started_at,
    null,
    p_trigger,
    'running',
    0,
    null,
    0,
    0,
    jsonb_build_object('mode', p_sync_kind),
    p_job_key,
    p_sync_kind,
    v_lease_key,
    lease_token,
    clock_timestamp() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
    v_attempt
  )
  returning id into run_id;

  claimed := true;
  reason := 'claimed';
  return next;
end;
$$;

revoke all on function public.claim_portfolio_sync_v2(text, text, text, timestamptz, integer) from public;
grant execute on function public.claim_portfolio_sync_v2(text, text, text, timestamptz, integer) to service_role;

create or replace function public.finish_portfolio_sync_v2(
  p_run_id bigint,
  p_lease_token uuid,
  p_completed_at timestamptz,
  p_status text,
  p_duration_ms integer,
  p_net_worth_usd numeric,
  p_source_count integer,
  p_error_count integer,
  p_detail jsonb,
  p_snapshot jsonb,
  p_quality_status text,
  p_publish_current boolean,
  p_write_value boolean,
  p_write_full boolean
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_run public.portfolio_sync_runs%rowtype;
  v_source jsonb;
  v_source_status text;
  v_captured_at timestamptz;
  v_bucket_at timestamptz;
begin
  if p_status not in ('success', 'partial', 'skipped_degraded', 'failed') then
    raise exception 'invalid final sync status';
  end if;
  if p_quality_status not in ('complete', 'degraded', 'bootstrap', 'rejected') then
    raise exception 'invalid quality status';
  end if;

  select *
  into v_run
  from public.portfolio_sync_runs
  where
    id = p_run_id and
    lease_token = p_lease_token and
    status = 'running' and
    lease_expires_at > clock_timestamp()
  for update;

  if not found then
    return false;
  end if;

  if p_snapshot is not null and jsonb_typeof(p_snapshot -> 'sources') = 'array' then
    for v_source in
      select value from jsonb_array_elements(p_snapshot -> 'sources')
    loop
      v_source_status := v_source ->> 'status';
      if coalesce(v_source ->> 'id', '') <> '' and
         v_source_status in ('live', 'partial', 'preview', 'error') then
        insert into public.portfolio_source_state (
          source_id,
          source_name,
          source_kind,
          last_good_status,
          last_good_payload,
          last_good_at,
          last_good_value_usd,
          last_good_item_count,
          last_attempt_at,
          last_attempt_status,
          last_error,
          consecutive_failures,
          sync_run_id,
          updated_at
        ) values (
          v_source ->> 'id',
          coalesce(v_source ->> 'name', v_source ->> 'id'),
          v_source ->> 'kind',
          case when p_quality_status = 'complete' and v_source_status in ('live', 'preview') then v_source_status end,
          case when p_quality_status = 'complete' and v_source_status in ('live', 'preview') then v_source end,
          case when p_quality_status = 'complete' and v_source_status in ('live', 'preview')
            then coalesce((v_source ->> 'updatedAt')::timestamptz, p_completed_at)
          end,
          case when p_quality_status = 'complete' and v_source_status in ('live', 'preview')
            then (v_source ->> 'valueUsd')::numeric
          end,
          case when p_quality_status = 'complete' and v_source_status in ('live', 'preview')
            then (v_source ->> 'itemCount')::integer
          end,
          p_completed_at,
          v_source_status,
          case when v_source_status in ('live', 'preview')
            then null
            else left(coalesce(v_source ->> 'detail', 'Source attempt failed'), 500)
          end,
          case when v_source_status in ('live', 'preview') then 0 else 1 end,
          p_run_id,
          p_completed_at
        )
        on conflict (source_id) do update set
          source_name = excluded.source_name,
          source_kind = excluded.source_kind,
          last_good_status = case
            when excluded.last_good_payload is not null then excluded.last_good_status
            else public.portfolio_source_state.last_good_status
          end,
          last_good_payload = case
            when excluded.last_good_payload is not null then excluded.last_good_payload
            else public.portfolio_source_state.last_good_payload
          end,
          last_good_at = case
            when excluded.last_good_payload is not null then excluded.last_good_at
            else public.portfolio_source_state.last_good_at
          end,
          last_good_value_usd = case
            when excluded.last_good_payload is not null then excluded.last_good_value_usd
            else public.portfolio_source_state.last_good_value_usd
          end,
          last_good_item_count = case
            when excluded.last_good_payload is not null then excluded.last_good_item_count
            else public.portfolio_source_state.last_good_item_count
          end,
          last_attempt_at = excluded.last_attempt_at,
          last_attempt_status = excluded.last_attempt_status,
          last_error = excluded.last_error,
          consecutive_failures = case
            when excluded.last_attempt_status in ('live', 'preview') then 0
            else public.portfolio_source_state.consecutive_failures + 1
          end,
          sync_run_id = excluded.sync_run_id,
          updated_at = excluded.updated_at;
      end if;
    end loop;
  end if;

  if p_publish_current then
    if p_snapshot is null or p_quality_status <> 'complete' then
      raise exception 'only a complete snapshot can be published';
    end if;
    v_captured_at := (p_snapshot ->> 'generatedAt')::timestamptz;

    insert into public.portfolio_current (
      id,
      captured_at,
      net_worth_usd,
      is_partial,
      source_count,
      sync_run_id,
      quality_status,
      quality,
      snapshot,
      updated_at
    ) values (
      true,
      v_captured_at,
      (p_snapshot ->> 'netWorthUsd')::numeric,
      (p_snapshot ->> 'isPartial')::boolean,
      (p_snapshot ->> 'connectedSourceCount')::integer,
      p_run_id,
      p_quality_status,
      coalesce(p_detail -> 'quality', '{}'::jsonb),
      p_snapshot,
      p_completed_at
    )
    on conflict (id) do update set
      captured_at = excluded.captured_at,
      net_worth_usd = excluded.net_worth_usd,
      is_partial = excluded.is_partial,
      source_count = excluded.source_count,
      sync_run_id = excluded.sync_run_id,
      quality_status = excluded.quality_status,
      quality = excluded.quality,
      snapshot = excluded.snapshot,
      updated_at = excluded.updated_at
    where excluded.captured_at >= public.portfolio_current.captured_at;

    if p_write_value then
      v_bucket_at := date_trunc('hour', v_captured_at);
      insert into public.portfolio_value_snapshots (
        bucket_at,
        captured_at,
        net_worth_usd,
        exchanges_usd,
        wallets_usd,
        banks_usd,
        is_partial,
        source_count,
        sync_run_id,
        quality_status,
        quality
      ) values (
        v_bucket_at,
        v_captured_at,
        (p_snapshot ->> 'netWorthUsd')::numeric,
        (p_snapshot #>> '{groups,exchangesUsd}')::numeric,
        (p_snapshot #>> '{groups,walletsUsd}')::numeric,
        (p_snapshot #>> '{groups,banksUsd}')::numeric,
        (p_snapshot ->> 'isPartial')::boolean,
        (p_snapshot ->> 'connectedSourceCount')::integer,
        p_run_id,
        p_quality_status,
        coalesce(p_detail -> 'quality', '{}'::jsonb)
      )
      on conflict (bucket_at) do update set
        captured_at = excluded.captured_at,
        net_worth_usd = excluded.net_worth_usd,
        exchanges_usd = excluded.exchanges_usd,
        wallets_usd = excluded.wallets_usd,
        banks_usd = excluded.banks_usd,
        is_partial = excluded.is_partial,
        source_count = excluded.source_count,
        sync_run_id = excluded.sync_run_id,
        quality_status = excluded.quality_status,
        quality = excluded.quality
      where excluded.captured_at >= public.portfolio_value_snapshots.captured_at;
    end if;

    if p_write_full then
      insert into public.portfolio_snapshots (
        captured_at,
        net_worth_usd,
        is_partial,
        source_count,
        snapshot,
        sync_run_id,
        quality_status,
        quality
      ) values (
        v_captured_at,
        (p_snapshot ->> 'netWorthUsd')::numeric,
        (p_snapshot ->> 'isPartial')::boolean,
        (p_snapshot ->> 'connectedSourceCount')::integer,
        p_snapshot,
        p_run_id,
        p_quality_status,
        coalesce(p_detail -> 'quality', '{}'::jsonb)
      );
    end if;
  end if;

  update public.portfolio_sync_runs
  set
    completed_at = p_completed_at,
    status = p_status,
    duration_ms = greatest(0, p_duration_ms),
    net_worth_usd = p_net_worth_usd,
    source_count = greatest(0, p_source_count),
    error_count = greatest(0, p_error_count),
    detail = coalesce(p_detail, '{}'::jsonb),
    lease_expires_at = p_completed_at
  where id = p_run_id;

  return true;
end;
$$;

revoke all on function public.finish_portfolio_sync_v2(
  bigint,
  uuid,
  timestamptz,
  text,
  integer,
  numeric,
  integer,
  integer,
  jsonb,
  jsonb,
  text,
  boolean,
  boolean,
  boolean
) from public;
grant execute on function public.finish_portfolio_sync_v2(
  bigint,
  uuid,
  timestamptz,
  text,
  integer,
  numeric,
  integer,
  integer,
  jsonb,
  jsonb,
  text,
  boolean,
  boolean,
  boolean
) to service_role;

comment on function public.claim_portfolio_sync_v2(text, text, text, timestamptz, integer) is
  'Claims the single aggregate sync lease and deduplicates successful scheduled jobs.';

comment on function public.finish_portfolio_sync_v2(
  bigint,
  uuid,
  timestamptz,
  text,
  integer,
  numeric,
  integer,
  integer,
  jsonb,
  jsonb,
  text,
  boolean,
  boolean,
  boolean
) is 'Fenced completion: records source attempts and atomically promotes only complete aggregate snapshots.';

notify pgrst, 'reload schema';

commit;
