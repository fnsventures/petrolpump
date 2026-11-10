-- Remaining backend fixes: open-credit total alignment, missing RPC grants.

-- ─── get_open_credit_as_of: sum over all customers (matches outstanding list) ─

create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language plpgsql security definer stable
as $$
declare
  v_total numeric;
begin
  with bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  )
  select coalesce(sum(
    greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)
  ), 0)
  into v_total
  from public.credit_customers c
  left join bal b on b.credit_customer_id = c.id
  left join pay p on p.credit_customer_id = c.id;

  return v_total;
end;
$$;

comment on function public.get_open_credit_as_of(date) is
  'Total outstanding credit as of date D; all customers, clamped >= 0 (matches overdue list).';

-- ─── Grants omitted from prior migrations ─────────────────────────────────────

grant execute on function public.get_dsr_stock_range(date, date) to authenticated;
grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;
grant execute on function public.compute_day_closing_components(date) to authenticated;
