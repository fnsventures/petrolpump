-- Canonical definition of public.trg_sync_shift_cash_from_expenses. Edit here, then:
--   node scripts/sql-functions.mjs emit trg_sync_shift_cash_from_expenses
create or replace function public.trg_sync_shift_cash_from_expenses()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;
