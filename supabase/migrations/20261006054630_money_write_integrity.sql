-- Money-write integrity.
--
-- 1. Station "today" (IST) for future-date checks. current_date is UTC on Supabase, so entries
--    for today were rejected between 00:00 and 05:30 IST.
-- 2. Retry-safe writes: money RPCs take p_request_id. A retry with the same id returns the
--    first result instead of writing twice. Plain expense inserts carry client_request_id.
-- 3. Salary: payment + linked expense are written by one RPC; deleting a payment cascades to
--    its linked expense; the overpay check runs on the server under a per-employee lock.
-- 4. Daily meter rows (dsr_petrol / dsr_diesel): closing >= opening and non-negative values
--    are enforced in the database.
-- 5. save_invoice rejects non-positive quantity/rate, negative discount and discount above
--    subtotal. Invoices and their lines can only be written through save_invoice.
-- 6. Drops four pre-2026 RPC overloads that skip the current access checks.
-- 7. Credit sales and payments lock the customer row before reading prepaid or allocating
--    entries, the same lock batch settlement already takes.
-- 8. A certified day rejects ledger and meter changes. The money RPCs call
--    raise_if_day_closing_certified(); triggers cover direct inserts and then refresh
--    an uncertified saved closing.

-- ─── 1. Station date ────────────────────────────────────────────────────────

alter table public.invoices
  alter column invoice_date set default public.meter_station_today();
alter table public.letterhead_letters
  alter column letter_date set default public.meter_station_today();
alter table public.credit_customers
  alter column date set default public.meter_station_today();

-- ─── 2. Request ledger for retry-safe writes ────────────────────────────────

create table if not exists public.write_requests (
  request_id uuid primary key,
  kind text not null,
  created_by uuid,
  response jsonb not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists write_requests_created_at_idx
  on public.write_requests (created_at);

comment on table public.write_requests is
  'Results of money-writing RPCs keyed by the client request id. A retried request returns the stored result. Rows older than 14 days are pruned. Written only by write_request_store().';

alter table public.write_requests enable row level security;
revoke all on table public.write_requests from anon, authenticated;

create or replace function public.write_request_replay(p_request_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.write_requests%rowtype;
begin
  if p_request_id is null then
    return null;
  end if;

  -- Concurrent duplicates wait here until the first one commits, then replay its result.
  perform pg_advisory_xact_lock(hashtextextended('write_request:' || p_request_id::text, 0));

  select * into v_row from public.write_requests where request_id = p_request_id;
  if not found then
    return null;
  end if;
  if v_row.kind <> p_kind or v_row.created_by is distinct from auth.uid() then
    raise exception 'Request id already used for a different action';
  end if;
  return v_row.response;
end;
$$;

comment on function public.write_request_replay(uuid, text) is
  'Internal: stored result for a retried request id, or null. Locks the id until commit.';

create or replace function public.write_request_store(p_request_id uuid, p_kind text, p_response jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_request_id is null then
    return;
  end if;

  insert into public.write_requests (request_id, kind, created_by, response)
  values (p_request_id, p_kind, auth.uid(), p_response)
  on conflict (request_id) do nothing;

  delete from public.write_requests
  where created_at < timezone('utc'::text, now()) - interval '14 days';
end;
$$;

comment on function public.write_request_store(uuid, text, jsonb) is
  'Internal: remember the result of a request id (same transaction as the write).';

revoke all on function public.write_request_replay(uuid, text) from public, anon, authenticated;
revoke all on function public.write_request_store(uuid, text, jsonb) from public, anon, authenticated;

alter table public.expenses
  add column if not exists client_request_id uuid;

create unique index if not exists expenses_client_request_id_unique
  on public.expenses (client_request_id)
  where client_request_id is not null;

comment on column public.expenses.client_request_id is
  'Client-generated id for the Expenses form; a retried insert hits the unique index instead of duplicating.';

-- ─── Money RPCs: new signatures with p_request_id ───────────────────────────
-- Adding a parameter changes the signature, so drop the old ones first (an overload would
-- make PostgREST calls without p_request_id ambiguous).

drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text);
drop function if exists public.add_shift_expense(date, text, uuid, text, numeric, text);
drop function if exists public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean);
drop function if exists public.record_credit_payment(uuid, date, numeric, text, text, boolean);
drop function if exists public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb);

