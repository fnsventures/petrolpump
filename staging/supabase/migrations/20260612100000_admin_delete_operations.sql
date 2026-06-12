-- Admin delete/undo: credit settlements & entries, with safe FIFO re-allocation

-- Re-apply FIFO settlements for a customer after a payment is removed
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
as $$
declare
  v_pay record;
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    update public.credit_entries
    set amount_settled = 0
    where credit_customer_id = p_credit_customer_id;

    for v_pay in
      select id, amount
      from public.credit_payments
      where credit_customer_id = p_credit_customer_id
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = p_credit_customer_id
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
    end loop;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);
end;
$$;

comment on function public.reallocate_credit_settlements(uuid) is
  'Reset amount_settled on all entries for a customer, then re-apply remaining payments FIFO.';

-- Delete a settlement and reverse FIFO allocations correctly
create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_last_payment date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    delete from public.credit_payments where id = p_payment_id;
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = v_payment.credit_customer_id;

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'new_due', v_new_due
  );
end;
$$;

comment on function public.delete_credit_payment(uuid) is
  'Admin-only: delete a credit settlement and re-allocate remaining payments FIFO.';

-- Delete a credit entry (only when not settled)
create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_entry record;
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
    raise exception 'Cannot delete a credit entry that has settlements applied. Delete settlements first.';
  end if;

  delete from public.credit_entries where id = p_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount
  );
end;
$$;

comment on function public.delete_credit_entry(uuid) is
  'Admin-only: delete an unsettled credit sale entry. amount_due updated via trigger.';

-- Include row ids in customer detail JSON for admin delete actions
create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb
)
language plpgsql security definer stable
as $$
begin
  return query
  with customer_ids as (
    select c.id as credit_customer_id from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date, max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id, coalesce(sum(p.amount), 0) as payment_tot, max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id, max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c join customer_ids ci on ci.credit_customer_id = c.id group by c.id
  ),
  per_customer as (
    select nm.customer_name, nm.vehicle_no, coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date, b.min_txn_date as first_sale_date, b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name, (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken, sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining, max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date, max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'entry_date', e.transaction_date,
          'amount', e.amount,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount_settled', e.amount_settled
        ) order by e.transaction_date desc
      )
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids) and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'entry_date', p.date,
          'amount', p.amount,
          'payment_mode', p.payment_mode,
          'note', p.note
        ) order by p.date desc
      )
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids) and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date, cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;

grant execute on function public.delete_credit_payment(uuid) to authenticated;
grant execute on function public.delete_credit_entry(uuid) to authenticated;
