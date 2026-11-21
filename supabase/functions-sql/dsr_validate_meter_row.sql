-- Canonical definition of public.dsr_validate_meter_row. Edit here, then:
--   node scripts/sql-functions.mjs emit dsr_validate_meter_row
create or replace function public.dsr_validate_meter_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_label text := case when tg_table_name = 'dsr_petrol' then 'MS' else 'HSD' end;
  v_product text := case when tg_table_name = 'dsr_petrol' then 'petrol' else 'diesel' end;
  v_open numeric;
  v_close numeric;
  v_key text;
  v_pump int;
  v_nozzle int;
  v_sales1 numeric := 0;
  v_sales2 numeric := 0;
  v_prev_o1 numeric;
  v_prev_o2 numeric;
  v_prev_o3 numeric;
  v_prev_o4 numeric;
  v_prev_rate numeric;
  v_rate numeric;
  v_expected numeric;
  v_rate_text text;
  v_meters_changed boolean := tg_op = 'INSERT';
  v_rate_changed boolean := tg_op = 'INSERT';
  v_keys constant text[] := array[
    'opening_pump1_nozzle1', 'opening_pump1_nozzle2', 'opening_pump2_nozzle1', 'opening_pump2_nozzle2',
    'closing_pump1_nozzle1', 'closing_pump1_nozzle2', 'closing_pump2_nozzle1', 'closing_pump2_nozzle2',
    'sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'stock', 'receipts'
  ];
begin
  if tg_op = 'DELETE' then
    perform public.raise_if_day_closing_certified(old.date);
    return old;
  end if;

  v_new := to_jsonb(new);
  perform public.raise_if_day_closing_certified(new.date);
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    perform public.raise_if_day_closing_certified(old.date);
  end if;

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_meters_changed := exists (select 1 from unnest(v_keys) k where v_new->k is distinct from v_old->k);
    if tg_table_name = 'dsr_petrol' then
      v_rate_changed := new.petrol_rate is distinct from old.petrol_rate;
    else
      v_rate_changed := new.diesel_rate is distinct from old.diesel_rate;
    end if;
    if not v_meters_changed and not v_rate_changed then
      return new;
    end if;
  end if;

  if v_meters_changed then
    for v_pump in 1..2 loop
      for v_nozzle in 1..2 loop
        v_open := (v_new->>format('opening_pump%s_nozzle%s', v_pump, v_nozzle))::numeric;
        v_close := (v_new->>format('closing_pump%s_nozzle%s', v_pump, v_nozzle))::numeric;
        if v_open < 0 or v_close < 0 then
          raise exception using errcode = 'check_violation',
            message = format('%s meter readings must be >= 0 (Pump %s · Nozzle %s).', v_label, v_pump, v_nozzle);
        end if;
        if v_close < v_open then
          raise exception using errcode = 'check_violation',
            message = format('%s closing must be >= opening for Pump %s · Nozzle %s.', v_label, v_pump, v_nozzle);
        end if;
      end loop;
    end loop;

    v_sales1 :=
      ((v_new->>'closing_pump1_nozzle1')::numeric - (v_new->>'opening_pump1_nozzle1')::numeric)
      + ((v_new->>'closing_pump1_nozzle2')::numeric - (v_new->>'opening_pump1_nozzle2')::numeric);
    v_sales2 :=
      ((v_new->>'closing_pump2_nozzle1')::numeric - (v_new->>'opening_pump2_nozzle1')::numeric)
      + ((v_new->>'closing_pump2_nozzle2')::numeric - (v_new->>'opening_pump2_nozzle2')::numeric);
    new.sales_pump1 := v_sales1;
    new.sales_pump2 := v_sales2;
    new.total_sales := v_sales1 + v_sales2;

    foreach v_key in array array['sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'stock', 'receipts'] loop
      if (to_jsonb(new)->>v_key)::numeric < 0 then
        raise exception using errcode = 'check_violation',
          message = format('%s %s cannot be negative.', v_label, replace(v_key, '_', ' '));
      end if;
    end loop;

    if new.testing > new.total_sales then
      raise exception using errcode = 'check_violation',
        message = format('%s testing cannot exceed total sales.', v_label);
    end if;

    if tg_table_name = 'dsr_petrol' then
      select p.closing_pump1_nozzle1, p.closing_pump1_nozzle2, p.closing_pump2_nozzle1, p.closing_pump2_nozzle2
      into v_prev_o1, v_prev_o2, v_prev_o3, v_prev_o4
      from public.dsr_petrol p
      where p.date < new.date
      order by p.date desc
      limit 1;
    else
      select d.closing_pump1_nozzle1, d.closing_pump1_nozzle2, d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
      into v_prev_o1, v_prev_o2, v_prev_o3, v_prev_o4
      from public.dsr_diesel d
      where d.date < new.date
      order by d.date desc
      limit 1;
    end if;

    if found and not public.is_admin() and (
      abs(new.opening_pump1_nozzle1 - v_prev_o1) > 0.001
      or abs(new.opening_pump1_nozzle2 - v_prev_o2) > 0.001
      or abs(new.opening_pump2_nozzle1 - v_prev_o3) > 0.001
      or abs(new.opening_pump2_nozzle2 - v_prev_o4) > 0.001
    ) then
      raise exception using errcode = 'check_violation',
        message = format('%s opening must match the previous closing. An admin can record a meter rollover.', v_label);
    end if;
  end if;

  if v_rate_changed or v_meters_changed then
    if tg_table_name = 'dsr_petrol' then
      v_rate := new.petrol_rate;
      select p.petrol_rate into v_prev_rate
      from public.dsr_petrol p
      where p.date < new.date and p.petrol_rate is not null
      order by p.date desc
      limit 1;
    else
      v_rate := new.diesel_rate;
      select d.diesel_rate into v_prev_rate
      from public.dsr_diesel d
      where d.date < new.date and d.diesel_rate is not null
      order by d.date desc
      limit 1;
    end if;

    select s.config #>> array['rates', v_product] into v_rate_text
    from public.pump_settings s
    where s.id = 1;
    if v_rate_text ~ '^[0-9]+(\.[0-9]+)?$' then
      v_expected := v_rate_text::numeric;
    else
      v_expected := v_prev_rate;
    end if;

    if v_rate_changed and coalesce(v_rate, 0) <= 0 then
      raise exception using errcode = 'check_violation',
        message = format('%s selling rate is required.', v_label);
    end if;
    if coalesce(v_rate, 0) > 0 and v_expected is not null and abs(v_rate - v_expected) > 0.009 and not public.is_admin() then
      raise exception using errcode = 'check_violation',
        message = format('%s rate must match the configured price (%s). An admin can change the price.', v_label, v_expected);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.dsr_validate_meter_row() is
  'Trigger: reject a certified day, calculate nozzle sales, require opening to match the previous closing unless an admin records a rollover, and require the selling rate to match the configured price unless an admin changes it.';

revoke all on function public.dsr_validate_meter_row() from public, anon;

grant execute on function public.dsr_validate_meter_row() to authenticated;
