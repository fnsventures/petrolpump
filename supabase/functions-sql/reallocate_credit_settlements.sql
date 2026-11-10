-- Canonical definition of public.reallocate_credit_settlements. Edit here, then:
--   node scripts/sql-functions.mjs emit reallocate_credit_settlements
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_ids uuid[];
  v_entry_dates date[];
  v_entry_amounts numeric[];
  v_settled numeric[];
  v_pay record;
  v_i int;
  v_n int;
  v_remaining numeric;
  v_open numeric;
  v_alloc numeric;
  v_pool numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);
  perform set_config('app.skip_credit_audit', 'true', true);
  perform set_config('app.skip_day_closing_refresh', 'true', true);

  select
    array_agg(id order by transaction_date asc, id asc),
    array_agg(transaction_date order by transaction_date asc, id asc),
    array_agg(amount order by transaction_date asc, id asc)
  into v_entry_ids, v_entry_dates, v_entry_amounts
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  v_n := coalesce(array_length(v_entry_ids, 1), 0);
  if v_n > 0 then
    v_settled := array_fill(0::numeric, array[v_n]);
  end if;

  for v_pay in
    select amount, date
    from public.credit_payments
    where credit_customer_id = p_credit_customer_id
      and status = 'posted'
    order by date asc, created_at asc, id asc
  loop
    v_remaining := v_pay.amount;
    for v_i in reverse v_n..1 loop
      exit when v_remaining <= 0;
      if v_entry_dates[v_i] > v_pay.date then
        continue;
      end if;
      v_open := v_entry_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_remaining, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_remaining := v_remaining - v_alloc;
    end loop;
  end loop;

  select coalesce(sum(amount), 0) into v_pool
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  if v_n > 0 then
    v_pool := v_pool - coalesce((select sum(x) from unnest(v_settled) as x), 0);
    for v_i in 1..v_n loop
      exit when v_pool <= 0;
      v_open := v_entry_amounts[v_i] - v_settled[v_i];
      if v_open <= 0 then
        continue;
      end if;
      v_alloc := least(v_pool, v_open);
      v_settled[v_i] := v_settled[v_i] + v_alloc;
      v_pool := v_pool - v_alloc;
    end loop;

    update public.credit_entries e
    set amount_settled = s.settled
    from unnest(v_entry_ids, v_settled) as s(id, settled)
    where e.id = s.id
      and e.amount_settled is distinct from s.settled;
  end if;

  perform set_config('app.skip_credit_audit', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);
  perform set_config('app.skip_credit_sync', '', true);
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

comment on function public.reallocate_credit_settlements(uuid) is
  'One pass: payments settle newest open sale on or before the payment date, then leftover advance settles the oldest open sale. Writes amount_settled once.';

revoke all on function public.reallocate_credit_settlements(uuid) from public;

revoke all on function public.reallocate_credit_settlements(uuid) from authenticated;
