-- Scheduled purge keeps 1 month. A bare call of purge_audit_log_batch()
-- uses that same default. The script can still pass a longer interval, or
-- a number of days, and the function still rejects anything under 30 days.

comment on table public.audit_log is
  'Audit trail for sensitive operations (admin-only view). Rows older than 1 month are deleted by purge_audit_log_batch after the scheduled backup. A manual run can keep 1, 2, or 3 months, or at least 30 days.';

create or replace function public.purge_audit_log_batch(
  p_keep interval default interval '1 month',
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
  'Delete one batch of audit_log rows older than p_keep (default 1 month, minimum 30 days). Not granted to app roles; scripts/purge-audit-log.sh calls it.';

revoke all on function public.purge_audit_log_batch(interval, integer) from public, anon, authenticated, service_role;
