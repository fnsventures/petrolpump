-- Canonical definition of public.delete_salary_payment. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_salary_payment
create or replace function public.delete_salary_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.salary_payments%rowtype;
  v_name text;
  v_linked uuid;
  v_legacy uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete salary payments.';
  end if;

  select * into v_pay from public.salary_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Salary payment not found. Refresh the page and try again.';
  end if;

  perform public.raise_if_day_closing_certified(v_pay.date);

  select x.id into v_linked from public.expenses x where x.salary_payment_id = p_payment_id;

  if v_linked is null then
    -- Payments recorded before expenses.salary_payment_id existed have an unlinked expense.
    -- Only unlinked rows are candidates, so another payment's expense is never touched.
    select e.name into v_name from public.employees e where e.id = v_pay.employee_id;
    select x.id into v_legacy
    from public.expenses x
    where x.salary_payment_id is null
      and x.category = 'salary'
      and x.date = v_pay.date
      and x.amount = v_pay.amount
      and x.description = 'Salary: ' || coalesce(v_name, '') || coalesce(' - ' || nullif(btrim(v_pay.note), ''), '')
    order by x.created_at
    limit 1;
    if v_legacy is not null then
      delete from public.expenses where id = v_legacy;
    end if;
  end if;

  -- The linked expense (if any) is removed by the ON DELETE CASCADE foreign key.
  delete from public.salary_payments where id = p_payment_id;

  return jsonb_build_object(
    'id', p_payment_id,
    'expense_id', coalesce(v_linked, v_legacy),
    'expense_deleted', coalesce(v_linked, v_legacy) is not null
  );
end;
$$;

comment on function public.delete_salary_payment(uuid) is
  'Admin: delete a salary payment and its expense (linked row, or an exact unlinked legacy match). Rejects a certified payment date.';

grant execute on function public.delete_salary_payment(uuid) to authenticated;
