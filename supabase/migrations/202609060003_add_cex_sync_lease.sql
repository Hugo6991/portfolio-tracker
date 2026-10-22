begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.cex_sync_runs
  alter column completed_at drop not null;

alter table public.cex_sync_runs
  drop constraint if exists cex_sync_runs_status_check;

alter table public.cex_sync_runs
  add constraint cex_sync_runs_status_check
  check (status in ('running', 'success', 'partial', 'failed', 'abandoned'));

alter table public.cex_sync_runs
  add column if not exists trigger text,
  add column if not exists job_key text,
  add column if not exists lease_key text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt integer not null default 1;

alter table public.cex_sync_runs
  drop constraint if exists cex_sync_runs_trigger_check;

alter table public.cex_sync_runs
  add constraint cex_sync_runs_trigger_check
  check (trigger is null or trigger in ('cron', 'manual'));

alter table public.cex_sync_runs
  drop constraint if exists cex_sync_runs_attempt_check;

alter table public.cex_sync_runs
  add constraint cex_sync_runs_attempt_check
  check (attempt >= 1);

create unique index if not exists cex_sync_runs_job_attempt_idx
  on public.cex_sync_runs (job_key, attempt)
  where job_key is not null;

create unique index if not exists cex_sync_runs_running_lease_idx
  on public.cex_sync_runs (lease_key)
  where status = 'running' and lease_key is not null;

create or replace function public.claim_cex_sync_v1(
  p_job_key text,
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
  v_lease_key constant text := 'cex:sources';
  v_attempt integer;
begin
  if p_job_key is null or length(trim(p_job_key)) = 0 then
    raise exception 'job key is required';
  end if;
  if p_trigger not in ('cron', 'manual') then
    raise exception 'invalid sync trigger';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_lease_key));

  update public.cex_sync_runs
  set
    completed_at = clock_timestamp(),
    status = 'abandoned',
    duration_ms = least(
      2147483647::numeric,
      greatest(0::numeric, floor(extract(epoch from (clock_timestamp() - started_at)) * 1000))
    )::integer,
    detail = detail || jsonb_build_object('reason', 'lease_expired')
  where
    lease_key = v_lease_key and
    status = 'running' and
    lease_expires_at <= clock_timestamp();

  if exists (
    select 1
    from public.cex_sync_runs
    where job_key = p_job_key and status = 'success'
  ) then
    claimed := false;
    run_id := null;
    lease_token := null;
    reason := 'already_completed';
    return next;
    return;
  end if;

  select runs.id
  into run_id
  from public.cex_sync_runs as runs
  where
    runs.lease_key = v_lease_key and
    runs.status = 'running' and
    runs.lease_expires_at > clock_timestamp()
  order by runs.started_at desc
  limit 1;

  if run_id is not null then
    claimed := false;
    lease_token := null;
    reason := 'already_running';
    return next;
    return;
  end if;

  select coalesce(max(runs.attempt), 0) + 1
  into v_attempt
  from public.cex_sync_runs as runs
  where runs.job_key = p_job_key;

  lease_token := extensions.gen_random_uuid();
  insert into public.cex_sync_runs (
    started_at,
    completed_at,
    status,
    duration_ms,
    detail,
    trigger,
    job_key,
    lease_key,
    lease_token,
    lease_expires_at,
    attempt
  ) values (
    p_started_at,
    null,
    'running',
    0,
    jsonb_build_object('mode', 'cex'),
    p_trigger,
    p_job_key,
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

revoke all on function public.claim_cex_sync_v1(text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_cex_sync_v1(text, text, timestamptz, integer) to service_role;

create or replace function public.finish_cex_sync_v1(
  p_run_id bigint,
  p_lease_token uuid,
  p_completed_at timestamptz,
  p_status text,
  p_duration_ms integer,
  p_detail jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
  if p_status not in ('success', 'partial', 'failed') then
    raise exception 'invalid final sync status';
  end if;

  update public.cex_sync_runs
  set
    completed_at = p_completed_at,
    status = p_status,
    duration_ms = greatest(0, p_duration_ms),
    detail = coalesce(p_detail, '{}'::jsonb),
    lease_key = null,
    lease_token = null,
    lease_expires_at = null
  where
    id = p_run_id and
    lease_token = p_lease_token and
    status = 'running' and
    lease_expires_at > clock_timestamp();

  return found;
end;
$$;

revoke all on function public.finish_cex_sync_v1(bigint, uuid, timestamptz, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.finish_cex_sync_v1(bigint, uuid, timestamptz, text, integer, jsonb) to service_role;

comment on function public.claim_cex_sync_v1(text, text, timestamptz, integer) is
  'Claims the single CEX provider-sync lease and deduplicates successful schedule buckets.';

comment on function public.finish_cex_sync_v1(bigint, uuid, timestamptz, text, integer, jsonb) is
  'Completes a CEX sync only while the caller still owns an unexpired lease.';

notify pgrst, 'reload schema';

commit;
