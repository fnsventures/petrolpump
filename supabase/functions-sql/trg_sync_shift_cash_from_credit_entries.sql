-- Canonical definition of public.trg_sync_shift_cash_from_credit_entries. Edit here, then:
--   node scripts/sql-functions.mjs emit trg_sync_shift_cash_from_credit_entries
create or replace function public.trg_sync_shift_cash_from_credit_entries()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.transaction_date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.transaction_date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
       or old.status is distinct from new.status
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.transaction_date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
       or old.status is distinct from new.status
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.transaction_date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;
