-- Canonical definition of public.expenses_guard_amount. Edit here, then:
--   node scripts/sql-functions.mjs emit expenses_guard_amount
create or replace function public.expenses_guard_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Leave a historical non-positive amount untouched when the update changes other columns.
  if tg_op = 'UPDATE' and new.amount is not distinct from old.amount then
    return new;
  end if;
  if new.amount is null or new.amount <= 0 then
    raise exception using errcode = 'check_violation',
      message = 'Amount must be greater than 0.';
  end if;
  return new;
end;
$$;

comment on function public.expenses_guard_amount() is
  'Trigger: reject a new expense amount that is not greater than 0. An update that leaves a historical non-positive amount unchanged is allowed.';

revoke all on function public.expenses_guard_amount() from public, anon;

grant execute on function public.expenses_guard_amount() to authenticated;
