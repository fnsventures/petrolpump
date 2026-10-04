-- Security loophole mitigation:
-- 1. Provisioned-staff gate (is_supervisor_or_admin) on RLS read/write paths
-- 2. Block direct invoice_items mutations (save_invoice RPC only)
-- 3. Role checks on security-definer RPCs
-- 4. Close admin bootstrap race (self-provision only)
-- 5. Revoke internal recascade RPC from clients

-- ---------------------------------------------------------------------------
-- Helper: reject unprovisioned auth users (exist in auth.users but not public.users)
-- ---------------------------------------------------------------------------
create or replace function public.require_staff_access()
returns void
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Provisioned staff access required';
  end if;
end;
$$;

comment on function public.require_staff_access() is
  'Raises unless the caller is a provisioned admin or supervisor in public.users.';

-- ---------------------------------------------------------------------------
-- RLS: SELECT — provisioned staff only
-- ---------------------------------------------------------------------------
drop policy if exists "dsr_petrol_select_authenticated" on public.dsr_petrol;
create policy "dsr_petrol_select_authenticated" on public.dsr_petrol
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "dsr_diesel_select_authenticated" on public.dsr_diesel;
create policy "dsr_diesel_select_authenticated" on public.dsr_diesel
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "expenses_select_authenticated" on public.expenses
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "expense_categories_select_authenticated" on public.expense_categories;
create policy "expense_categories_select_authenticated" on public.expense_categories
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated" on public.products
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "invoices_select_authenticated" on public.invoices;
create policy "invoices_select_authenticated" on public.invoices
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "users_select_authenticated" on public.users;
create policy "users_select_authenticated" on public.users
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "salary_payments_select_authenticated" on public.salary_payments;
create policy "salary_payments_select_authenticated" on public.salary_payments
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "employee_attendance_select_authenticated" on public.employee_attendance;
create policy "employee_attendance_select_authenticated" on public.employee_attendance
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "credit_select_authenticated" on public.credit_customers;
create policy "credit_select_authenticated" on public.credit_customers
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "credit_entries_select_authenticated" on public.credit_entries;
create policy "credit_entries_select_authenticated" on public.credit_entries
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "credit_payments_select_authenticated" on public.credit_payments;
create policy "credit_payments_select_authenticated" on public.credit_payments
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "day_closing_select_authenticated" on public.day_closing;
create policy "day_closing_select_authenticated" on public.day_closing
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists pump_settings_select_authenticated on public.pump_settings;
create policy pump_settings_select_authenticated on public.pump_settings
  for select to authenticated using (public.is_supervisor_or_admin());

-- ---------------------------------------------------------------------------
-- RLS: INSERT — provisioned staff only
-- ---------------------------------------------------------------------------
drop policy if exists "dsr_petrol_insert_own" on public.dsr_petrol;
create policy "dsr_petrol_insert_own" on public.dsr_petrol
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "dsr_diesel_insert_own" on public.dsr_diesel;
create policy "dsr_diesel_insert_own" on public.dsr_diesel
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "invoices_insert_own" on public.invoices;
create policy "invoices_insert_own" on public.invoices
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "salary_payments_insert_own" on public.salary_payments;
create policy "salary_payments_insert_own" on public.salary_payments
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "employee_attendance_insert_own" on public.employee_attendance;
create policy "employee_attendance_insert_own" on public.employee_attendance
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "credit_insert_own" on public.credit_customers;
create policy "credit_insert_own" on public.credit_customers
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "credit_entries_insert_own" on public.credit_entries;
create policy "credit_entries_insert_own" on public.credit_entries
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "credit_payments_insert_own" on public.credit_payments;
create policy "credit_payments_insert_own" on public.credit_payments
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "day_closing_insert_own" on public.day_closing;
create policy "day_closing_insert_own" on public.day_closing
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- RLS: UPDATE — provisioned staff only
-- ---------------------------------------------------------------------------
drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "expenses_update_by_role" on public.expenses;
create policy "expenses_update_by_role" on public.expenses
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "invoices_update_by_role" on public.invoices;
create policy "invoices_update_by_role" on public.invoices
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "salary_payments_update_by_role" on public.salary_payments;
create policy "salary_payments_update_by_role" on public.salary_payments
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "employee_attendance_update_own" on public.employee_attendance;
create policy "employee_attendance_update_own" on public.employee_attendance
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "credit_entries_update_by_role" on public.credit_entries;
create policy "credit_entries_update_by_role" on public.credit_entries
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "credit_payments_update_by_role" on public.credit_payments;
create policy "credit_payments_update_by_role" on public.credit_payments
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

