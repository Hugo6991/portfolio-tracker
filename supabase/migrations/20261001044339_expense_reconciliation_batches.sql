-- One canonical transaction, with append-only events and immutable batch receipts.
create table public.expense_batches (
  batch_id text primary key,
  actor text not null,
  request jsonb not null,
  receipt jsonb,
  created_at timestamptz not null default now()
);
create table public.expense_entries (
  record_id text primary key,
  identity_key text not null unique,
  record jsonb not null,
  revision integer not null check (revision > 0),
  deleted boolean not null default false
);
alter table public.expense_batches enable row level security;
alter table public.expense_entries enable row level security;
revoke all on public.expense_batches, public.expense_entries from public, anon, authenticated;
grant select, insert, update on public.expense_batches, public.expense_entries to service_role;
alter table public.expense_events add column batch_id text references public.expense_batches(batch_id);

create function public.expense_identity(r jsonb) returns text
language plpgsql immutable security invoker set search_path = '' as $$
declare
  fp text := lower(btrim(coalesce(r->>'importFingerprint', '')));
  src text := lower(btrim(coalesce(r->>'paymentSource', '')));
  tx text := lower(btrim(coalesce(r->>'sourceRecordId', '')));
begin
  if fp like 'infini:%' or fp like 'plasma:%' then
    if src <> '' and src <> split_part(fp, ':', 1) then return null; end if;
    src := split_part(fp, ':', 1);
    if tx <> '' and tx <> substr(fp, length(src) + 2) then return null; end if;
    tx := substr(fp, length(src) + 2);
  end if;
  if src in ('infini', 'plasma') then
    if tx = '' then return null; end if;
    return src || ':' || tx;
  end if;
  if fp <> '' then return 'import:' || fp; end if;
  if tx <> '' then return 'source:' || lower(r->>'sourceName') || ':' || tx; end if;
  return 'record:' || (r->>'id');
end;
$$;
revoke all on function public.expense_identity(jsonb) from public, anon, authenticated;
grant execute on function public.expense_identity(jsonb) to service_role;

-- Keep historical events intact. Fail migration if historical identities conflict.
insert into public.expense_entries(record_id, identity_key, record, revision, deleted)
select u.record_id, public.expense_identity(u.record), u.record,
       (select count(*)::integer from public.expense_events e where e.record_id = u.record_id),
       (select e.operation = 'delete' from public.expense_events e where e.record_id = u.record_id order by e.id desc limit 1)
from (
  select distinct on (record_id) record_id, record from public.expense_events
  where operation = 'upsert' order by record_id, id desc
) u;

-- All event writers use the same lock and immutable identity registry, including
-- legacy clients during deployment. Legacy inserts remain supported but receive
-- their own persisted receipt; changing an existing row requires the batch RPC.
create function public.guard_expense_event() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  k text;
  old public.expense_entries%rowtype;
  n integer;
  legacy boolean := new.batch_id is null;
  outcome text;
begin
  perform pg_advisory_xact_lock(174021, 1);
  select * into old from public.expense_entries where record_id = new.record_id;
  if new.operation = 'upsert' then
    if new.record->>'id' is distinct from new.record_id then raise exception 'Expense record ID mismatch'; end if;
    k := public.expense_identity(new.record);
    if k is null then raise exception 'Expense transaction identity is missing or inconsistent'; end if;
    if old.record_id is not null and old.identity_key <> k then
      raise exception 'Expense transaction identity cannot change';
    end if;
    if exists(select 1 from public.expense_entries where identity_key = k and record_id <> new.record_id) then
      raise unique_violation using message = 'Expense transaction already exists';
    end if;
    if legacy and old.record_id is not null then
      raise exception 'Existing expenses must be changed through the reconciliation gateway';
    end if;
  elsif old.record_id is null then
    raise exception 'Expense record does not exist';
  end if;
  n := coalesce(old.revision, 0) + 1;
  outcome := case when old.record_id is null then 'added' else 'corrected' end;
  if legacy then
    new.batch_id := 'legacy:' || new.event_id::text;
    insert into public.expense_batches(batch_id, actor, request, receipt)
    values(new.batch_id, 'legacy-app', jsonb_build_object('operation',new.operation,'recordId',new.record_id),
      jsonb_build_object('batchId',new.batch_id,'actor','legacy-app','createdAt',now(),
        'results',jsonb_build_array(jsonb_build_object('status',outcome,'recordId',new.record_id,'revision',n))));
  end if;
  new.updated_at := clock_timestamp();
  if new.operation = 'upsert' then
    new.record := new.record || jsonb_build_object('updatedAt',new.updated_at,'ledgerRevision',n);
    insert into public.expense_entries(record_id,identity_key,record,revision,deleted)
      values(new.record_id,k,new.record,n,false)
      on conflict(record_id) do update set record=excluded.record, revision=excluded.revision, deleted=false;
  else
    update public.expense_entries set deleted=true,revision=n where record_id=new.record_id;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_expense_event() from public, anon, authenticated;
grant execute on function public.guard_expense_event() to service_role;
create trigger expense_event_gateway before insert on public.expense_events
for each row execute function public.guard_expense_event();