create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null,
  p_mobile text default null,
  p_address text default null,
  p_employee_id uuid default null,
  p_shift text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
  v_remaining numeric;
  v_entry record;
  v_alloc numeric;
  v_prepaid numeric;
  v_shift text;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_credit_entry');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > public.meter_station_today() then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'shift must be morning or afternoon';
  end if;
  if (p_employee_id is null) <> (v_shift is null) then
    raise exception 'employee_id and shift must both be set or both be null';
  end if;
  if p_employee_id is not null then
    perform public.require_meter_shift_writable(p_transaction_date, v_shift);
    if not exists (
      select 1 from public.employees e
      where e.id = p_employee_id and coalesce(e.is_active, true)
    ) then
      raise exception 'Unknown or inactive staff';
    end if;
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  select id into v_customer_id
  from public.credit_customers
  where trim(lower(customer_name)) = trim(lower(p_customer_name))
  order by created_at desc limit 1;

  if v_customer_id is null then
    insert into public.credit_customers (
      customer_name, vehicle_no, amount_due, date, notes, mobile, address, created_by
    )
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      nullif(trim(p_mobile), ''),
      nullif(trim(p_address), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  elsif nullif(trim(p_mobile), '') is not null
     or nullif(trim(p_address), '') is not null then
    update public.credit_customers
    set
      mobile = coalesce(nullif(trim(p_mobile), ''), mobile),
      address = coalesce(nullif(trim(p_address), ''), address)
    where id = v_customer_id;
  end if;

  perform public.raise_if_day_closing_certified(p_transaction_date);

  -- Hold the customer row until commit so two sales cannot spend the same prepaid balance.
  select prepaid_balance into v_prepaid
  from public.credit_customers
  where id = v_customer_id
  for update;

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift
  )
  returning id into v_entry_id;

  if coalesce(v_prepaid, 0) > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    begin
      v_remaining := v_prepaid;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = v_customer_id
          and amount_settled < amount
        order by transaction_date asc, id asc
        for update
      loop
        exit when v_remaining <= 0;
        v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
        update public.credit_entries
        set amount_settled = amount_settled + v_alloc
        where id = v_entry.id;
        v_remaining := v_remaining - v_alloc;
      end loop;
      perform public.sync_credit_customer_balances(v_customer_id);
    exception
      when others then
        perform set_config('app.skip_credit_sync', '', true);
        raise;
    end;
    perform set_config('app.skip_credit_sync', '', true);
  else
    perform public.sync_credit_customer_balances(v_customer_id);
  end if;

  v_out := jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
  perform public.write_request_store(p_request_id, 'add_credit_entry', v_out);
  return v_out;
end;
$$;

create or replace function public.add_shift_expense(
  p_date date,
  p_shift text,
  p_employee_id uuid,
  p_category text,
  p_amount numeric,
  p_description text default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_shift text;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'add_shift_expense');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Expense date cannot be in the future';
  end if;
  if p_employee_id is null then
    raise exception 'employee_id is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  perform public.require_meter_shift_writable(p_date, v_shift);

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  v_category := nullif(btrim(coalesce(p_category, '')), '');
  if v_category is null then
    raise exception 'category is required';
  end if;
  if lower(v_category) = 'salary' then
    raise exception 'Salary expenses cannot be added from the shift register';
  end if;
  if not exists (
    select 1 from public.expense_categories c where c.name = v_category
  ) then
    raise exception 'Unknown expense category';
  end if;
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and coalesce(e.is_active, true)
  ) then
    raise exception 'Unknown or inactive staff';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  insert into public.expenses (
    date, category, description, amount, employee_id, shift, created_by
  )
  values (
    p_date,
    v_category,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_amount,
    p_employee_id,
    v_shift,
    auth.uid()
  )
  returning id into v_id;

  v_out := jsonb_build_object(
    'id', v_id,
    'date', p_date,
    'shift', v_shift,
    'employee_id', p_employee_id,
    'amount', p_amount,
    'category', v_category
  );
  perform public.write_request_store(p_request_id, 'add_shift_expense', v_out);
  return v_out;