-- ---------------------------------------------------------------------------
-- RLS: invoice_items — read for staff; mutations only via save_invoice RPC
-- ---------------------------------------------------------------------------
drop policy if exists "invoice_items_select_authenticated" on public.invoice_items;
create policy "invoice_items_select_authenticated" on public.invoice_items
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "invoice_items_insert_own" on public.invoice_items;
create policy "invoice_items_insert_own" on public.invoice_items
  for insert to authenticated with check (false);

drop policy if exists "invoice_items_update_by_role" on public.invoice_items;
create policy "invoice_items_update_by_role" on public.invoice_items
  for update to authenticated using (false) with check (false);

drop policy if exists "invoice_items_delete_authenticated" on public.invoice_items;
create policy "invoice_items_delete_authenticated" on public.invoice_items
  for delete to authenticated using (false);

-- ---------------------------------------------------------------------------
-- Bootstrap: first admin must self-provision (no arbitrary email escalation)
-- ---------------------------------------------------------------------------
drop policy if exists "users_insert_admin" on public.users;
create policy "users_insert_admin" on public.users
  for insert to authenticated
  with check (
    public.is_admin()
    or (
      not exists (select 1 from public.users u where u.role = 'admin')
      and lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'))
      and role = 'admin'
    )
  );

create or replace function public.upsert_staff(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    if exists (select 1 from public.users where role = 'admin') then
      raise exception 'Access denied: Admin role required';
    end if;
    if lower(trim(p_email)) <> lower(trim(auth.jwt() ->> 'email')) then
      raise exception 'Bootstrap: can only provision your own email as the first admin';
    end if;
    if p_role <> 'admin' then
      raise exception 'Bootstrap: first user must be admin';
    end if;
  end if;
  if p_role not in ('admin', 'supervisor') then
    raise exception 'Invalid role: must be admin or supervisor';
  end if;
  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  insert into public.users (email, role, display_name)
  values (lower(trim(p_email)), p_role, nullif(trim(p_display_name), ''))
  on conflict (email) do update set role = excluded.role, display_name = excluded.display_name
  returning jsonb_build_object('id', id, 'email', email, 'role', role, 'display_name', display_name) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC guards: provisioned staff only
-- ---------------------------------------------------------------------------
create or replace function public.list_employees_roster()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  select e.id, e.name, e.role_display, e.monthly_salary, e.display_order
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
end;
$$;

create or replace function public.list_employees_salary()
returns table (
  id uuid,
  name text,
  role_display text,
  monthly_salary numeric,
  display_order smallint,
  phone_number text,
  aadhar_number text,
  address text,
  pan_number text,
  pf_number text,
  pf_contribution numeric,
  blood_group text,
  photo_url text,
  date_of_birth date,
  id_valid_from date,
  id_valid_to date
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  select
    e.id,
    e.name,
    e.role_display,
    e.monthly_salary,
    e.display_order,
    e.phone_number,
    e.aadhar_number,
    e.address,
    e.pan_number,
    e.pf_number,
    e.pf_contribution,
    e.blood_group,
    e.photo_url,
    e.date_of_birth,
    e.id_valid_from,
    e.id_valid_to
  from public.employees e
  where e.is_active = true
  order by e.display_order, e.name;
end;
$$;

create or replace function public.get_dsr_stock_range(p_start date, p_end date)
returns table (
  date date,
  product text,
  opening_stock numeric,
  receipts numeric,
  total_stock numeric,
  sale_from_meter numeric,
  testing numeric,
  net_sale numeric,
  closing_stock numeric,
  dip_stock numeric,
  variation numeric,
  remark text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with bounds as (
    select (p_start - interval '1 day')::date as lookback_start
  ),
  base as (
    select d.date, 'petrol'::text as product, d.stock as dip_stock, d.receipts,
      d.total_sales as sale_from_meter, d.testing,
      greatest(d.total_sales - d.testing, 0) as net_sale,
      d.remarks as remark, d.created_by, d.created_at
    from public.dsr_petrol d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
    union all
    select d.date, 'diesel'::text, d.stock, d.receipts, d.total_sales, d.testing,
      greatest(d.total_sales - d.testing, 0), d.remarks, d.created_by, d.created_at
    from public.dsr_diesel d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
  ),
  with_opening as (
    select *,
      coalesce(lag(dip_stock) over (partition by product order by date), 0) as opening_stock
    from base
  )
  select w.date, w.product, w.opening_stock, w.receipts,
    (w.opening_stock + w.receipts) as total_stock, w.sale_from_meter, w.testing, w.net_sale,
    ((w.opening_stock + w.receipts) - w.net_sale) as closing_stock, w.dip_stock,
    (((w.opening_stock + w.receipts) - w.net_sale) - w.dip_stock) as variation,
    w.remark, w.created_by, w.created_at
  from with_opening w
  where w.date >= p_start and w.date <= p_end;
end;
$$;

create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  update public.users
  set avatar_url = nullif(trim(p_avatar_url), '')
  where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'));
  if not found then
    raise exception 'User not provisioned';
  end if;
end;
$$;

-- save_invoice: add staff guard at top
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
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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

  v_invoice_number := public.generate_invoice_number();
  v_invoice_id := uuid_generate_v4();

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
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

  v_gross := v_subtotal - p_discount;
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
    v_subtotal, p_discount, v_round_off, v_total,
    v_cgst, v_sgst, 0, v_non_gst, v_nil_rate,
    p_notes, auth.uid()
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
    v_line_amount := round(v_qty * v_rate, 2);

    insert into public.invoice_items (
      invoice_id, sl_no, product_id, item_name, hsn_code,
      quantity, unit, rate, gst_percent, amount
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
      v_line_amount
    );
  end loop;

  return jsonb_build_object(
    'id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'total_amount', v_total,
    'subtotal', v_subtotal,
    'cgst', v_cgst,
    'sgst', v_sgst,
    'discount', p_discount,
    'round_off', v_round_off
  );
end;
$$;

-- compute_day_closing_components
create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_expenses_today numeric := 0;
begin
  perform public.require_staff_access();

  select coalesce(sum(
    coalesce(v_row.total_sales, 0)
    * case
        when v_row.product = 'petrol' then coalesce(v_row.petrol_rate, 0)
        when v_row.product = 'diesel' then coalesce(v_row.diesel_rate, 0)
        else 0
      end
  ), 0) into v_total_sale
  from public.dsr v_row
  where v_row.date = p_date;

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0)
  );
end;
$$;

-- get_day_closing_breakdown
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_live numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  perform public.require_staff_access();

  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;
  v_can_overwrite := v_already_saved and public.is_admin();
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  if v_use_snapshot then
    select coalesce(sum(amount), 0) into v_expenses_live
    from public.expenses where date = p_date;

    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
  else
    v_components := public.compute_day_closing_components(p_date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_live := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_live,
    'night_cash', case when v_already_saved then coalesce(v_existing.night_cash, 0) else null end,
    'phone_pay', case when v_already_saved then coalesce(v_existing.phone_pay, 0) else null end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite
  );
end;
$$;

-- save_day_closing
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_is_overwrite boolean := false;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_ref text;
  v_seq bigint;
begin
  perform public.require_staff_access();

  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  select closing_reference into v_existing
  from public.day_closing where date = p_date;
  if found then
    if not public.is_admin() then
      raise exception 'Day closing already saved for this date.';
    end if;
    v_is_overwrite := true;
    v_ref := v_existing.closing_reference;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  if v_is_overwrite then
    update public.day_closing set
      night_cash = p_night_cash,
      phone_pay = p_phone_pay,
      short_today = v_short_today,
      total_sale = v_total_sale,
      collection = v_collection,
      short_previous = v_short_previous,
      credit_today = v_credit_today,
      expenses_today = v_expenses_today,
      remarks = nullif(trim(p_remarks), '')
    where date = p_date;

    perform public.recascade_day_closing_short_from(p_date);
  else
    select coalesce(max(
      nullif(regexp_replace(closing_reference, '^DC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
    ), 0) + 1 into v_seq
    from public.day_closing
    where extract(year from date) = extract(year from p_date)
      and closing_reference is not null
      and closing_reference ~ '^DC-[0-9]+-[0-9]+$';
    v_ref := 'DC-' || to_char(p_date, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

    insert into public.day_closing (
      date, night_cash, phone_pay, short_today,
      total_sale, collection, short_previous, credit_today, expenses_today,
      closing_reference, remarks, created_by
    )
    values (
      p_date, p_night_cash, p_phone_pay, v_short_today,
      v_total_sale, v_collection, v_short_previous, v_credit_today, v_expenses_today,
      v_ref, nullif(trim(p_remarks), ''), auth.uid()
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', coalesce(p_night_cash, 0),
    'phone_pay', coalesce(p_phone_pay, 0),
    'short_today', coalesce(v_short_today, 0),
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), ''),
    'overwritten', v_is_overwrite
  );
end;
$$;

-- add_credit_entry
create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null,
  p_mobile text default null,
  p_address text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
    raise exception 'transaction date cannot be in the future';
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

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;

-- record_credit_payment
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
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
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  if v_remaining > 0 then
    raise exception 'Payment amount exceeds outstanding balance';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;

-- Credit query RPCs
create or replace function public.get_credit_ledger_aggregated()
returns table (
  id uuid,
  customer_name text,
  vehicle_no text,
  amount_due numeric,
  date date,
  last_payment date,
  notes text
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with ranked as (
    select c.id, c.customer_name, c.vehicle_no, c.amount_due, c.date, c.last_payment, c.notes,
           row_number() over (partition by lower(trim(c.customer_name)) order by c.amount_due desc nulls last, c.created_at desc) as rn
    from public.credit_customers c
  ),
  agg as (
    select lower(trim(r.customer_name)) as name_key,
           sum(r.amount_due) as total_due,
           min(r.date) as min_date,
           max(r.last_payment) as max_last_pay,
           (array_agg(r.notes order by r.amount_due desc nulls last))[1] as first_notes
    from ranked r
    group by lower(trim(r.customer_name))
  )
  select r.id,
         r.customer_name::text as customer_name,
         r.vehicle_no::text as vehicle_no,
         a.total_due::numeric as amount_due,
         a.min_date as date,
         a.max_last_pay as last_payment,
         a.first_notes::text as notes
  from ranked r
  join agg a on lower(trim(r.customer_name)) = a.name_key
  where r.rn = 1
  order by a.total_due desc nulls last, r.customer_name;
end;
$$;

create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language plpgsql security definer stable
set search_path = public
as $$
declare
  v_total numeric;
begin
  perform public.require_staff_access();

  with bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id, coalesce(sum(amount), 0) as payment_tot
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  )
  select coalesce(sum(
    greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)
  ), 0)
  into v_total
  from public.credit_customers c
  left join bal b on b.credit_customer_id = c.id
  left join pay p on p.credit_customer_id = c.id;
  return v_total;
end;
$$;

create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
    group by credit_customer_id
  ),
  per_customer as (
    select c.customer_name,
           c.vehicle_no,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as amt,
           p.last_pay_date as last_pay,
           b.last_txn_date as last_txn
    from public.credit_customers c
    left join bal b on b.credit_customer_id = c.id
    left join pay p on p.credit_customer_id = c.id
    where greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0) > 0
  )
  select (max(pc.customer_name))::text as customer_name,
         (max(pc.vehicle_no))::text as vehicle_no,
         sum(pc.amt)::numeric as amount_due_as_of,
         max(pc.last_pay) as last_payment_date,
         max(pc.last_txn) as sale_date
  from per_customer pc
  group by lower(trim(pc.customer_name))
  order by amount_due_as_of desc;
