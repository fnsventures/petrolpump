-- Book expenses (expenses.html) and the daily meter sheet (meter-reading.html) wrote their
-- tables straight from the browser. Triggers and RLS already guarded those writes, but the
-- rules were split between the client and the policies, and "today" was the browser's date.
-- These two RPCs put each write's rules in one place, as add_shift_expense and
-- save_meter_shift_readings already do for the shift register:
--
--   add_expense         one book expense (no staff or shift). Retry-safe with p_request_id.
--   save_dsr_meter_row  insert or update the day's dsr_petrol / dsr_diesel row.
--
-- The table policies and grants stay for now. The live frontend still writes directly until
-- this release reaches it (migrations are applied before main is merged). A later migration
-- can revoke insert/update on expenses, dsr_petrol and dsr_diesel from authenticated.

-- ─── add_expense ─────────────────────────────────────────────────────────────

create or replace function public.add_expense(
  p_date date,
  p_category text,
  p_amount numeric,
  p_description text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_expense');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Expense date cannot be in the future';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;

  v_category := nullif(btrim(coalesce(p_category, '')), '');
  if v_category is null then
    raise exception 'category is required';
  end if;
  if lower(v_category) = 'salary' then
    raise exception 'Salary is recorded on the Salary page, not as an expense';
  end if;
  if not exists (select 1 from public.expense_categories c where c.name = v_category) then
    raise exception 'Unknown expense category';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  insert into public.expenses (date, category, description, amount, created_by, client_request_id)
  values (
    p_date,
    v_category,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_amount,
    auth.uid(),
    p_request_id
  )
  returning id into v_id;

  v_out := jsonb_build_object('id', v_id, 'date', p_date, 'amount', p_amount, 'category', v_category);
  perform public.write_request_store(p_request_id, 'add_expense', v_out);
  return v_out;
end;
$$;

comment on function public.add_expense(date, text, numeric, text, uuid) is
  'Book expense (no staff or shift) from the Expenses page. Rejects salary, unknown categories, a non-positive amount, a certified day and future dates (IST). Retry-safe with p_request_id.';

revoke all on function public.add_expense(date, text, numeric, text, uuid) from public, anon;
grant execute on function public.add_expense(date, text, numeric, text, uuid) to authenticated;

-- ─── save_dsr_meter_row ──────────────────────────────────────────────────────

create or replace function public.save_dsr_meter_row(
  p_product text,
  p_date date,
  p_row jsonb,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_product text := lower(btrim(coalesce(p_product, '')));
  v_table text;
  v_rate_col text;
  v_cols text[];
  v_patch jsonb;
  v_col_list text;
  v_existing jsonb;
  v_saved jsonb;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'save_dsr_meter_row');
  if v_replay is not null then
    return v_replay;
  end if;

  if v_product not in ('petrol', 'diesel') then
    raise exception 'Product must be petrol or diesel';
  end if;
  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Meter date cannot be in the future';
  end if;
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'Meter row must be a JSON object';
  end if;

  v_table := 'dsr_' || v_product;
  v_rate_col := v_product || '_rate';

  -- Columns the daily sheet may write. Purchase cost and invoice links have their own RPC.
  v_cols := array[
    'opening_pump1_nozzle1', 'opening_pump1_nozzle2', 'opening_pump2_nozzle1', 'opening_pump2_nozzle2',
    'closing_pump1_nozzle1', 'closing_pump1_nozzle2', 'closing_pump2_nozzle1', 'closing_pump2_nozzle2',
    'sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'dip_reading', 'stock', 'receipts',
    v_rate_col, 'remarks'
  ];

  select jsonb_object_agg(e.key, e.value)
  into v_patch
  from jsonb_each(p_row) e
  where e.key = any(v_cols);

  if v_patch is null then
    raise exception 'No meter fields to save';
  end if;

  select string_agg(quote_ident(k), ', ') into v_col_list from jsonb_object_keys(v_patch) k;

  -- Same lock as the dsr_* insert/update policies.
  perform public.require_meter_day_writable(p_date);

  -- One writer per product and date; the second waits, then sees the first one's row.
  perform pg_advisory_xact_lock(hashtextextended('dsr_meter_row:' || v_table || ':' || p_date::text, 0));

  execute format('select to_jsonb(t) from public.%I t where t.date = $1 for update', v_table)
  into v_existing
  using p_date;

  if v_existing is not null then
    if not public.is_admin() and public.dsr_meter_row_is_complete(
      (v_existing->>v_rate_col)::numeric,
      (v_existing->>'dip_reading')::numeric,
      (v_existing->>'stock')::numeric,
      (v_existing->>'receipts')::numeric
    ) then
      raise exception
        'Meter readings for % are already saved. Only an admin can change them.', p_date;
    end if;

    execute format(
      'update public.%1$I t set (%2$s) = (select %2$s from jsonb_populate_record(t, $2)) '
      'where t.id = $1 returning to_jsonb(t)',
      v_table, v_col_list
    )
    into v_saved
    using (v_existing->>'id')::uuid, v_patch;
  else
    execute format(
      'insert into public.%1$I (date, created_by, %2$s) '
      'select $1, $3, %2$s from jsonb_populate_record(null::public.%1$I, $2) '
      'returning to_jsonb(%1$I)',
      v_table, v_col_list
    )
    into v_saved
    using p_date, v_patch, auth.uid();
  end if;

  -- A rate alone must not finish the day: require rate plus dip or stock.
  if not public.dsr_meter_row_is_complete(
    (v_saved->>v_rate_col)::numeric,
    (v_saved->>'dip_reading')::numeric,
    (v_saved->>'stock')::numeric,
    (v_saved->>'receipts')::numeric
  ) then
    raise exception 'Enter selling rate and dip reading or dip stock (L) before saving.';
  end if;

  v_out := jsonb_build_object(
    'id', v_saved->>'id',
    'product', v_product,
    'date', p_date,
    'created', v_existing is null
  );
  perform public.write_request_store(p_request_id, 'save_dsr_meter_row', v_out);
  return v_out;
end;
$$;

comment on function public.save_dsr_meter_row(text, date, jsonb, uuid) is
  'Daily meter sheet: insert or update the dsr_petrol / dsr_diesel row for a date. Writes only meter, stock, rate and remarks columns. Non-admins cannot change a locked day or a finished row. Requires rate plus dip or stock. Rejects future dates (IST); dsr_validate_meter_row still checks meters, rate and certification. Retry-safe with p_request_id.';

revoke all on function public.save_dsr_meter_row(text, date, jsonb, uuid) from public, anon;
grant execute on function public.save_dsr_meter_row(text, date, jsonb, uuid) to authenticated;
