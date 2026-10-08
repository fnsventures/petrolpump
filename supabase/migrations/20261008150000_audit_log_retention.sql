-- Keep audit_log inside the free-tier database: index the purge key, stop
-- auditing meter_shift_cash updates that only refresh cached ledger totals,
-- let staging turn audit off, and add a maintenance function that deletes
-- one batch of rows older than 6 months. The monthly backup workflow calls
-- it. This does not delete operational rows.

create table if not exists public.runtime_flags (
  key text primary key,
  value text not null
);

comment on table public.runtime_flags is
  'Switches read by security-definer functions. Production has no audit row (logging stays on). Staging sets audit=off so the playground stores no audit_log rows.';

alter table public.runtime_flags enable row level security;

revoke all on table public.runtime_flags from public, anon, authenticated;

create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Missing row: production, keep logging. Staging sets value 'off'.
  if exists (
    select 1 from public.runtime_flags
    where key = 'audit' and value = 'off'
  ) then
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    return NEW;
  end if;

  if TG_OP = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, OLD.id, TG_OP, to_jsonb(OLD), auth.uid(), auth.jwt() ->> 'email');
    return OLD;
  elsif TG_OP = 'UPDATE' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(OLD), to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  elsif TG_OP = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  end if;
  return null;
end;
$$;

comment on function public.audit_trigger_fn() is
  'Writes audit_log unless runtime_flags.audit is off (staging).';

create index if not exists audit_log_performed_at_idx
  on public.audit_log (performed_at);

comment on table public.audit_log is
  'Audit trail for sensitive operations (admin-only view). Rows older than 6 months are deleted by purge_audit_log_batch.';

-- Cash and phone pay stay audited. credit_amount / expense_amount are a cache
-- of the ledger and are refreshed on every attributed credit or expense write.
drop trigger if exists audit_meter_shift_cash_trigger on public.meter_shift_cash;
create trigger audit_meter_shift_cash_trigger
  after insert or delete on public.meter_shift_cash
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_meter_shift_cash_update_trigger on public.meter_shift_cash;
create trigger audit_meter_shift_cash_update_trigger
  after update on public.meter_shift_cash
  for each row
  when (
    old.reading_date is distinct from new.reading_date
    or old.shift is distinct from new.shift
    or old.employee_id is distinct from new.employee_id
    or old.cash_collected is distinct from new.cash_collected
    or old.phone_pay is distinct from new.phone_pay
    or old.remarks is distinct from new.remarks
  )
  execute function public.audit_trigger_fn();

create or replace function public.purge_audit_log_batch(
  p_keep interval default interval '6 months',
  p_batch integer default 5000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz;
  v_deleted integer;
begin
  if p_keep is null or p_keep < interval '30 days' then
    raise exception 'audit retention must be at least 30 days';
  end if;
  if p_batch is null or p_batch < 1 or p_batch > 20000 then
    raise exception 'audit purge batch must be between 1 and 20000';
  end if;

  v_cutoff := timezone('utc', now()) - p_keep;

  delete from public.audit_log
  where id in (
    select id
    from public.audit_log
    where performed_at < v_cutoff
    order by performed_at
    limit p_batch
  );

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.purge_audit_log_batch(interval, integer) is
  'Delete one batch of audit_log rows older than p_keep (default 6 months). Not granted to app roles; scripts/purge-audit-log.sh calls it.';

revoke all on function public.purge_audit_log_batch(interval, integer) from public, anon, authenticated, service_role;