end;
$$;

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_credit_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  -- Same lock batch_record_credit_settlements takes, before any entry allocation.
  perform 1
  from public.credit_customers
  where id = p_credit_customer_id
  for update;
  if not found then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
        and amount_settled < amount
        and transaction_date <= p_date
      order by transaction_date desc, id desc
      for update
    loop
      exit when v_remaining <= 0;
      v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
      update public.credit_entries
      set amount_settled = amount_settled + v_alloc
      where id = v_entry.id;
      v_remaining := v_remaining - v_alloc;
    end loop;

    insert into public.credit_payments (
      credit_customer_id, date, amount, note, payment_mode, same_day_settlement, created_by
    )
    values (
      p_credit_customer_id,
      p_date,
      p_amount,
      nullif(trim(p_note), ''),
      coalesce(p_payment_mode, 'Cash'),
      coalesce(p_same_day_settlement, false),
      auth.uid()
    );

    perform public.sync_credit_customer_balances(p_credit_customer_id);

    update public.credit_customers
    set last_payment = p_date
    where id = p_credit_customer_id;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  -- Keep day closing / register in sync with open credit (and same-day cash routing).
  perform public.apply_credit_payment_to_day_closing(
    p_date,
    coalesce(p_same_day_settlement, false),
    coalesce(p_payment_mode, 'Cash'),
    p_amount
  );

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  v_out := jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
  perform public.write_request_store(p_request_id, 'record_credit_payment', v_out);
  return v_out;
end;
$$;

create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
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
  v_remaining numeric := p_total_amount;
  v_cust_id uuid;
  v_due numeric;
  v_pay_amount numeric;
  v_result jsonb;
  v_settlements jsonb := '[]'::jsonb;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'batch_record_credit_settlements');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    raise exception 'customer_ids required';
  end if;
  if p_primary_customer_id is null then
    raise exception 'primary_customer_id required';
  end if;
  if not exists (select 1 from public.credit_customers where id = p_primary_customer_id) then
    raise exception 'Primary credit customer not found';
  end if;

  perform id
  from public.credit_customers
  where id = any(p_customer_ids || array[p_primary_customer_id])
  order by id
  for update;

  foreach v_cust_id in array p_customer_ids
  loop
    exit when v_remaining <= 0;

    select amount_due into v_due
    from public.credit_customers
    where id = v_cust_id;

    if not found then
      raise exception 'Credit customer not found';
    end if;

    if v_due <= 0 then
      continue;
    end if;

    v_pay_amount := least(v_remaining, v_due);
    v_result := public.record_credit_payment(
      v_cust_id, p_date, v_pay_amount, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
    v_remaining := v_remaining - v_pay_amount;
  end loop;

  if v_remaining > 0 then
    v_result := public.record_credit_payment(
      p_primary_customer_id, p_date, v_remaining, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
  end if;

  v_out := jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'settlements', v_settlements
  );
  perform public.write_request_store(p_request_id, 'batch_record_credit_settlements', v_out);
  return v_out;
end;
$$;

create or replace function public.save_invoice(
  p_invoice_date date,
  p_invoice_type text,
  p_party_name text,
  p_party_address text default null,
  p_party_gstin text default null,
  p_vehicle_no text default null,
  p_mobile text default null,
  p_km_reading text default null,
  p_discount numeric default 0,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_discount numeric;
  v_invoice_id uuid;
  v_invoice_number text;
  v_subtotal numeric := 0;
  v_cgst numeric := 0;
  v_sgst numeric := 0;
  v_non_gst numeric := 0;
  v_nil_rate numeric := 0;
  v_gross numeric := 0;
  v_round_off numeric := 0;
  v_total numeric := 0;
  v_item jsonb;
  v_line_amount numeric;
  v_line_taxable numeric;
  v_line_gst numeric;
  v_line_cgst numeric;
  v_line_sgst numeric;
  v_gst_pct numeric;
  v_qty numeric;
  v_rate numeric;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'save_invoice');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_invoice_date is null then
    raise exception 'Invoice date is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item';
  end if;
  v_discount := coalesce(p_discount, 0);
  if v_discount < 0 or v_discount = 'NaN'::numeric then
    raise exception 'Discount cannot be negative';
  end if;

  v_invoice_number := public.generate_invoice_number();
  v_invoice_id := uuid_generate_v4();

  -- Pass 1: compute totals (invoice row must exist before line items — FK on invoice_id)
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
    if v_qty <= 0 or v_qty = 'NaN'::numeric then
      raise exception 'Quantity must be greater than 0';
    end if;
    if v_rate <= 0 or v_rate = 'NaN'::numeric then
      raise exception 'Rate must be greater than 0';
    end if;
    if v_gst_pct <> -1 and (v_gst_pct < 0 or v_gst_pct > 100) then
      raise exception 'Invalid GST percent';
    end if;
    v_line_amount := round(v_qty * v_rate, 2);

    if v_gst_pct > 0 then
      v_line_taxable := round(v_line_amount / (1 + v_gst_pct / 100), 2);
      v_line_gst := v_line_amount - v_line_taxable;
      v_line_cgst := round(v_line_gst / 2, 2);
      v_line_sgst := v_line_gst - v_line_cgst;
      v_cgst := v_cgst + v_line_cgst;
      v_sgst := v_sgst + v_line_sgst;
    elsif v_gst_pct = 0 then
      v_nil_rate := v_nil_rate + v_line_amount;
    else
      v_non_gst := v_non_gst + v_line_amount;
    end if;

    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  if v_discount > v_subtotal then
    raise exception 'Discount cannot exceed the invoice subtotal';
  end if;

  v_gross := v_subtotal - v_discount;
  v_round_off := round(v_gross) - v_gross;
  v_total := round(v_gross);

  insert into public.invoices (
    id, invoice_number, invoice_date, invoice_type,
    party_name, party_address, party_gstin,
    vehicle_no, mobile, km_reading,
    subtotal, discount, round_off, total_amount,
    cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total,
    notes, created_by
  ) values (
    v_invoice_id, v_invoice_number, p_invoice_date, p_invoice_type,
    p_party_name, p_party_address, p_party_gstin,
    p_vehicle_no, p_mobile, p_km_reading,
    v_subtotal, v_discount, v_round_off, v_total,
    v_cgst, v_sgst, 0, v_non_gst, v_nil_rate,
    p_notes, auth.uid()
  );

  -- Pass 2: insert line items after parent invoice exists
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
    v_line_amount := round(v_qty * v_rate, 2);

    insert into public.invoice_items (
      invoice_id, sl_no, product_id, item_name, hsn_code,
      quantity, unit, rate, gst_percent, amount, created_by
    ) values (
      v_invoice_id,
      coalesce((v_item->>'sl_no')::integer, 1),
      case when v_item->>'product_id' is not null and v_item->>'product_id' != ''
        then (v_item->>'product_id')::uuid else null end,
      coalesce(v_item->>'item_name', 'Item'),
      v_item->>'hsn_code',
      v_qty,
      coalesce(v_item->>'unit', 'Pcs'),
      v_rate,
      v_gst_pct,
      v_line_amount,
      auth.uid()
    );
  end loop;

  v_out := jsonb_build_object(
    'id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'total_amount', v_total,
    'subtotal', v_subtotal,
    'cgst', v_cgst,
    'sgst', v_sgst,
    'discount', v_discount,
    'round_off', v_round_off
  );
  perform public.write_request_store(p_request_id, 'save_invoice', v_out);
  return v_out;
end;
$$;


comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text, uuid) is
  'Add a credit sale. Locks the customer row before applying prepaid. Rejects a certified day and future dates (IST). Retry-safe with p_request_id.';
