-- Canonical definition of public.get_shift_staff_ledger. Edit here, then:
--   node scripts/sql-functions.mjs emit get_shift_staff_ledger
create or replace function public.get_shift_staff_ledger(p_date date, p_shift text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_staff_access();
  if p_date is null then
    raise exception 'Date is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'credit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'employee_id', e.employee_id,
          'customer_name', c.customer_name,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount', e.amount,
          'amount_settled', e.amount_settled,
          'status', e.status,
          'created_by', e.created_by
        )
        order by c.customer_name, e.created_at
      )
      from public.credit_entries e
      join public.credit_customers c on c.id = e.credit_customer_id
      where e.transaction_date = p_date
        and e.shift = v_shift
        and e.employee_id is not null
        and e.status = 'posted'
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'employee_id', x.employee_id,
          'category', x.category,
          'description', x.description,
          'amount', x.amount,
          'created_by', x.created_by
        )
        order by x.created_at
      )
      from public.expenses x
      where x.date = p_date
        and x.shift = v_shift
        and x.employee_id is not null
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_shift_staff_ledger(date, text) to authenticated;
