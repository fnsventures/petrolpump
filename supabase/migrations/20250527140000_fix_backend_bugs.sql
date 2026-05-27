-- Fix backend bugs: credit overpayment, negative as-of balances, RPC grants, page access.

-- ─── Credit payment: reject overpayment; always clear skip_credit_sync on error ─

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
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
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  if v_remaining > 0 then
    raise exception 'Payment amount exceeds outstanding balance';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;

-- ─── As-of credit RPCs: clamp remaining to zero (matches get_open_credit_as_of) ─

create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language plpgsql security definer stable
as $$
begin
  return query
  with bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  ),
  per_customer as (
    select c.customer_name,
           c.vehicle_no,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as amt,
           p.last_pay_date as last_pay,
           b.last_txn_date as last_txn
    from public.credit_customers c
    left join bal b on b.credit_customer_id = c.id
    left join pay p on p.credit_customer_id = c.id
    where greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0) > 0
  )
  select (max(pc.customer_name))::text as customer_name,
         (max(pc.vehicle_no))::text as vehicle_no,
         sum(pc.amt)::numeric as amount_due_as_of,
         max(pc.last_pay) as last_payment_date,
         max(pc.last_txn) as sale_date
  from per_customer pc
  group by lower(trim(pc.customer_name))
  order by amount_due_as_of desc;
end;
$$;

create or replace function public.get_customer_credit_summary_as_of(
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
  last_credit_date date
)
language plpgsql security definer stable
as $$
begin
  return query
  with name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
    group by c.id
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from name_match)
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
      and credit_customer_id in (select credit_customer_id from name_match)
    group by credit_customer_id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  )
  select (max(pc.customer_name))::text,
         (max(pc.vehicle_no))::text,
         sum(pc.credit_taken)::numeric as credit_taken,
         sum(pc.settlement_done)::numeric as settlement_done,
         sum(pc.remaining)::numeric as remaining,
         max(pc.last_payment_date) as last_payment_date,
         min(pc.first_sale_date) as first_sale_date,
         max(pc.last_credit_date) as last_credit_date
  from per_customer pc;
end;
$$;

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
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date
      and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    join customer_ids ci on ci.credit_customer_id = c.id
    group by c.id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name,
           (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken,
           sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining,
           max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date,
           max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'entry_date', e.transaction_date,
          'amount', e.amount,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount_settled', e.amount_settled
        ) order by e.transaction_date desc
      )
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids)
         and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'entry_date', p.date,
          'amount', p.amount,
          'payment_mode', p.payment_mode,
          'note', p.note
        ) order by p.date desc
      )
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids)
         and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date,
         cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;

-- ─── Page access: day-closing (supervisor + admin, same as DSR) ───────────────

create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql security definer stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();

  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'analysis' then v_role = 'admin'
    when 'reports' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'day-closing' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'credit-overdue' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

-- ─── Ensure authenticated role can execute client-facing RPCs ───────────────────

grant execute on function public.check_page_access(text) to authenticated;
grant execute on function public.update_dsr_buying_price(uuid, numeric) to authenticated;
grant execute on function public.get_day_closing_breakdown(date) to authenticated;
grant execute on function public.save_day_closing(date, numeric, numeric, text) to authenticated;
grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text) to authenticated;
grant execute on function public.record_credit_payment(uuid, date, numeric, text, text) to authenticated;
grant execute on function public.get_credit_ledger_aggregated() to authenticated;
grant execute on function public.get_open_credit_as_of(date) to authenticated;
grant execute on function public.get_outstanding_credit_list_as_of(date) to authenticated;
grant execute on function public.get_customer_credit_summary_as_of(text, date) to authenticated;
grant execute on function public.get_customer_credit_detail_as_of(text, date) to authenticated;
grant execute on function public.upsert_staff(text, text, text) to authenticated;
grant execute on function public.delete_staff(text) to authenticated;
grant execute on function public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb) to authenticated;
grant execute on function public.get_dsr_stock_range(date, date) to authenticated;
grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;
grant execute on function public.compute_day_closing_components(date) to authenticated;
