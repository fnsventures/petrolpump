-- Canonical definition of public.audit_trigger_fn. Edit here, then:
--   node scripts/sql-functions.mjs emit audit_trigger_fn
create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if coalesce(current_setting('app.force_audit', true), '') is distinct from 'true' then
    if coalesce(current_setting('app.skip_credit_audit', true), '') = 'true' then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    elsif exists (
      select 1 from public.runtime_flags
      where key = 'audit' and value = 'off'
    ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (tg_table_name, old.id, tg_op, to_jsonb(old), auth.uid(), auth.jwt() ->> 'email');
    return old;
  elsif tg_op = 'UPDATE' then
    select
      jsonb_object_agg(n.key, o.value),
      jsonb_object_agg(n.key, n.value)
    into v_old, v_new
    from jsonb_each(to_jsonb(new)) n
    left join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.key <> 'updated_at'
      and o.value is distinct from n.value;

    if v_new is null then
      return new;
    end if;

    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, v_old, v_new, auth.uid(), auth.jwt() ->> 'email');
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, to_jsonb(new), auth.uid(), auth.jwt() ->> 'email');
    return new;
  end if;
  return null;
end;
$$;

comment on function public.audit_trigger_fn() is
  'Writes audit_log unless runtime_flags.audit is off (staging). UPDATE rows hold only changed columns; an update that changes nothing but updated_at is not logged.';