comment on function public.add_shift_expense(date, text, uuid, text, numeric, text, uuid) is
  'Shift register expense attributed to staff + shift. Rejects a certified day and future dates (IST). Retry-safe with p_request_id.';
comment on function public.record_credit_payment(uuid, date, numeric, text, text, boolean, uuid) is
  'Record payment. Locks the customer row. Same-day flag excludes from Collection and nets Credit today; syncs day closing. Rejects a certified day. Retry-safe with p_request_id.';
comment on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean, uuid) is
  'Record one payment split across credit customer rows. Locks those rows. Optional same-day settlement flag. Rejects a certified day. Retry-safe with p_request_id.';
comment on function public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb, uuid) is
  'Save a complete invoice with line items in a single transaction. Validates quantity, rate, GST and discount. Retry-safe with p_request_id.';

grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.add_shift_expense(date, text, uuid, text, numeric, text, uuid) to authenticated;
grant execute on function public.record_credit_payment(uuid, date, numeric, text, text, boolean, uuid) to authenticated;
grant execute on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean, uuid) to authenticated;
grant execute on function public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb, uuid) to authenticated;

-- ─── 3. Salary: atomic payment + expense, server overpay check ──────────────

-- Deleting a payment by any path removes its linked expense in the same statement.
alter table public.expenses
  drop constraint if exists expenses_salary_payment_id_fkey;
