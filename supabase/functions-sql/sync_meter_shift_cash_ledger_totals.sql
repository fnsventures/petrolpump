-- Canonical definition of public.sync_meter_shift_cash_ledger_totals. Edit here, then:
--   node scripts/sql-functions.mjs emit sync_meter_shift_cash_ledger_totals
create or replace function public.sync_meter_shift_cash_ledger_totals(
  p_date date,
  p_shift text,
  p_employee_id uuid
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text := lower(btrim(coalesce(p_shift, '')));
  v_credit numeric := 0;
  v_expense numeric := 0;
begin
  perform public.require_staff_access();

  if p_date is null or p_employee_id is null or v_shift not in ('morning', 'afternoon') then
    return;
  end if;

  select
    coalesce((
      select sum(ce.amount)
      from public.credit_entries ce
      where ce.transaction_date = p_date
        and ce.shift = v_shift
        and ce.employee_id = p_employee_id
        and ce.status = 'posted'
    ), 0),
    coalesce((
      select sum(ex.amount)
      from public.expenses ex
      where ex.date = p_date
        and ex.shift = v_shift
        and ex.employee_id = p_employee_id
    ), 0)
  into v_credit, v_expense;

  insert into public.meter_shift_cash (
    reading_date, shift, employee_id,
    cash_collected, phone_pay, credit_amount, expense_amount,
    updated_at
  )
  values (
    p_date, v_shift, p_employee_id,
    0, 0, v_credit, v_expense,
    timezone('utc'::text, now())
  )
  on conflict (reading_date, shift, employee_id)
  do update set
    credit_amount = excluded.credit_amount,
    expense_amount = excluded.expense_amount,
    updated_at = timezone('utc'::text, now())
  where meter_shift_cash.credit_amount is distinct from excluded.credit_amount
     or meter_shift_cash.expense_amount is distinct from excluded.expense_amount;
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows. Provisioned staff only. Unchanged totals are not rewritten.';

revoke all on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) from public, anon;

grant execute on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) to authenticated;
