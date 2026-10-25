-- Admin delete removes the credit sale or settlement.
-- Older cancelled rows stay visible until an admin deletes them, and that
-- delete is allowed even when the day is already certified or collected.

create or replace function public.ledger_guard_certified_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_old_date date;
begin
  -- A cancelled sale or payment is already out of balances and day closing.
  -- Deleting that leftover row must not be blocked by a certified or collected day.
  if tg_op = 'DELETE'
     and tg_table_name in ('credit_entries', 'credit_payments')
     and old.status = 'cancelled'
  then
    return null;
  end if;

  if tg_table_name = 'credit_entries' then
    if tg_op = 'UPDATE'
       and old.transaction_date is not distinct from new.transaction_date
       and old.amount is not distinct from new.amount
       and old.credit_customer_id is not distinct from new.credit_customer_id
       and old.fuel_type is not distinct from new.fuel_type
       and old.quantity is not distinct from new.quantity
       and old.employee_id is not distinct from new.employee_id
       and old.shift is not distinct from new.shift
       and old.status is not distinct from new.status
       and old.entry_kind is not distinct from new.entry_kind
    then
      return null;
    end if;
    if tg_op = 'DELETE' then
      v_date := old.transaction_date;
      v_old_date := null;
    else
      v_date := new.transaction_date;
      v_old_date := case when tg_op = 'UPDATE' then old.transaction_date else null end;
    end if;
  else
    if tg_op = 'DELETE' then
      v_date := old.date;
      v_old_date := null;
    else
      v_date := new.date;
      v_old_date := case when tg_op = 'UPDATE' then old.date else null end;
    end if;
  end if;

  if tg_table_name = 'expenses' and v_date > public.meter_station_today() then
    raise exception 'Expense date cannot be in the future';
  end if;

  perform public.raise_if_day_closing_certified(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.raise_if_day_closing_certified(v_old_date);
  end if;

  if tg_table_name in ('expenses', 'credit_entries', 'credit_payments') then
    if exists (
      select 1 from public.day_closing dc
      where dc.date = v_date and dc.night_cash_collection_id is not null
    ) or (
      v_old_date is not null and exists (
        select 1 from public.day_closing dc
        where dc.date = v_old_date and dc.night_cash_collection_id is not null
      )
    ) then
      raise exception 'Night cash for this day has already been collected';
    end if;
  end if;

  if coalesce(current_setting('app.skip_day_closing_refresh', true), '') = 'true' then
    return null;
  end if;

  perform public.refresh_open_day_closing(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.refresh_open_day_closing(v_old_date);
  end if;

  return null;
end;
$$;

comment on function public.ledger_guard_certified_day() is
  'Trigger: reject expenses, credit sales and payments on a certified day, then refresh an uncertified saved closing.';


create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_prepaid numeric;
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

  if v_payment.status is distinct from 'cancelled' then
    perform public.raise_if_day_closing_certified(v_payment.date);
  end if;

  perform 1
  from public.credit_customers
  where id = v_payment.credit_customer_id
  for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  delete from public.credit_payments
  where id = p_payment_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  if v_payment.status is distinct from 'cancelled' then
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);

    select max(date) into v_last_payment
    from public.credit_payments
    where credit_customer_id = v_payment.credit_customer_id
      and status = 'posted';

    update public.credit_customers
    set last_payment = v_last_payment
    where id = v_payment.credit_customer_id;

    perform public.apply_credit_payment_to_day_closing(
      v_payment.date,
      coalesce(v_payment.same_day_settlement, false),
      coalesce(v_payment.payment_mode, 'Cash'),
      -v_payment.amount
    );
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'deleted', true,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_payment(uuid) is
  'Admin-only: delete a credit settlement and re-allocate remaining payments FIFO. The row is removed.';


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


create or replace function public.delete_shift_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.credit_entries%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.credit_entries where id = p_entry_id;
  if not found then
    raise exception 'Credit entry not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register credit entries can be removed here';
  end if;

  if v_row.status is distinct from 'cancelled' then
    perform public.require_meter_shift_writable(v_row.transaction_date, v_row.shift);
    perform public.raise_if_day_closing_certified(v_row.transaction_date);
  end if;

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  perform 1 from public.credit_customers where id = v_row.credit_customer_id for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  delete from public.credit_entries
  where id = p_entry_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  if v_row.status is distinct from 'cancelled' then
    perform public.reallocate_credit_settlements(v_row.credit_customer_id);
    perform public.sync_saved_day_closing_for_date(v_row.transaction_date);
  end if;

  return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

comment on function public.delete_shift_credit_entry(uuid) is
  'Remove a shift-register credit sale. The row is deleted, not marked cancelled.';


create or replace function public.delete_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_n int;
  v_c int;
  v_credit int := 0;
  v_expense int := 0;
  v_settled int := 0;
  v_customer_id uuid;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();
  if not public.is_admin() then
    raise exception 'Only admin can delete shift readings';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select count(*)::int into v_settled
  from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and e.status = 'posted'
    and coalesce(e.amount_settled, 0) > 0;
  if v_settled > 0 then
    raise exception
      'Cannot clear shift: % credit sale(s) already have payments. Remove settlements first.',
      v_settled;
  end if;

  for v_customer_id in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.status = 'posted'
  loop
    delete from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.credit_customer_id = v_customer_id
      and e.status = 'posted';
    get diagnostics v_n = row_count;
    v_credit := v_credit + v_n;
    perform public.reallocate_credit_settlements(v_customer_id);
  end loop;

  delete from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and e.status = 'cancelled';

  delete from public.expenses x
  where x.date = p_date
    and x.shift = v_shift
    and x.employee_id is not null;
  get diagnostics v_expense = row_count;

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'deleted_credit', v_credit,
    'deleted_expenses', v_expense,
    'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzles and cash, delete shift credit sales, delete shift expenses, and refresh dsr_* meters.';

comment on column public.credit_entries.status is
  'posted, or cancelled only for a leftover row from before admin delete removed the record. Cancelled rows stay out of balances until an admin deletes them.';

comment on column public.credit_payments.status is
  'posted, or cancelled only for a leftover row from before admin delete removed the record. Cancelled payments stay out of balances until an admin deletes them.';
