-- Canonical definition of public.tanker_decantations_guard. Edit here, then:
--   node scripts/sql-functions.mjs emit tanker_decantations_guard
create or replace function public.tanker_decantations_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := timezone('utc'::text, now());
  new.invoice_no := nullif(btrim(coalesce(new.invoice_no, '')), '');
  new.truck_no := nullif(upper(btrim(coalesce(new.truck_no, ''))), '');
  new.remarks := nullif(btrim(coalesce(new.remarks, '')), '');

  if new.decant_date > public.meter_station_today() then
    raise exception 'Decantation date cannot be in the future.';
  end if;

  -- Same lock as the daily meter sheet: once the day is certified or its night cash collected,
  -- only an admin may change the stock that day's variance is computed from.
  if not coalesce(public.is_admin(), true) then
    foreach v_date in array array[new.decant_date, case when tg_op = 'UPDATE' then old.decant_date end] loop
      if v_date is not null and public.meter_day_is_locked(v_date) then
        raise exception 'Meters for % are locked (day certified or night cash collected). Ask an admin.', v_date;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.tanker_decantations_guard() from public, anon;
