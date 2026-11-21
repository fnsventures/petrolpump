-- Canonical definition of public.delete_shift_credit_entry. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_shift_credit_entry
create or replace function public.delete_shift_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.credit_entries%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.credit_entries where id = p_entry_id;
  if not found then
    raise exception 'Credit entry not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register credit entries can be removed here';
  end if;

  if v_row.status is distinct from 'cancelled' then
    perform public.require_meter_shift_writable(v_row.transaction_date, v_row.shift);
    perform public.raise_if_day_closing_certified(v_row.transaction_date);
  end if;

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  perform 1 from public.credit_customers where id = v_row.credit_customer_id for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  delete from public.credit_entries
  where id = p_entry_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  if v_row.status is distinct from 'cancelled' then
    perform public.reallocate_credit_settlements(v_row.credit_customer_id);
    perform public.sync_saved_day_closing_for_date(v_row.transaction_date);
  end if;

  return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

comment on function public.delete_shift_credit_entry(uuid) is
  'Remove a shift-register credit sale. The row is deleted, not marked cancelled.';

grant execute on function public.delete_shift_credit_entry(uuid) to authenticated;