alter table public.expenses
  add constraint expenses_salary_payment_id_fkey
  foreign key (salary_payment_id) references public.salary_payments (id) on delete cascade;

-- Take-home for one employee and salary month. Mirrors js/payrollRules.js
-- (computeMonthPay → applyLopExclusion → settleTakeHome) and computePfBreakdown in js/salary.js.
create or replace function public.salary_month_payable(p_employee_id uuid, p_salary_month date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_salary_month)::date;
  v_month_end date := (date_trunc('month', p_salary_month) + interval '1 month' - interval '1 day')::date;
  v_cfg jsonb;
  v_lop_on boolean;
  v_od_on boolean;
  v_paid_leave int;
  v_fixed_days int;
  v_divisor int;
  v_gross numeric;
  v_pf_fixed numeric;
  v_per_day numeric;
  v_leave int;
  v_half int;
  v_over_duty int;
  v_lop numeric;
  v_od numeric;
  v_before_pf numeric;
  v_pf numeric;
begin
  select
    round(greatest(coalesce(e.monthly_salary, 0), 0), 2),
    round(greatest(coalesce(e.pf_contribution, 0), 0), 2)
  into v_gross, v_pf_fixed
  from public.employees e
  where e.id = p_employee_id;
  if not found then
    raise exception 'Staff member not found';
  end if;

  select coalesce(s.config->'payroll', '{}'::jsonb) into v_cfg
  from public.pump_settings s
  where s.id = 1;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);

  -- A missing key uses the default (on); an explicit non-true value turns the rule off.
  v_lop_on := case when v_cfg ? 'lossOfPayEnabled' then v_cfg->'lossOfPayEnabled' = 'true'::jsonb else true end;
  v_od_on := case when v_cfg ? 'overDutyEnabled' then v_cfg->'overDutyEnabled' = 'true'::jsonb else true end;
  v_paid_leave := case
    when jsonb_typeof(v_cfg->'paidLeaveDaysPerMonth') = 'number'
      then least(31, greatest(0, floor((v_cfg->>'paidLeaveDaysPerMonth')::numeric)))::int
    else 2
  end;
  v_fixed_days := case
    when jsonb_typeof(v_cfg->'fixedDaysInMonth') = 'number'
      then least(31, greatest(1, floor((v_cfg->>'fixedDaysInMonth')::numeric)))::int
    else 30
  end;
  v_divisor := case
    when v_cfg->>'dayRateBasis' = 'fixed' then v_fixed_days
    else extract(day from v_month_end)::int
  end;
  v_per_day := v_gross / v_divisor;

  select
    count(*) filter (where a.status in ('leave', 'absent')),
    count(*) filter (where a.status = 'half_day'),
    count(*) filter (where a.status = 'present' and a.over_duty)
  into v_leave, v_half, v_over_duty
  from public.employee_attendance a
  where a.employee_id = p_employee_id
    and a.date between v_month and v_month_end;

  v_lop := case
    when v_lop_on then round((greatest(0, v_leave - v_paid_leave) + v_half * 0.5) * v_per_day, 2)
    else 0
  end;
  if v_lop > 0 and exists (
    select 1 from public.salary_lop_exclusions x
    where x.employee_id = p_employee_id and x.salary_month = v_month
  ) then
    v_lop := 0;
  end if;
  v_od := case when v_od_on then round(v_over_duty * v_per_day, 2) else 0 end;

  v_before_pf := round(greatest(0, round(v_gross + v_od, 2) - v_lop), 2);
  v_pf := case when v_gross > 0 then least(v_pf_fixed, v_gross) else 0 end;
  v_pf := case when v_before_pf > 0 then least(v_pf, v_before_pf) else 0 end;
  return round(greatest(0, v_before_pf - v_pf), 2);
end;
$$;

comment on function public.salary_month_payable(uuid, date) is
  'Internal: net take-home for an employee and salary month (salary + over duty − loss of pay − PF). Mirrors js/payrollRules.js.';

revoke all on function public.salary_month_payable(uuid, date) from public, anon, authenticated;

