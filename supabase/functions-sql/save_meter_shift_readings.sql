-- Canonical definition of public.save_meter_shift_readings. Edit here, then:
--   node scripts/sql-functions.mjs emit save_meter_shift_readings
create or replace function public.save_meter_shift_readings(
  p_date date,
  p_shift text,
  p_nozzles jsonb,
  p_cash jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_shift text;
  v_row jsonb;
  v_product text;
  v_pump smallint;
  v_nozzle smallint;
  v_employee uuid;
  v_opening numeric;
  v_closing numeric;
  v_testing numeric;
  v_remarks text;
  v_cash_amt numeric;
  v_phone_pay numeric;
  v_kept_nozzles int := 0;
  v_kept_cash int := 0;
  v_keys text[] := array[]::text[];
  v_emp_ids uuid[] := array[]::uuid[];
  v_existing_count int;
  v_morning_close numeric;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  perform public.require_meter_shift_writable(p_date, v_shift);

  if p_nozzles is null or jsonb_typeof(p_nozzles) <> 'array' then
    raise exception 'Nozzles payload must be a JSON array';
  end if;

  if p_cash is null then
    p_cash := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_cash) <> 'array' then
    raise exception 'Cash payload must be a JSON array';
  end if;

  select count(*)::int into v_existing_count
  from public.meter_shift_readings r
  where r.reading_date = p_date and r.shift = v_shift;

  for v_row in
    select value from jsonb_array_elements(p_nozzles)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    v_product := lower(btrim(coalesce(v_row->>'product', '')));
    if v_product not in ('petrol', 'diesel') then
      raise exception 'Invalid product in nozzle row';
    end if;

    v_pump := (v_row->>'pump_no')::smallint;
    v_nozzle := (v_row->>'nozzle_no')::smallint;
    if v_pump is null or v_nozzle is null
       or v_pump < 1 or v_pump > 8
       or v_nozzle < 1 or v_nozzle > 8 then
      raise exception 'Invalid pump/nozzle in nozzle row';
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Staff is inactive or missing';
    end if;

    v_opening := coalesce((v_row->>'opening_meter')::numeric, 0);
    v_closing := coalesce((v_row->>'closing_meter')::numeric, 0);
    v_testing := coalesce((v_row->>'testing_litres')::numeric, 0);
    if v_opening < 0 or v_closing < 0 or v_testing < 0 then
      raise exception 'Meter and testing values must be >= 0';
    end if;
    if v_closing < v_opening then
      raise exception 'Closing meter must be >= opening meter (P% · N%)', v_pump, v_nozzle;
    end if;
    if v_testing > (v_closing - v_opening) then
      raise exception 'Testing cannot exceed sale litres (P% · N%)', v_pump, v_nozzle;
    end if;

    if v_shift = 'afternoon' then
      select m.closing_meter into v_morning_close
      from public.meter_shift_readings m
      where m.reading_date = p_date
        and m.shift = 'morning'
        and m.product = v_product
        and m.pump_no = v_pump
        and m.nozzle_no = v_nozzle;
      if found and v_morning_close is not null
         and abs(v_opening - v_morning_close) > 0.001 then
        raise exception
          'Afternoon opening for % P%·N% (%) must match morning closing (%)',
          v_product, v_pump, v_nozzle, v_opening, v_morning_close;
      end if;
    end if;

    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_readings (
      reading_date, product, shift, employee_id,
      pump_no, nozzle_no, opening_meter, closing_meter, testing_litres,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_product, v_shift, v_employee,
      v_pump, v_nozzle, v_opening, v_closing, v_testing,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, product, shift, pump_no, nozzle_no)
    do update set
      employee_id = excluded.employee_id,
      opening_meter = excluded.opening_meter,
      closing_meter = excluded.closing_meter,
      testing_litres = excluded.testing_litres,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now())
    where (
      meter_shift_readings.employee_id, meter_shift_readings.opening_meter,
      meter_shift_readings.closing_meter, meter_shift_readings.testing_litres,
      meter_shift_readings.remarks
    ) is distinct from (
      excluded.employee_id, excluded.opening_meter,
      excluded.closing_meter, excluded.testing_litres,
      excluded.remarks
    );

    v_keys := array_append(v_keys, v_product || ':' || v_pump::text || ':' || v_nozzle::text);
    v_kept_nozzles := v_kept_nozzles + 1;
  end loop;

  if v_kept_nozzles = 0 and coalesce(v_existing_count, 0) > 0 then
    raise exception
      'Assign at least one nozzle, or use Clear shift to delete existing readings';
  end if;

  delete from public.meter_shift_readings r
  where r.reading_date = p_date
    and r.shift = v_shift
    and not (
      (r.product || ':' || r.pump_no::text || ':' || r.nozzle_no::text) = any (v_keys)
    );

  -- Morning re-save: keep afternoon openings in handoff with morning closings.
  if v_shift = 'morning' then
    if exists (
      select 1
      from public.meter_shift_readings m
      join public.meter_shift_readings a
        on a.reading_date = m.reading_date
       and a.product = m.product
       and a.pump_no = m.pump_no
       and a.nozzle_no = m.nozzle_no
       and a.shift = 'afternoon'
      where m.reading_date = p_date
        and m.shift = 'morning'
        and a.closing_meter < m.closing_meter - 0.001
    ) then
      raise exception
        'Cannot update morning: afternoon closing is below the new morning closing on one or more nozzles. Fix afternoon first.';
    end if;

    update public.meter_shift_readings a
    set
      opening_meter = m.closing_meter,
      testing_litres = least(
        a.testing_litres,
        greatest(a.closing_meter - m.closing_meter, 0)
      ),
      updated_at = timezone('utc'::text, now())
    from public.meter_shift_readings m
    where m.reading_date = p_date
      and m.shift = 'morning'
      and a.reading_date = m.reading_date
      and a.shift = 'afternoon'
      and a.product = m.product
      and a.pump_no = m.pump_no
      and a.nozzle_no = m.nozzle_no
      and (
        abs(a.opening_meter - m.closing_meter) > 0.001
        or a.testing_litres > greatest(a.closing_meter - m.closing_meter, 0) + 0.001
      );
  end if;

  for v_row in
    select value from jsonb_array_elements(p_cash)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Cash row references inactive or unknown staff';
    end if;

    v_cash_amt := coalesce((v_row->>'cash_collected')::numeric, 0);
    v_phone_pay := coalesce((v_row->>'phone_pay')::numeric, 0);
    if v_cash_amt < 0 then
      raise exception 'Cash collected must be >= 0';
    end if;
    if v_phone_pay < 0 then
      raise exception 'Phone pay must be >= 0';
    end if;
    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_cash (
      reading_date, shift, employee_id,
      cash_collected, phone_pay, credit_amount, expense_amount,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_shift, v_employee,
      v_cash_amt, v_phone_pay, 0, 0,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, shift, employee_id)
    do update set
      cash_collected = excluded.cash_collected,
      phone_pay = excluded.phone_pay,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now())
    where (
      meter_shift_cash.cash_collected, meter_shift_cash.phone_pay, meter_shift_cash.remarks
    ) is distinct from (
      excluded.cash_collected, excluded.phone_pay, excluded.remarks
    );

    v_emp_ids := array_append(v_emp_ids, v_employee);
    v_kept_cash := v_kept_cash + 1;
  end loop;

  foreach v_employee in array v_emp_ids
  loop
    perform public.sync_meter_shift_cash_ledger_totals(p_date, v_shift, v_employee);
  end loop;

  delete from public.meter_shift_cash c
  where c.reading_date = p_date
    and c.shift = v_shift
    and not (c.employee_id = any (v_emp_ids))
    and not exists (
      select 1 from public.meter_shift_readings r
      where r.reading_date = c.reading_date
        and r.shift = c.shift
        and r.employee_id = c.employee_id
    )
    and not exists (
      select 1 from public.credit_entries e
      where e.transaction_date = c.reading_date
        and e.shift = c.shift
        and e.employee_id = c.employee_id
    )
    and not exists (
      select 1 from public.expenses x
      where x.date = c.reading_date
        and x.shift = c.shift
        and x.employee_id = c.employee_id
    );

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return public.get_meter_shift_readings(p_date, v_shift)
    || jsonb_build_object(
      'saved_nozzles', v_kept_nozzles,
      'saved_cash', v_kept_cash,
      'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
    );
end;
$$;

comment on function public.save_meter_shift_readings(date, text, jsonb, jsonb) is
  'Upsert shift nozzle + cash/phone; credit/expense cached from ledger. Push meters into dsr_*. Rows whose values are unchanged are not rewritten.';
