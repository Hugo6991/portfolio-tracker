-- Durable, privacy-preserving request limits for public dynamic endpoints.
create table if not exists public.request_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  blocked_until timestamptz,
  updated_at timestamptz not null
);

create index if not exists request_rate_limits_updated_at_idx
  on public.request_rate_limits (updated_at);

alter table public.request_rate_limits enable row level security;
revoke all on public.request_rate_limits from public, anon, authenticated;

create or replace function public.consume_request_rate_limit(
  p_key_hash text,
  p_window_seconds integer,
  p_max_attempts integer,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval;
  v_count integer;
  v_blocked_until timestamptz;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Rate-limit key is invalid';
  end if;
  if p_window_seconds is null or p_window_seconds < 10 or p_window_seconds > 86400 then
    raise exception 'Rate-limit window is invalid';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10000 then
    raise exception 'Rate-limit attempt count is invalid';
  end if;
  if p_now is null then
    raise exception 'Rate-limit timestamp is invalid';
  end if;

  v_window := p_window_seconds * interval '1 second';

  insert into public.request_rate_limits as current_limit (
    key_hash,
    window_started_at,
    attempt_count,
    blocked_until,
    updated_at
  ) values (
    p_key_hash,
    p_now,
    1,
    null,
    p_now
  )
  on conflict (key_hash) do update set
    window_started_at = case
      when current_limit.window_started_at <= p_now - v_window
        and (current_limit.blocked_until is null or current_limit.blocked_until <= p_now)
        then p_now
      else current_limit.window_started_at
    end,
    attempt_count = case
      when current_limit.blocked_until > p_now then current_limit.attempt_count
      when current_limit.window_started_at <= p_now - v_window then 1
      else current_limit.attempt_count + 1
    end,
    blocked_until = case
      when current_limit.blocked_until > p_now then current_limit.blocked_until
      when current_limit.window_started_at <= p_now - v_window then null
      when current_limit.attempt_count + 1 > p_max_attempts then p_now + v_window
      else null
    end,
    updated_at = p_now
  returning attempt_count, blocked_until
  into v_count, v_blocked_until;

  if random() < 0.01 then
    delete from public.request_rate_limits
    where ctid in (
      select ctid
      from public.request_rate_limits
      where updated_at < p_now - interval '7 days'
      limit 1000
    );
  end if;

  return jsonb_build_object(
    'allowed', v_blocked_until is null or v_blocked_until <= p_now,
    'attemptCount', v_count,
    'retryAfterSeconds', case
      when v_blocked_until > p_now
        then greatest(1, ceil(extract(epoch from v_blocked_until - p_now))::integer)
      else 0
    end
  );
end;
$$;

revoke all on function public.consume_request_rate_limit(text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_request_rate_limit(text, integer, integer, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