create or replace function public.record_salary_payment(
  p_employee_id uuid,
  p_date date,
  p_salary_month date,
  p_amount numeric,
  p_note text default null,
  p_allow_overpay boolean default false,
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
  v_month date;
  v_note text;
  v_name text;
  v_payable numeric;
  v_paid numeric;
  v_pending numeric;
  v_payment_id uuid;
  v_expense_id uuid;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_salary_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_employee_id is null then
    raise exception 'Select a staff member.';
  end if;
  if p_date is null then
    raise exception 'Payment date is required.';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'Payment date cannot be in the future.';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;
  if p_salary_month is null then
    raise exception 'Select the salary month this payment applies to.';
  end if;
  v_month := date_trunc('month', p_salary_month)::date;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Note must be 200 characters or fewer.';
  end if;

  select e.name into v_name from public.employees e where e.id = p_employee_id;
  if not found then
    raise exception 'Staff member not found';
  end if;

  -- Concurrent payments for the same employee and month see each other's rows.
  perform pg_advisory_xact_lock(
    hashtextextended('salary_payment:' || p_employee_id::text || ':' || v_month::text, 0)
  );

  v_payable := public.salary_month_payable(p_employee_id, v_month);
  select coalesce(sum(sp.amount), 0) into v_paid
  from public.salary_payments sp
  where sp.employee_id = p_employee_id and sp.salary_month = v_month;
  v_pending := greatest(0, v_payable - v_paid);

  -- 0.05 absorbs paisa rounding differences against the browser's floating-point figures.
  if v_payable > 0 and p_amount > v_pending + 0.05 and not coalesce(p_allow_overpay, false) then
    raise exception using
      message = 'Amount exceeds the remaining salary for this month.',
      detail = jsonb_build_object('payable', v_payable, 'paid', v_paid, 'pending', v_pending)::text,
      hint = 'salary_overpay';
  end if;

  insert into public.salary_payments (employee_id, date, salary_month, amount, note, created_by)
  values (p_employee_id, p_date, v_month, p_amount, v_note, auth.uid())
  returning id into v_payment_id;

  insert into public.expenses (date, category, description, amount, salary_payment_id, created_by)
  values (
    p_date,
    'salary',
    'Salary: ' || v_name || coalesce(' - ' || v_note, ''),
    p_amount,
    v_payment_id,
    auth.uid()
  )
  returning id into v_expense_id;

  v_out := jsonb_build_object(
    'id', v_payment_id,
    'expense_id', v_expense_id,
    'employee_id', p_employee_id,
    'date', p_date,
    'salary_month', v_month,
    'amount', p_amount,
    'payable', v_payable,
    'paid_before', v_paid,
    'pending_after', greatest(0, v_payable - v_paid - p_amount)
  );
  perform public.write_request_store(p_request_id, 'record_salary_payment', v_out);
  return v_out;
end;
$$;

comment on function public.record_salary_payment(uuid, date, date, numeric, text, boolean, uuid) is
  'Record a salary payment and its linked salary expense in one transaction. Rejects a certified payment date. Raises hint salary_overpay when the amount exceeds the month''s remaining take-home unless p_allow_overpay. Retry-safe with p_request_id.';

grant execute on function public.record_salary_payment(uuid, date, date, numeric, text, boolean, uuid) to authenticated;

create or replace function public.delete_salary_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.salary_payments%rowtype;
  v_name text;
  v_linked uuid;
  v_legacy uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete salary payments.';
  end if;

  select * into v_pay from public.salary_payments where id = p_payment_id for update;
  if not found then
    raise exception 'Salary payment not found. Refresh the page and try again.';
  end if;

  perform public.raise_if_day_closing_certified(v_pay.date);

  select x.id into v_linked from public.expenses x where x.salary_payment_id = p_payment_id;

  if v_linked is null then
    -- Payments recorded before expenses.salary_payment_id existed have an unlinked expense.
    -- Only unlinked rows are candidates, so another payment's expense is never touched.
    select e.name into v_name from public.employees e where e.id = v_pay.employee_id;
    select x.id into v_legacy
    from public.expenses x
    where x.salary_payment_id is null
      and x.category = 'salary'
      and x.date = v_pay.date
      and x.amount = v_pay.amount
      and x.description = 'Salary: ' || coalesce(v_name, '') || coalesce(' - ' || nullif(btrim(v_pay.note), ''), '')
    order by x.created_at
    limit 1;
    if v_legacy is not null then
      delete from public.expenses where id = v_legacy;
    end if;
  end if;

  -- The linked expense (if any) is removed by the ON DELETE CASCADE foreign key.
  delete from public.salary_payments where id = p_payment_id;

  return jsonb_build_object(
    'id', p_payment_id,
    'expense_id', coalesce(v_linked, v_legacy),
    'expense_deleted', coalesce(v_linked, v_legacy) is not null
  );
end;
$$;

comment on function public.delete_salary_payment(uuid) is
  'Admin: delete a salary payment and its expense (linked row, or an exact unlinked legacy match). Rejects a certified payment date.';

grant execute on function public.delete_salary_payment(uuid) to authenticated;

-- Salary payments and salary expenses are written only by the RPCs above.
drop policy if exists "salary_payments_insert_own" on public.salary_payments;
create policy "salary_payments_insert_own" on public.salary_payments
  for insert to authenticated with check (false);

drop policy if exists "salary_payments_update_by_role" on public.salary_payments;
create policy "salary_payments_update_by_role" on public.salary_payments
  for update to authenticated using (false) with check (false);

drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
    and salary_payment_id is null
    and lower(coalesce(category, '')) <> 'salary'
  );

