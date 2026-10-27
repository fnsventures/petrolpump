-- Stop writes (and audit rows) for edits that change nothing, and shrink
-- UPDATE audit rows to the fields that changed.
--
-- audit_trigger_fn: an UPDATE stores only the changed columns (old values in
--   old_data, new values in new_data). updated_at alone does not count as a
--   change, so a touch-only update writes no audit row. INSERT and DELETE
--   still store the full row.
-- recascade_day_closing_short_from: skip later days whose totals are unchanged
--   (it used to rewrite every later day on each edit).
-- save_meter_shift_readings / sync_meter_shift_cash_ledger_totals /
--   apply_shift_aggregate_to_dsr: upserts and updates only touch rows whose
--   values differ, the same filter meter_shift_cash's audit trigger uses.
-- audit_log_record_idx: dropped. No app code reads audit_log; recovery and the
--   purge use (table_name, performed_at) and performed_at.

create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if coalesce(current_setting('app.force_audit', true), '') is distinct from 'true' then
    if coalesce(current_setting('app.skip_credit_audit', true), '') = 'true' then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    elsif exists (
      select 1 from public.runtime_flags
      where key = 'audit' and value = 'off'
    ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (tg_table_name, old.id, tg_op, to_jsonb(old), auth.uid(), auth.jwt() ->> 'email');
    return old;
  elsif tg_op = 'UPDATE' then
    select
      jsonb_object_agg(n.key, o.value),
      jsonb_object_agg(n.key, n.value)
    into v_old, v_new
    from jsonb_each(to_jsonb(new)) n
    left join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.key <> 'updated_at'
      and o.value is distinct from n.value;

    if v_new is null then
      return new;
    end if;

    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, v_old, v_new, auth.uid(), auth.jwt() ->> 'email');
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (tg_table_name, new.id, tg_op, to_jsonb(new), auth.uid(), auth.jwt() ->> 'email');
    return new;
  end if;
  return null;
end;
$$;

comment on function public.audit_trigger_fn() is
  'Writes audit_log unless runtime_flags.audit is off (staging). UPDATE rows hold only changed columns; an update that changes nothing but updated_at is not logged.';

drop index if exists public.audit_log_record_idx;

create or replace function public.recascade_day_closing_short_from(p_from_date date)
returns void
language plpgsql security definer
as $$
declare
  v_row record;
  v_components jsonb;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