end;
$$;

create or replace function public.get_customer_credit_summary_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
    group by c.id
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from name_match)
    group by e.credit_customer_id
  ),
  pay as (
    select credit_customer_id,
           coalesce(sum(amount), 0) as payment_tot,
           max(date) as last_pay_date
    from public.credit_payments
    where date <= p_date
      and credit_customer_id in (select credit_customer_id from name_match)
    group by credit_customer_id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  )
  select (max(pc.customer_name))::text,
         (max(pc.vehicle_no))::text,
         sum(pc.credit_taken)::numeric as credit_taken,
         sum(pc.settlement_done)::numeric as settlement_done,
         sum(pc.remaining)::numeric as remaining,
         max(pc.last_payment_date) as last_payment_date,
         min(pc.first_sale_date) as first_sale_date,
         max(pc.last_credit_date) as last_credit_date
  from per_customer pc;
end;
$$;

create or replace function public.get_customer_credit_breakdown_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  entry_type text,
  entry_date date,
  amount numeric
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  credits as (
    select 'credit'::text as entry_type,
           e.transaction_date as entry_date,
           e.amount
    from public.credit_entries e
    join customer_ids ci on ci.credit_customer_id = e.credit_customer_id
    where e.transaction_date <= p_date
  ),
  payments as (
    select 'payment'::text as entry_type,
           p.date as entry_date,
           p.amount
    from public.credit_payments p
    join customer_ids ci on ci.credit_customer_id = p.credit_customer_id
    where p.date <= p_date
  )
  select u.entry_type, u.entry_date, u.amount
  from (
    select * from credits
    union all
    select * from payments
  ) u
  order by u.entry_date asc, u.entry_type asc;
end;
$$;

create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb
)
language plpgsql security definer stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date, max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id, coalesce(sum(p.amount), 0) as payment_tot, max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id, max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c join customer_ids ci on ci.credit_customer_id = c.id group by c.id
  ),
  per_customer as (
    select nm.customer_name, nm.vehicle_no, coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date, b.min_txn_date as first_sale_date, b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name, (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken, sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining, max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date, max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'entry_date', e.transaction_date,
          'amount', e.amount,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount_settled', e.amount_settled
        ) order by e.transaction_date desc
      )
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids) and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'entry_date', p.date,
          'amount', p.amount,
          'payment_mode', p.payment_mode,
          'note', p.note
        ) order by p.date desc
      )
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids) and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date,
         cj.entries, pj.entries
  from agg a
  cross join credits_json cj
  cross join payments_json pj;
end;
$$;

-- Internal: recascade only callable from save_day_closing (security definer)
revoke all on function public.recascade_day_closing_short_from(date) from public;
revoke all on function public.recascade_day_closing_short_from(date) from authenticated;

grant execute on function public.require_staff_access() to authenticated;
