-- Expense writes share ledger_guard_certified_day with credit sales and payments.
-- The cancelled-row shortcut read old.status in the same AND as the table check.
-- Postgres does not guarantee that AND is evaluated left to right, so an expense
-- insert (no status column) failed with: record "old" has no field "status".

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
  -- status is read in a nested IF: expenses has no status column, and a single
  -- AND expression can evaluate old.status before the table name is checked.
  if tg_op = 'DELETE'
     and tg_table_name in ('credit_entries', 'credit_payments')
  then
    if old.status = 'cancelled' then
      return null;
    end if;
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
  'Trigger: reject expenses, credit sales and payments on a certified day, then refresh an uncertified saved closing. A delete of an already-cancelled credit sale or payment is allowed.';
