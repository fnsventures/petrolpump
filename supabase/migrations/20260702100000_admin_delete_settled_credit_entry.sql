-- Allow admins to delete settled credit entries; re-allocate remaining payments FIFO.

create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
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

  if coalesce(v_entry.amount_settled, 0) > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    begin
      delete from public.credit_entries where id = p_entry_id;
      perform public.reallocate_credit_settlements(v_entry.credit_customer_id);
    exception
      when others then
        perform set_config('app.skip_credit_sync', '', true);
        raise;
    end;
    perform set_config('app.skip_credit_sync', '', true);
  else
    delete from public.credit_entries where id = p_entry_id;
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_entry.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_entry(uuid) is
  'Admin-only: delete a credit sale entry. Settled entries re-allocate remaining payments FIFO.';