drop policy if exists "expenses_update_by_role" on public.expenses;
create policy "expenses_update_by_role" on public.expenses
  for update to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and salary_payment_id is null
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and salary_payment_id is null
    and lower(coalesce(category, '')) <> 'salary'
  );

drop policy if exists "expenses_delete_admin" on public.expenses;
create policy "expenses_delete_admin" on public.expenses
  for delete to authenticated
  using (
    (public.is_admin() and salary_payment_id is null)
    or (
      public.is_supervisor_or_admin()
      and created_by = auth.uid()
      and employee_id is not null
      and shift is not null
    )
  );

-- ─── 4. Daily meter rows ────────────────────────────────────────────────────
-- A trigger rather than CHECK constraints: existing rows are not re-validated, and updates
-- that leave the meter columns unchanged (buying price, supplier invoice) are not blocked.

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
  v_open numeric;
  v_close numeric;
  v_key text;
  v_pump int;
  v_nozzle int;
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
    if not exists (select 1 from unnest(v_keys) k where v_new->k is distinct from v_old->k) then
      return new;
    end if;
  end if;

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

  foreach v_key in array array['sales_pump1', 'sales_pump2', 'total_sales', 'testing', 'stock', 'receipts'] loop
    if (v_new->>v_key)::numeric < 0 then
      raise exception using errcode = 'check_violation',
        message = format('%s %s cannot be negative.', v_label, replace(v_key, '_', ' '));
    end if;
  end loop;

  if new.testing > new.total_sales then
    raise exception using errcode = 'check_violation',
      message = format('%s testing cannot exceed total sales.', v_label);
  end if;

  return new;
end;
$$;

comment on function public.dsr_validate_meter_row() is
  'Trigger: reject a certified day, then require closing >= opening per nozzle, non-negative sales/testing/stock/receipts, and testing <= total sales. Skips the meter checks when those columns are unchanged.';

revoke all on function public.dsr_validate_meter_row() from public, anon;
grant execute on function public.dsr_validate_meter_row() to authenticated;

drop trigger if exists dsr_petrol_validate_meters on public.dsr_petrol;
create trigger dsr_petrol_validate_meters
  before insert or update or delete on public.dsr_petrol
  for each row execute function public.dsr_validate_meter_row();

drop trigger if exists dsr_diesel_validate_meters on public.dsr_diesel;
create trigger dsr_diesel_validate_meters
  before insert or update or delete on public.dsr_diesel
  for each row execute function public.dsr_validate_meter_row();

