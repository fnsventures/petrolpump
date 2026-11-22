-- Canonical definition of public.expenses_guard_shift_write. Edit here, then:
--   node scripts/sql-functions.mjs emit expenses_guard_shift_write
create or replace function public.expenses_guard_shift_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.shift is not null then
      perform public.require_meter_shift_writable(old.date, old.shift);
    end if;
    return old;
  end if;

  if new.shift is not null then
    perform public.require_meter_shift_writable(new.date, new.shift);
  end if;

  if tg_op = 'UPDATE'
     and old.shift is not null
     and (old.date is distinct from new.date or old.shift is distinct from new.shift) then
    perform public.require_meter_shift_writable(old.date, old.shift);
  end if;

  return new;
end;
$$;

comment on function public.expenses_guard_shift_write() is
  'Trigger: a shift-attributed expense insert, update, or delete uses the same lock as the shift register. Supervisors are blocked once day closing is saved, or the day is certified or night cash is collected. Book expenses (no shift) are unchanged.';

revoke all on function public.expenses_guard_shift_write() from public, anon;

grant execute on function public.expenses_guard_shift_write() to authenticated;
