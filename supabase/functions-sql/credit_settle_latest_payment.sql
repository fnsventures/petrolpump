-- Canonical definition of public.credit_settle_latest_payment. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_settle_latest_payment
create or replace function public.credit_settle_latest_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  if exists (
    select 1 from public.credit_payments
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
      and date > p_date
  ) then
    perform public.reallocate_credit_settlements(p_credit_customer_id);
    return;
  end if;

  v_remaining := coalesce(p_amount, 0);
  perform set_config('app.skip_credit_sync', 'true', true);
  perform set_config('app.skip_credit_audit', 'true', true);

  for v_entry in
    select id, amount, amount_settled
    from public.credit_entries
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
      and transaction_date <= p_date
      and amount_settled < amount
    order by transaction_date desc, id desc
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
    update public.credit_entries
    set amount_settled = amount_settled + v_alloc
    where id = v_entry.id;
    v_remaining := v_remaining - v_alloc;
  end loop;

  if v_remaining > 0 then
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
        and status = 'posted'
        and amount_settled < amount
      order by transaction_date asc, id asc
      for update
    loop
      exit when v_remaining <= 0;
      v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
      update public.credit_entries
      set amount_settled = amount_settled + v_alloc
      where id = v_entry.id;
      v_remaining := v_remaining - v_alloc;
    end loop;
  end if;

  perform set_config('app.skip_credit_audit', '', true);
  perform set_config('app.skip_credit_sync', '', true);
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

revoke all on function public.credit_settle_latest_payment(uuid, date, numeric) from public, anon, authenticated;