-- Direct ledger writes (the Expenses form, a plain credit_entries insert) bypass the RPCs.
-- Reject a certified date, then refresh a saved closing that is still open.
create or replace function public.refresh_open_day_closing(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_date is null then
    return;
  end if;

  -- Collected closings stay frozen for supervisors. Admins may still refresh them.
  -- Certified dates are rejected by the caller before this runs.
  if exists (
    select 1
    from public.day_closing dc
    where dc.date = p_date
      and not coalesce(dc.certified, false)
      and (
        dc.night_cash_collection_id is null
        or public.is_admin()
      )
  ) then
    perform public.sync_saved_day_closing_for_date(p_date);
  end if;
end;
$$;

comment on function public.refresh_open_day_closing(date) is
  'Refresh a saved day closing after a ledger or meter write. Skips certified dates and, for supervisors, nights whose cash was already collected.';

revoke all on function public.refresh_open_day_closing(date) from public, anon, authenticated;

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
  if tg_table_name = 'credit_entries' then
    -- Settling an older sale only changes amount_settled. That must stay allowed
    -- when the sale's own date is already certified.
    if tg_op = 'UPDATE'
       and old.transaction_date is not distinct from new.transaction_date
       and old.amount is not distinct from new.amount
       and old.credit_customer_id is not distinct from new.credit_customer_id
       and old.fuel_type is not distinct from new.fuel_type
       and old.quantity is not distinct from new.quantity
       and old.employee_id is not distinct from new.employee_id
       and old.shift is not distinct from new.shift
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

  perform public.raise_if_day_closing_certified(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.raise_if_day_closing_certified(v_old_date);
  end if;

  perform public.refresh_open_day_closing(v_date);
  if v_old_date is not null and v_old_date is distinct from v_date then
    perform public.refresh_open_day_closing(v_old_date);
  end if;

  return null;
end;
$$;

comment on function public.ledger_guard_certified_day() is
  'Trigger: reject expenses, credit sales and payments on a certified day, then refresh an uncertified saved closing.';

revoke all on function public.ledger_guard_certified_day() from public, anon;
grant execute on function public.ledger_guard_certified_day() to authenticated;

drop trigger if exists expenses_guard_certified_day on public.expenses;
create trigger expenses_guard_certified_day
  after insert or update or delete on public.expenses
  for each row execute function public.ledger_guard_certified_day();

drop trigger if exists credit_entries_guard_certified_day on public.credit_entries;
create trigger credit_entries_guard_certified_day
  after insert or update or delete on public.credit_entries
  for each row execute function public.ledger_guard_certified_day();

drop trigger if exists credit_payments_guard_certified_day on public.credit_payments;
create trigger credit_payments_guard_certified_day
  after insert or update or delete on public.credit_payments
  for each row execute function public.ledger_guard_certified_day();

create or replace function public.dsr_refresh_open_day_closing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_open_day_closing(old.date);
    return null;
  end if;
  perform public.refresh_open_day_closing(new.date);
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    perform public.refresh_open_day_closing(old.date);
  end if;
  return null;
end;
$$;

comment on function public.dsr_refresh_open_day_closing() is
  'Trigger: after a meter row change, refresh an uncertified saved day closing. Certified days are rejected by dsr_validate_meter_row.';

revoke all on function public.dsr_refresh_open_day_closing() from public, anon;
grant execute on function public.dsr_refresh_open_day_closing() to authenticated;

drop trigger if exists dsr_petrol_refresh_day_closing on public.dsr_petrol;
create trigger dsr_petrol_refresh_day_closing
  after insert or update or delete on public.dsr_petrol
  for each row execute function public.dsr_refresh_open_day_closing();

drop trigger if exists dsr_diesel_refresh_day_closing on public.dsr_diesel;
create trigger dsr_diesel_refresh_day_closing
  after insert or update or delete on public.dsr_diesel
  for each row execute function public.dsr_refresh_open_day_closing();

-- ─── 5. Invoices: only save_invoice writes headers and lines ────────────────

drop policy if exists "invoices_insert_own" on public.invoices;
create policy "invoices_insert_own" on public.invoices
  for insert to authenticated with check (false);

drop policy if exists "invoices_update_by_role" on public.invoices;
create policy "invoices_update_by_role" on public.invoices
  for update to authenticated using (false) with check (false);

drop policy if exists "invoice_items_insert_own" on public.invoice_items;
create policy "invoice_items_insert_own" on public.invoice_items
  for insert to authenticated with check (false);

drop policy if exists "invoice_items_update_by_role" on public.invoice_items;
create policy "invoice_items_update_by_role" on public.invoice_items
  for update to authenticated using (false) with check (false);

-- ─── 6. Legacy overloads ────────────────────────────────────────────────────
-- Old signatures left behind when parameters were added; SECURITY DEFINER, callable by anon,
-- and missing the current access checks. The app calls the newer signatures only.

drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text);
drop function if exists public.record_credit_payment(uuid, date, numeric, text);
drop function if exists public.save_day_closing(date, numeric, numeric);
drop function if exists public.upsert_staff(text, text);