begin
  for v_row in
    select date, night_cash, phone_pay, certified,
           total_sale, collection, short_previous, credit_today, expenses_today, short_today
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    if coalesce(v_row.certified, false) then
      continue;
    end if;

    v_components := public.compute_day_closing_components(v_row.date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
    v_short_today := (v_total_sale + v_collection + v_short_previous)
      - (v_row.night_cash + v_row.phone_pay + v_credit_today + v_expenses_today);

    -- Columns are numeric(14,2) and round on store; compare at that scale.
    if v_row.total_sale is not distinct from round(v_total_sale, 2)
       and v_row.collection is not distinct from round(v_collection, 2)
       and v_row.short_previous is not distinct from round(v_short_previous, 2)
       and v_row.credit_today is not distinct from round(v_credit_today, 2)
       and v_row.expenses_today is not distinct from round(v_expenses_today, 2)
       and v_row.short_today is not distinct from round(v_short_today, 2)
    then
      continue;
    end if;

    update public.day_closing set
      total_sale = v_total_sale,
      collection = v_collection,
      short_previous = v_short_previous,
      credit_today = v_credit_today,
      expenses_today = v_expenses_today,
      short_today = v_short_today
    where date = v_row.date;
  end loop;
end;
$$;

comment on function public.recascade_day_closing_short_from(date) is
  'After a day closing overwrite, recalculate short chain for later uncertified dates. Certified later days stay frozen. Days whose totals are unchanged are not rewritten.';

create or replace function public.sync_meter_shift_cash_ledger_totals(
  p_date date,
  p_shift text,
  p_employee_id uuid
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text := lower(btrim(coalesce(p_shift, '')));
  v_credit numeric := 0;
  v_expense numeric := 0;
begin
  perform public.require_staff_access();

  if p_date is null or p_employee_id is null or v_shift not in ('morning', 'afternoon') then
    return;
  end if;

  select
    coalesce((
      select sum(ce.amount)
      from public.credit_entries ce
      where ce.transaction_date = p_date
        and ce.shift = v_shift
        and ce.employee_id = p_employee_id
        and ce.status = 'posted'
    ), 0),
    coalesce((
      select sum(ex.amount)
      from public.expenses ex
      where ex.date = p_date
        and ex.shift = v_shift
        and ex.employee_id = p_employee_id
    ), 0)
  into v_credit, v_expense;

  insert into public.meter_shift_cash (
    reading_date, shift, employee_id,
    cash_collected, phone_pay, credit_amount, expense_amount,
    updated_at
  )
  values (
    p_date, v_shift, p_employee_id,
    0, 0, v_credit, v_expense,
    timezone('utc'::text, now())
  )
  on conflict (reading_date, shift, employee_id)
  do update set
    credit_amount = excluded.credit_amount,
    expense_amount = excluded.expense_amount,
    updated_at = timezone('utc'::text, now())
  where meter_shift_cash.credit_amount is distinct from excluded.credit_amount
     or meter_shift_cash.expense_amount is distinct from excluded.expense_amount;
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows. Provisioned staff only. Unchanged totals are not rewritten.';

create or replace function public.apply_shift_aggregate_to_dsr(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agg jsonb;
  v_block jsonb;
  v_updated text[] := array[]::text[];
  v_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  if public.meter_day_is_locked(p_date) and not public.is_admin() then
    return jsonb_build_object(
      'date', p_date,
      'updated', '[]'::jsonb,
      'skipped_locked', true
    );
  end if;

  v_agg := public.get_shift_aggregated_daily_meters(p_date);

  -- 'updated' lists sheets that now match the shift rollup, written or already in sync.
  v_block := v_agg->'petrol';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select p.id into v_id
    from public.dsr_petrol p
    where p.date = p_date
    order by p.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_petrol p set
        opening_pump1_nozzle1 = s.opening_pump1_nozzle1,
        opening_pump1_nozzle2 = s.opening_pump1_nozzle2,
        opening_pump2_nozzle1 = s.opening_pump2_nozzle1,
        opening_pump2_nozzle2 = s.opening_pump2_nozzle2,
        closing_pump1_nozzle1 = s.closing_pump1_nozzle1,
        closing_pump1_nozzle2 = s.closing_pump1_nozzle2,
        closing_pump2_nozzle1 = s.closing_pump2_nozzle1,
        closing_pump2_nozzle2 = s.closing_pump2_nozzle2,
        sales_pump1 = s.sales_pump1,
        sales_pump2 = s.sales_pump2,
        total_sales = s.total_sales,
        testing = s.testing
      from (
        select
          coalesce((v_block->>'opening_pump1_nozzle1')::numeric, x.opening_pump1_nozzle1) as opening_pump1_nozzle1,
          coalesce((v_block->>'opening_pump1_nozzle2')::numeric, x.opening_pump1_nozzle2) as opening_pump1_nozzle2,
          coalesce((v_block->>'opening_pump2_nozzle1')::numeric, x.opening_pump2_nozzle1) as opening_pump2_nozzle1,
          coalesce((v_block->>'opening_pump2_nozzle2')::numeric, x.opening_pump2_nozzle2) as opening_pump2_nozzle2,
          coalesce((v_block->>'closing_pump1_nozzle1')::numeric, x.closing_pump1_nozzle1) as closing_pump1_nozzle1,
          coalesce((v_block->>'closing_pump1_nozzle2')::numeric, x.closing_pump1_nozzle2) as closing_pump1_nozzle2,
          coalesce((v_block->>'closing_pump2_nozzle1')::numeric, x.closing_pump2_nozzle1) as closing_pump2_nozzle1,
          coalesce((v_block->>'closing_pump2_nozzle2')::numeric, x.closing_pump2_nozzle2) as closing_pump2_nozzle2,
          coalesce((v_block->>'sales_pump1')::numeric, 0) as sales_pump1,
          coalesce((v_block->>'sales_pump2')::numeric, 0) as sales_pump2,
          coalesce((v_block->>'total_sales')::numeric, 0) as total_sales,
          coalesce((v_block->>'testing')::numeric, 0) as testing
        from public.dsr_petrol x
        where x.id = v_id
      ) s
      where p.id = v_id
        and (
          p.opening_pump1_nozzle1, p.opening_pump1_nozzle2, p.opening_pump2_nozzle1, p.opening_pump2_nozzle2,
          p.closing_pump1_nozzle1, p.closing_pump1_nozzle2, p.closing_pump2_nozzle1, p.closing_pump2_nozzle2,
          p.sales_pump1, p.sales_pump2, p.total_sales, p.testing
        ) is distinct from (
          s.opening_pump1_nozzle1, s.opening_pump1_nozzle2, s.opening_pump2_nozzle1, s.opening_pump2_nozzle2,
          s.closing_pump1_nozzle1, s.closing_pump1_nozzle2, s.closing_pump2_nozzle1, s.closing_pump2_nozzle2,
          s.sales_pump1, s.sales_pump2, s.total_sales, s.testing
        );
      v_updated := array_append(v_updated, 'petrol');
    end if;
  end if;

  v_block := v_agg->'diesel';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select d.id into v_id
    from public.dsr_diesel d
    where d.date = p_date
    order by d.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_diesel d set
        opening_pump1_nozzle1 = s.opening_pump1_nozzle1,
        opening_pump1_nozzle2 = s.opening_pump1_nozzle2,
        opening_pump2_nozzle1 = s.opening_pump2_nozzle1,
        opening_pump2_nozzle2 = s.opening_pump2_nozzle2,
        closing_pump1_nozzle1 = s.closing_pump1_nozzle1,
        closing_pump1_nozzle2 = s.closing_pump1_nozzle2,
        closing_pump2_nozzle1 = s.closing_pump2_nozzle1,
        closing_pump2_nozzle2 = s.closing_pump2_nozzle2,
        sales_pump1 = s.sales_pump1,
        sales_pump2 = s.sales_pump2,
        total_sales = s.total_sales,
        testing = s.testing
      from (
        select
          coalesce((v_block->>'opening_pump1_nozzle1')::numeric, x.opening_pump1_nozzle1) as opening_pump1_nozzle1,
          coalesce((v_block->>'opening_pump1_nozzle2')::numeric, x.opening_pump1_nozzle2) as opening_pump1_nozzle2,
          coalesce((v_block->>'opening_pump2_nozzle1')::numeric, x.opening_pump2_nozzle1) as opening_pump2_nozzle1,
          coalesce((v_block->>'opening_pump2_nozzle2')::numeric, x.opening_pump2_nozzle2) as opening_pump2_nozzle2,
          coalesce((v_block->>'closing_pump1_nozzle1')::numeric, x.closing_pump1_nozzle1) as closing_pump1_nozzle1,
          coalesce((v_block->>'closing_pump1_nozzle2')::numeric, x.closing_pump1_nozzle2) as closing_pump1_nozzle2,
          coalesce((v_block->>'closing_pump2_nozzle1')::numeric, x.closing_pump2_nozzle1) as closing_pump2_nozzle1,
          coalesce((v_block->>'closing_pump2_nozzle2')::numeric, x.closing_pump2_nozzle2) as closing_pump2_nozzle2,
          coalesce((v_block->>'sales_pump1')::numeric, 0) as sales_pump1,
          coalesce((v_block->>'sales_pump2')::numeric, 0) as sales_pump2,
          coalesce((v_block->>'total_sales')::numeric, 0) as total_sales,
          coalesce((v_block->>'testing')::numeric, 0) as testing
        from public.dsr_diesel x
        where x.id = v_id
      ) s
      where d.id = v_id
        and (
          d.opening_pump1_nozzle1, d.opening_pump1_nozzle2, d.opening_pump2_nozzle1, d.opening_pump2_nozzle2,
          d.closing_pump1_nozzle1, d.closing_pump1_nozzle2, d.closing_pump2_nozzle1, d.closing_pump2_nozzle2,
          d.sales_pump1, d.sales_pump2, d.total_sales, d.testing
        ) is distinct from (
          s.opening_pump1_nozzle1, s.opening_pump1_nozzle2, s.opening_pump2_nozzle1, s.opening_pump2_nozzle2,
          s.closing_pump1_nozzle1, s.closing_pump1_nozzle2, s.closing_pump2_nozzle1, s.closing_pump2_nozzle2,
          s.sales_pump1, s.sales_pump2, s.total_sales, s.testing
        );
      v_updated := array_append(v_updated, 'diesel');
    end if;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'updated', to_jsonb(v_updated),
    'skipped_locked', false
  );
end;
$$;

comment on function public.apply_shift_aggregate_to_dsr(date) is
  'Update meter columns on existing dsr_* rows from shift rollup. Never inserts stubs; leaves dip/stock/rate/remarks alone. Rows already in sync are not rewritten.';

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
