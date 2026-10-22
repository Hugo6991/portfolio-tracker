begin;

create or replace function public.record_portfolio_source_payloads_v1(
  p_run_id bigint,
  p_completed_at timestamptz,
  p_source_payloads jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_payload jsonb;
  v_source jsonb;
  v_source_status text;
  v_source_kind text;
  v_is_good boolean;
  v_last_good_at timestamptz;
begin
  if jsonb_typeof(p_source_payloads) <> 'array' then
    return;
  end if;

  for v_payload in select value from jsonb_array_elements(p_source_payloads)
  loop
    v_source := v_payload -> 'source';
    v_source_status := v_source ->> 'status';
    v_source_kind := v_source ->> 'kind';
    v_is_good := v_source_status in ('live', 'preview');

    if
      coalesce(v_source ->> 'id', '') <> '' and
      v_source_kind in ('exchange', 'wallet', 'bank') and
      v_source_status in ('live', 'partial', 'preview', 'error') and
      jsonb_typeof(v_payload -> 'holdings') = 'array'
    then
      v_last_good_at := case
        when v_is_good and nullif(v_source ->> 'updatedAt', '') is not null
          then (v_source ->> 'updatedAt')::timestamptz
        when v_is_good then p_completed_at
        else null
      end;

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
        v_source_kind,
        case when v_is_good then v_source_status end,
        case when v_is_good then v_payload end,
        v_last_good_at,
        case when v_is_good then (v_source ->> 'valueUsd')::numeric end,
        case when v_is_good then (v_source ->> 'itemCount')::integer end,
        p_completed_at,
        v_source_status,
        case when v_is_good then null else left(coalesce(v_source ->> 'detail', 'Source attempt failed'), 500) end,
        case when v_is_good then 0 else 1 end,
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
end;
$$;

revoke all on function public.record_portfolio_source_payloads_v1(bigint, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_portfolio_source_payloads_v1(bigint, timestamptz, jsonb) to service_role;

create or replace function public.finish_portfolio_sync_v3(
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
  p_write_full boolean,
  p_source_payloads jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_run public.portfolio_sync_runs%rowtype;
  v_captured_at timestamptz;
  v_finished boolean;
begin
  if p_quality_status <> 'degraded' then
    v_finished := public.finish_portfolio_sync_v2(
      p_run_id,
      p_lease_token,
      p_completed_at,
      p_status,
      p_duration_ms,
      p_net_worth_usd,
      p_source_count,
      p_error_count,
      p_detail,
      p_snapshot,
      p_quality_status,
      p_publish_current,
      p_write_value,
      p_write_full
    );
    if not v_finished then
      return false;
    end if;
    perform public.record_portfolio_source_payloads_v1(p_run_id, p_completed_at, p_source_payloads);
    return true;
  end if;

  if p_status <> 'partial' or not p_publish_current or p_write_value or p_write_full then
    raise exception 'degraded syncs may only publish the current composite';
  end if;
  if
    p_snapshot is null or
    coalesce((p_snapshot ->> 'isPartial')::boolean, false) is not true or
    jsonb_typeof(p_snapshot -> 'sources') <> 'array'
  then
    raise exception 'degraded publication requires a partial source-backed snapshot';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_snapshot -> 'sources') as source
    where
      (
        source ->> 'kind' <> 'bank' and
        source ->> 'status' <> 'live' and
        coalesce(jsonb_typeof(source -> 'fallback'), '') <> 'object'
      ) or (
        source ->> 'kind' = 'bank' and
        source ->> 'status' not in ('live', 'preview') and
        coalesce(jsonb_typeof(source -> 'fallback'), '') <> 'object'
      )
  ) then
    raise exception 'every incomplete source must carry a last-known-good fallback';
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

  perform public.record_portfolio_source_payloads_v1(p_run_id, p_completed_at, p_source_payloads);
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
    true,
    (p_snapshot ->> 'connectedSourceCount')::integer,
    p_run_id,
    'degraded',
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

  update public.portfolio_sync_runs
  set
    completed_at = p_completed_at,
    status = 'partial',
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

revoke all on function public.finish_portfolio_sync_v3(
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
  boolean,
  jsonb
) from public, anon, authenticated;
grant execute on function public.finish_portfolio_sync_v3(
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
  boolean,
  jsonb
) to service_role;

comment on function public.finish_portfolio_sync_v3(
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
  boolean,
  jsonb
) is 'Records source payloads independently and publishes a current composite only when every failed source has a bounded last-known-good fallback.';

notify pgrst, 'reload schema';

commit;