create function public.reconcile_expenses(p_batch_id text, p_actor text, p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  req jsonb := jsonb_build_object('actor',p_actor,'items',p_items);
  prior public.expense_batches%rowtype;
  item jsonb; r jsonb; k text; rid text; act text; outcome text; reason text;
  old public.expense_entries%rowtype;
  results jsonb := '[]'::jsonb; receipt jsonb;
begin
  if coalesce(length(btrim(p_batch_id)),0) not between 1 and 200
    or coalesce(length(btrim(p_actor)),0) not between 1 and 100
    or jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) not between 1 and 1000 then
    raise exception 'Invalid expense batch';
  end if;
  -- Personal ledger: serialize the entire batch, including receipt publication.
  perform pg_advisory_xact_lock(174021, 1);
  select * into prior from public.expense_batches where batch_id = p_batch_id;
  if found then
    if prior.request <> req then raise exception 'Batch ID already used with different content'; end if;
    return prior.receipt;
  end if;
  insert into public.expense_batches(batch_id,actor,request) values(p_batch_id,p_actor,req);
  for item in select value from jsonb_array_elements(p_items) loop
    r := item->'record'; act := coalesce(item->>'action','upsert');
    rid := coalesce(r->>'id',item->>'recordId');
    k := case when r is not null then public.expense_identity(r) end;
    outcome := null; reason := null; old := null;
    if act not in ('upsert','correct','delete','review') then raise exception 'Invalid expense action'; end if;
    select * into old from public.expense_entries where record_id=rid;
    if old.record_id is null and k is not null then
      select * into old from public.expense_entries where identity_key=k;
    end if;
    if act = 'review' then
      outcome := 'review'; reason := coalesce(nullif(item->>'reason',''),'Needs confirmation');
    elsif act = 'delete' then
      if old.record_id is null then outcome := 'review'; reason := 'Record not found';
      elsif (item->>'expectedRevision')::integer is distinct from old.revision then
        outcome := 'review'; reason := 'Revision changed; reload before correction';
      elsif old.deleted then outcome := 'exists'; reason := 'Already deleted';
      else outcome := 'corrected'; end if;
    else
      if r is null or coalesce(r->>'id','') = '' or coalesce(r->>'merchant','') = ''
        or coalesce(r->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
        or coalesce((r->>'nativeAmount')::numeric,0) <= 0
        or coalesce((r->>'usdValue')::numeric,-1) < 0
        or coalesce(r->>'nativeCurrency','') not in ('USD','TWD','CNY') then
        raise exception 'Invalid expense record';
      end if;
      if coalesce(r->>'settlementStatus','settled') <> 'settled' then
        outcome := 'review'; reason := 'Transaction is not settled';
      elsif k is null then outcome := 'review'; reason := 'Missing or inconsistent transaction identity';
      elsif old.record_id is not null and old.identity_key <> k then
        outcome := 'review'; reason := 'Record ID belongs to a different transaction';
      elsif act = 'correct' then
        if old.record_id is null or old.record_id <> rid or old.identity_key <> k then
          outcome := 'review'; reason := 'Correction must reference the same canonical transaction';
        elsif (item->>'expectedRevision')::integer is distinct from old.revision then
          outcome := 'review'; reason := 'Revision changed; reload before correction';
        elsif coalesce(btrim(item->>'reason'),'') = '' then
          outcome := 'review'; reason := 'Correction reason required';
        else outcome := 'corrected'; end if;
      elsif old.record_id is null then outcome := 'added';
      elsif old.deleted then outcome := 'review'; reason := 'Deleted transaction; explicit correction required to restore';
      elsif (old.record->>'nativeAmount')::numeric = (r->>'nativeAmount')::numeric
        and old.record->>'nativeCurrency' = r->>'nativeCurrency'
        and (old.record->>'usdValue')::numeric = (r->>'usdValue')::numeric
        and old.record->>'date' = r->>'date'
        and old.record->>'category' = r->>'category'
        and old.record->>'merchant' = r->>'merchant'
        and coalesce(old.record->>'note','') = coalesce(r->>'note','')
        and coalesce(old.record->'sheetRefs','[]'::jsonb) = coalesce(r->'sheetRefs','[]'::jsonb)
        and coalesce(old.record->>'cardLast4','') = coalesce(r->>'cardLast4','') then
          outcome := 'exists';
      else outcome := 'review'; reason := 'Transaction already exists with different details'; end if;
    end if;
    if outcome in ('added','corrected') then
      insert into public.expense_events(event_id,operation,record_id,record,updated_at,batch_id)
      values(gen_random_uuid(),case when act='delete' then 'delete' else 'upsert' end,
        rid,case when act='delete' then null else r end,now(),p_batch_id);
      select * into old from public.expense_entries where record_id=rid;
    end if;
    results := results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'status',outcome,'submittedId',rid,'recordId',coalesce(old.record_id,rid),
      'identity',coalesce(old.identity_key,k),'revision',old.revision,'reason',reason,
      'action',act,'sheetRefs',r->'sheetRefs',
      'submittedDetails', case when r is null then null else jsonb_build_object(
        'merchant',r->>'merchant','date',r->>'date','nativeAmount',r->'nativeAmount',
        'nativeCurrency',r->>'nativeCurrency','sourceRecordId',r->>'sourceRecordId',
        'paymentSource',r->>'paymentSource','cardLast4',r->>'cardLast4') end
    )));
  end loop;
  receipt := jsonb_build_object('batchId',p_batch_id,'actor',p_actor,'createdAt',now(),
    'results',results,'counts',jsonb_build_object(
      'added',(select count(*) from jsonb_array_elements(results) x where x->>'status'='added'),
      'exists',(select count(*) from jsonb_array_elements(results) x where x->>'status'='exists'),
      'review',(select count(*) from jsonb_array_elements(results) x where x->>'status'='review'),
      'corrected',(select count(*) from jsonb_array_elements(results) x where x->>'status'='corrected')
    ));
  update public.expense_batches set receipt=receipt_payload.value
    from (select receipt as value) receipt_payload where batch_id=p_batch_id;
  return receipt;
end;
$$;
revoke all on function public.reconcile_expenses(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_expenses(text,text,jsonb) to service_role;
