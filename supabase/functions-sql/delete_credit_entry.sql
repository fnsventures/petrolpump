-- Canonical definition of public.delete_credit_entry. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_credit_entry
create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_entry record;
  v_new_due numeric;
  v_prepaid numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit entries';
  end if;

  select * into v_entry
  from public.credit_entries
  where id = p_entry_id;

  if not found then
    raise exception 'Credit entry not found';
  end if;

  if v_entry.status is distinct from 'cancelled' then
    perform public.raise_if_day_closing_certified(v_entry.transaction_date);
  end if;

  perform 1
  from public.credit_customers
  where id = v_entry.credit_customer_id
  for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  delete from public.credit_entries
  where id = p_entry_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  if v_entry.status is distinct from 'cancelled' then
    perform public.reallocate_credit_settlements(v_entry.credit_customer_id);
    perform public.sync_saved_day_closing_for_date(v_entry.transaction_date);
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_entry.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount,
    'transaction_date', v_entry.transaction_date,
    'deleted', true,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_entry(uuid) is
  'Admin-only: delete a credit sale. The row is removed. Settled entries re-allocate remaining payments FIFO.';

grant execute on function public.delete_credit_entry(uuid) to authenticated;
