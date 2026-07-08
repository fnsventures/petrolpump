-- Petrol Pump schema for Supabase
-- Run inside the Supabase SQL editor or via supabase cli.
--
-- SECURITY MODEL:
-- ===============
-- This schema implements Row Level Security (RLS) as the PRIMARY authorization layer.
-- Client-side role checks (applyRoleVisibility, requireAuth) are for UX only.
-- All data access is enforced at the database level regardless of client-side bypasses.
--
-- Roles:
--   - admin: Full access to all operations including delete and staff management
--   - supervisor: Read all, insert/update own records, no delete access

create extension if not exists "uuid-ossp";

-- ============================================================================
-- ROLE HELPER FUNCTIONS (Security Definer - bypasses RLS for internal checks)
-- ============================================================================

-- Get the current user's role from public.users only (no JWT metadata fallback).
-- Returns 'admin', 'supervisor', or null if not provisioned.
create or replace function public.get_user_role()
returns text
language sql
security definer
stable
as $$
  select role
  from public.users
  where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'))
  limit 1;
$$;

comment on function public.get_user_role() is 'Returns admin/supervisor from public.users only. Null if not provisioned.';

-- Helper function to check if current user is admin
-- This centralizes the admin check logic and improves performance
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select public.get_user_role() = 'admin';
$$;

comment on function public.is_admin() is 'Returns true if the current authenticated user has admin role.';

-- RPC to update DSR buying price (used from P&L dashboard); bypasses RLS so admin update always succeeds.
-- Checks both dsr_petrol and dsr_diesel since caller only has the row UUID.
create or replace function public.update_dsr_buying_price(p_dsr_id uuid, p_value numeric)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;
  update public.dsr_petrol set buying_price_per_litre = p_value where id = p_dsr_id;
  if found then return; end if;
  update public.dsr_diesel set buying_price_per_litre = p_value where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;
comment on function public.update_dsr_buying_price(uuid, numeric) is 'Admin-only: set buying_price_per_litre for a DSR row (used from P&L dashboard).';


-- Helper function to check if current user is supervisor or admin
-- Supervisors have read access and can manage their own records
create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
security definer
stable
as $$
  select public.get_user_role() in ('admin', 'supervisor');
$$;

comment on function public.is_supervisor_or_admin() is 'Returns true if the current user is a supervisor or admin.';

-- Reject unprovisioned auth users (exist in auth.users but not public.users)
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

-- ============================================================================
-- AUDIT LOG TABLE (tracks sensitive operations)
-- ============================================================================

create table if not exists public.audit_log (
  id uuid primary key default uuid_generate_v4(),
  table_name text not null,
  record_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  performed_by uuid references auth.users (id) on delete set null,
  performed_by_email text,
  performed_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists audit_log_table_idx on public.audit_log (table_name, performed_at desc);
create index if not exists audit_log_record_idx on public.audit_log (record_id);

comment on table public.audit_log is 'Audit trail for sensitive operations (admin-only view).';

alter table public.audit_log enable row level security;

-- Only admins can view audit logs
drop policy if exists "audit_log_select_admin" on public.audit_log;
create policy "audit_log_select_admin" on public.audit_log
  for select
  to authenticated
  using (public.is_admin());

-- No direct inserts/updates/deletes - only via triggers
drop policy if exists "audit_log_no_direct_write" on public.audit_log;
create policy "audit_log_no_direct_write" on public.audit_log
  for all
  to authenticated
  using (false)
  with check (false);

-- ============================================================================
-- SECURE ADMIN FUNCTIONS (Server-side enforcement for critical operations)
-- ============================================================================

-- Secure function to add/update app user (admin-only, server-side validation)
create or replace function public.upsert_staff(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
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

comment on function public.upsert_staff(text, text, text) is 'Securely add or update app user (users table) with server-side admin validation.';

-- Secure function to delete app user (admin-only, with audit)
create or replace function public.delete_staff(p_email text)
returns boolean
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied: Admin role required';
  end if;
  if lower(trim(p_email)) = lower(auth.jwt() ->> 'email') then
    raise exception 'Cannot delete your own account';
  end if;
  delete from public.users where email = lower(trim(p_email));
  return found;
end;
$$;

comment on function public.delete_staff(text) is 'Securely delete app user with server-side admin validation.';

-- Function to validate user has access to a specific page/feature
-- Can be called from client to verify access before showing sensitive data
create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();
  
  -- Define page access rules
  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'staff' then v_role in ('admin', 'supervisor')
    when 'analysis' then v_role = 'admin'
    when 'reports' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'day-closing' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit-overdue' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    when 'invoices' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

comment on function public.check_page_access(text) is 'Server-side page access validation. Returns allowed status and user role.';

-- ============================================================================
-- DSR TABLES: Separate tables for petrol (MS) and diesel (HSD) meter readings
-- ============================================================================
-- Filled by Meter Reading form: nozzle readings, total_sales, testing, dip_reading, stock (L), receipts, rates.
-- Used by: day-closing (sales), P&L (buying price, receipts), dashboard (net sale, stock fallback), analysis.
-- See also: dsr_stock for optional stock-reconciliation fields (dip_stock, variation).

-- PETROL (MS) meter readings
create table if not exists public.dsr_petrol (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  tank_capacity text not null default '15KL',
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  buying_price_per_litre numeric(12, 5),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_petrol_date_idx on public.dsr_petrol (date desc);

comment on table public.dsr_petrol is 'Petrol (MS) meter readings. One row per day per tank from Meter Reading form.';
comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';

alter table public.dsr_petrol enable row level security;

drop policy if exists "dsr_petrol_select_authenticated" on public.dsr_petrol;
create policy "dsr_petrol_select_authenticated" on public.dsr_petrol
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "dsr_petrol_insert_own" on public.dsr_petrol;
create policy "dsr_petrol_insert_own" on public.dsr_petrol
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "dsr_petrol_delete_admin" on public.dsr_petrol;
create policy "dsr_petrol_delete_admin" on public.dsr_petrol
  for delete to authenticated using (public.is_admin());

-- DIESEL (HSD) meter readings
create table if not exists public.dsr_diesel (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  tank_capacity text not null default '20KL',
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  buying_price_per_litre numeric(12, 5),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_diesel_date_idx on public.dsr_diesel (date desc);

create index if not exists dsr_petrol_receipts_buying_idx
  on public.dsr_petrol (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

create index if not exists dsr_diesel_receipts_buying_idx
  on public.dsr_diesel (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

comment on table public.dsr_diesel is 'Diesel (HSD) meter readings. One row per day per tank from Meter Reading form.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';

alter table public.dsr_diesel enable row level security;

drop policy if exists "dsr_diesel_select_authenticated" on public.dsr_diesel;
create policy "dsr_diesel_select_authenticated" on public.dsr_diesel
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "dsr_diesel_insert_own" on public.dsr_diesel;
create policy "dsr_diesel_insert_own" on public.dsr_diesel
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "dsr_diesel_delete_admin" on public.dsr_diesel;
create policy "dsr_diesel_delete_admin" on public.dsr_diesel
  for delete to authenticated using (public.is_admin());

-- Backward-compatible union view (used by dashboard, sales-daily, analysis, day-closing)
create or replace view public.dsr as
  select id, date, 'petrol'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    remarks, created_by, created_at
  from public.dsr_petrol
  union all
  select id, date, 'diesel'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    remarks, created_by, created_at
  from public.dsr_diesel;

comment on view public.dsr is 'Backward-compatible union view. SELECT only; writes go to dsr_petrol / dsr_diesel.';

-- ============================================================================
-- DSR STOCK: computed stock reconciliation view (derived from dsr_petrol/dsr_diesel)
-- ============================================================================
-- All stock values are derived on-the-fly: opening_stock = previous day's
-- dip_stock (LAG window), closing_stock = total_stock - net_sale, etc.
-- No separate tables needed; always consistent with meter readings.
-- At ~730 rows/year the window function is trivial.

create or replace view public.dsr_stock as
with base as (
  select
    date,
    'petrol'::text as product,
    stock as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from public.dsr_petrol
  union all
  select
    date,
    'diesel'::text as product,
    stock as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from public.dsr_diesel
),
with_opening as (
  select *,
    coalesce(
      lag(dip_stock) over (partition by product order by date),
      0
    ) as opening_stock
  from base
)
select
  date,
  product,
  opening_stock,
  receipts,
  (opening_stock + receipts) as total_stock,
  sale_from_meter,
  testing,
  net_sale,
  ((opening_stock + receipts) - net_sale) as closing_stock,
  dip_stock,
  (((opening_stock + receipts) - net_sale) - dip_stock) as variation,
  remark,
  created_by,
  created_at
from with_opening;

comment on view public.dsr_stock is 'Computed stock reconciliation. Derived from dsr_petrol/dsr_diesel; no sync needed.';

-- Range-scoped stock (LAG over range + 1 prior day; prefer over full view for filtered queries)
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
    select b.*,
      coalesce(lag(b.dip_stock) over (partition by b.product order by b.date), 0) as opening_stock
    from base b
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

comment on function public.get_dsr_stock_range(date, date) is
  'DSR stock reconciliation for a date range; LAG scoped to range + 1 prior day per product.';

grant execute on function public.get_dsr_stock_range(date, date) to authenticated;

-- Operating expenses
create table if not exists public.expenses (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  category text,
  description text,
  amount numeric(14,2) not null default 0,
  salary_payment_id uuid references public.salary_payments (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create unique index if not exists expenses_salary_payment_id_unique on public.expenses (salary_payment_id) where salary_payment_id is not null;

create index if not exists expenses_date_idx on public.expenses (date desc);
create index if not exists expenses_created_at_idx on public.expenses (created_at desc);
create index if not exists expenses_category_idx on public.expenses (category);

comment on table public.expenses is 'Daily operating expenses for profit/loss.';

alter table public.expenses enable row level security;

-- SELECT: All authenticated users can view all records
drop policy if exists "expenses_select_authenticated" on public.expenses;
drop policy if exists "expenses_select_by_role" on public.expenses;
create policy "expenses_select_authenticated" on public.expenses
  for select
  to authenticated
  using (public.is_supervisor_or_admin());

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "expenses_insert_authenticated" on public.expenses;
drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own" on public.expenses
  for insert
  to authenticated
  with check (
    public.is_supervisor_or_admin() and created_by = auth.uid()
  );

-- UPDATE: Users can update their own records, admins can update all
drop policy if exists "expenses_update_by_role" on public.expenses;
create policy "expenses_update_by_role" on public.expenses
  for update
  to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  );

-- DELETE: Only admins can delete expense records (audit trail protection)
drop policy if exists "expenses_delete_admin" on public.expenses;
create policy "expenses_delete_admin" on public.expenses
  for delete
  to authenticated
  using (
    public.is_admin()
  );

-- Expense categories (user-managed; admin add/delete in Settings)
create table if not exists public.expense_categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  label text not null,
  sort_order int not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists expense_categories_sort_idx on public.expense_categories (sort_order, label);

comment on table public.expense_categories is 'User-managed expense categories shown in Expenses form and Settings.';

alter table public.expense_categories enable row level security;

drop policy if exists "expense_categories_select_authenticated" on public.expense_categories;
create policy "expense_categories_select_authenticated" on public.expense_categories
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "expense_categories_insert_admin" on public.expense_categories;
create policy "expense_categories_insert_admin" on public.expense_categories
  for insert to authenticated with check (public.is_admin());

drop policy if exists "expense_categories_update_admin" on public.expense_categories;
create policy "expense_categories_update_admin" on public.expense_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "expense_categories_delete_admin" on public.expense_categories;
create policy "expense_categories_delete_admin" on public.expense_categories
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- BILLING: Products, Invoices, Invoice Items
-- Generalized billing for lube sales, accessories, and any product sales
-- ============================================================================

-- Products master table
create table if not exists public.products (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  hsn_code text,
  unit text not null default 'Pcs',
  default_rate numeric(12,2) not null default 0,
  gst_percent numeric(5,2) not null default 18,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists products_active_idx on public.products (is_active, name);

comment on table public.products is 'Product master for billing — lubricants, accessories, etc.';

alter table public.products enable row level security;

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated" on public.products
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "products_insert_admin" on public.products;
create policy "products_insert_admin" on public.products
  for insert to authenticated with check (public.is_admin());

drop policy if exists "products_update_admin" on public.products;
create policy "products_update_admin" on public.products
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "products_delete_admin" on public.products;
create policy "products_delete_admin" on public.products
  for delete to authenticated using (public.is_admin());


-- Invoice number sequence
create sequence if not exists public.invoice_number_seq start with 1 increment by 1;

-- Invoices table
create table if not exists public.invoices (
  id uuid primary key default uuid_generate_v4(),
  invoice_number text not null unique,
  invoice_date date not null default current_date,
  invoice_type text not null default 'CASH' check (invoice_type in ('CASH', 'CREDIT')),
  party_name text not null default 'Cash A/c',
  party_address text,
  party_gstin text,
  vehicle_no text,
  mobile text,
  km_reading text,
  subtotal numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  round_off numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  cgst_total numeric(12,2) not null default 0,
  sgst_total numeric(12,2) not null default 0,
  igst_total numeric(12,2) not null default 0,
  non_gst_total numeric(12,2) not null default 0,
  nil_rate_total numeric(12,2) not null default 0,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists invoices_date_idx on public.invoices (invoice_date desc);
create index if not exists invoices_party_idx on public.invoices (party_name);
create index if not exists invoices_number_idx on public.invoices (invoice_number);
create index if not exists invoices_list_order_idx on public.invoices (invoice_date desc, created_at desc);

comment on table public.invoices is 'Sales invoices / cash memos for products (lubricants, accessories, etc).';

alter table public.invoices enable row level security;

drop policy if exists "invoices_select_authenticated" on public.invoices;
create policy "invoices_select_authenticated" on public.invoices
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "invoices_insert_own" on public.invoices;
create policy "invoices_insert_own" on public.invoices
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "invoices_update_by_role" on public.invoices;
create policy "invoices_update_by_role" on public.invoices
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "invoices_delete_admin" on public.invoices;
create policy "invoices_delete_admin" on public.invoices
  for delete to authenticated using (public.is_admin());


-- Supplier / purchase invoice documents (files in Google Drive)
create table if not exists public.invoice_documents (
  id uuid primary key default uuid_generate_v4(),
  invoice_date date not null,
  year smallint not null,
  month smallint not null check (month between 1 and 12),
  title text,
  vendor text,
  amount numeric(14, 2),
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  drive_file_id text not null,
  drive_folder_id text,
  drive_web_view_link text,
  notes text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists invoice_documents_date_idx on public.invoice_documents (invoice_date desc);
create index if not exists invoice_documents_year_month_idx on public.invoice_documents (year desc, month desc);

comment on table public.invoice_documents is
  'Supplier / purchase invoice files stored in Google Drive under year/month folders.';

alter table public.invoice_documents enable row level security;

drop policy if exists "invoice_documents_select" on public.invoice_documents;
create policy "invoice_documents_select" on public.invoice_documents
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "invoice_documents_insert" on public.invoice_documents;
create policy "invoice_documents_insert" on public.invoice_documents
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "invoice_documents_delete_admin" on public.invoice_documents;
create policy "invoice_documents_delete_admin" on public.invoice_documents
  for delete to authenticated
  using (public.is_admin());


-- Invoice line items
create table if not exists public.invoice_items (
  id uuid primary key default uuid_generate_v4(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  sl_no integer not null,
  product_id uuid references public.products(id) on delete set null,
  item_name text not null,
  hsn_code text,
  quantity numeric(12,3) not null default 1,
  unit text not null default 'Pcs',
  rate numeric(12,2) not null default 0,
  gst_percent numeric(5,2) not null default 18,
  amount numeric(12,2) not null default 0,
  created_at timestamptz default now()
);

create index if not exists invoice_items_invoice_idx on public.invoice_items (invoice_id);

comment on table public.invoice_items is 'Line items for each invoice — product, qty, rate, GST.';

alter table public.invoice_items enable row level security;

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


-- Generate next invoice number (CRI/NNNN)
create or replace function public.generate_invoice_number()
returns text
language plpgsql
security definer
as $$
declare
  v_seq integer;
begin
  v_seq := nextval('public.invoice_number_seq');
  return 'CRI/' || lpad(v_seq::text, 4, '0');
end;
$$;

comment on function public.generate_invoice_number() is 'Generate next sequential invoice number in CRI/NNNN format.';


-- Save a complete invoice with items in a single transaction
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

  -- Pass 1: compute totals (invoice row must exist before line items — FK on invoice_id)
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

  -- Pass 2: insert line items after parent invoice exists
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

comment on function public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb)
  is 'Save a complete invoice with line items in a single transaction. Returns invoice details.';


-- App users (login / operator roles; display_name shown in UI)
create table if not exists public.users (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  role text not null check (role in ('admin', 'supervisor')),
  display_name text check (display_name is null or (char_length(trim(display_name)) <= 120)),
  avatar_url text,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists users_email_idx on public.users (email);

comment on table public.users is 'App users (login / operator roles). Display name shown in UI.';
comment on column public.users.display_name is 'Name shown in the app (e.g. welcome message). Optional; falls back to email if empty.';
comment on column public.users.avatar_url is 'Public URL of operator profile photo (Supabase Storage user-avatars bucket).';

create or replace function public.my_avatar_storage_folder()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(regexp_replace(trim(coalesce(auth.jwt() ->> 'email', '')), '[^a-z0-9._-]', '_', 'g'));
$$;

grant execute on function public.my_avatar_storage_folder() to authenticated;

create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  if auth.jwt() ->> 'email' is null or trim(auth.jwt() ->> 'email') = '' then
    raise exception 'Not authenticated';
  end if;
  update public.users
  set avatar_url = nullif(trim(p_avatar_url), '')
  where lower(trim(email)) = lower(trim(auth.jwt() ->> 'email'));
  if not found then
    raise exception 'User not provisioned';
  end if;
end;
$$;

grant execute on function public.update_my_avatar(text) to authenticated;

alter table public.users enable row level security;

drop policy if exists "users_select_authenticated" on public.users;
create policy "users_select_authenticated" on public.users
  for select to authenticated using (public.is_supervisor_or_admin());

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

drop policy if exists "users_update_admin" on public.users;
create policy "users_update_admin" on public.users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users_delete_admin" on public.users;
create policy "users_delete_admin" on public.users
  for delete to authenticated using (public.is_admin());

-- Employees (pump staff who receive salary – distinct from app users)
create table if not exists public.employees (
  id uuid primary key default uuid_generate_v4(),
  name text not null check (char_length(trim(name)) > 0 and char_length(name) <= 120),
  role_display text check (char_length(role_display) <= 60),
  monthly_salary numeric(14,2) not null default 0 check (monthly_salary >= 0),
  aadhar_number text check (aadhar_number is null or aadhar_number ~ '^[0-9]{12}$'),
  address text check (address is null or char_length(trim(address)) <= 500),
  phone_number text check (phone_number is null or phone_number ~ '^[0-9]{10}$'),
  pan_number text check (pan_number is null or pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  pf_number text check (pf_number is null or (char_length(trim(pf_number)) > 0 and char_length(pf_number) <= 30)),
  pf_contribution numeric(14,2) check (pf_contribution is null or pf_contribution >= 0),
  blood_group text check (
    blood_group is null
    or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  ),
  photo_url text,
  date_of_birth date,
  id_valid_from date,
  id_valid_to date,
  display_order smallint not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists employees_display_order_idx on public.employees (display_order, name);

comment on table public.employees is 'Pump employees who receive salary. Mutations: admin or supervisor (delete: admin only). Used for salary and attendance.';
comment on column public.employees.photo_url is 'Public URL of staff photo for ID card (staff-photos bucket).';
comment on column public.employees.date_of_birth is 'Date of birth (shown on staff ID card).';
comment on column public.employees.id_valid_from is 'ID card valid from (back of card).';
comment on column public.employees.id_valid_to is 'ID card valid until (back of card).';

create or replace function public.set_employee_photo(p_employee_id uuid, p_photo_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Staff access required';
  end if;
  update public.employees
  set photo_url = nullif(trim(p_photo_url), '')
  where id = p_employee_id and is_active = true;
  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

grant execute on function public.set_employee_photo(uuid, text) to authenticated;

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

comment on function public.list_employees_roster() is
  'Active employees without PII — for salary and attendance (provisioned staff only).';

grant execute on function public.list_employees_roster() to authenticated;

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

comment on function public.list_employees_salary() is
  'Active employees with HR Staff page fields for salary slips (provisioned staff only).';

grant execute on function public.list_employees_salary() to authenticated;

alter table public.employees enable row level security;

drop policy if exists "employees_select_admin" on public.employees;
drop policy if exists "employees_select_staff" on public.employees;
create policy "employees_select_staff" on public.employees
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "employees_insert_own_or_admin" on public.employees;
drop policy if exists "employees_insert_admin" on public.employees;
drop policy if exists "employees_insert_staff" on public.employees;
create policy "employees_insert_staff" on public.employees
  for insert to authenticated with check (public.is_supervisor_or_admin());

drop policy if exists "employees_update_by_role" on public.employees;
drop policy if exists "employees_update_admin" on public.employees;
drop policy if exists "employees_update_staff" on public.employees;
create policy "employees_update_staff" on public.employees
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "employees_delete_admin" on public.employees;
create policy "employees_delete_admin" on public.employees
  for delete to authenticated using (public.is_admin());

-- Salary payments (installments: employees receive salary in parts on different days)
create table if not exists public.salary_payments (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  date date not null,
  salary_month date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists salary_payments_employee_date_idx on public.salary_payments (employee_id, date desc);
create index if not exists salary_payments_date_idx on public.salary_payments (date desc);
create index if not exists salary_payments_salary_month_idx on public.salary_payments (salary_month desc, employee_id);

comment on table public.salary_payments is 'Installment salary payments to employees. salary_month is the pay period; date is when cash was paid.';

alter table public.salary_payments enable row level security;

drop policy if exists "salary_payments_select_authenticated" on public.salary_payments;
create policy "salary_payments_select_authenticated" on public.salary_payments
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "salary_payments_insert_own" on public.salary_payments;
create policy "salary_payments_insert_own" on public.salary_payments
  for insert to authenticated with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "salary_payments_update_by_role" on public.salary_payments;
create policy "salary_payments_update_by_role" on public.salary_payments
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "salary_payments_delete_admin" on public.salary_payments;
create policy "salary_payments_delete_admin" on public.salary_payments
  for delete to authenticated using (public.is_admin());

-- Salary month exclusions (admin marks employee + month as not applicable)
create table if not exists public.salary_month_exclusions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  salary_month date not null,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  unique (employee_id, salary_month),
  constraint salary_month_exclusions_month_start check (salary_month = date_trunc('month', salary_month)::date)
);

create index if not exists salary_month_exclusions_month_idx
  on public.salary_month_exclusions (salary_month desc, employee_id);

comment on table public.salary_month_exclusions is
  'Marks a calendar month as not applicable for an employee salary (admin). Excluded from payroll totals.';

alter table public.salary_month_exclusions enable row level security;

drop policy if exists "salary_month_exclusions_select" on public.salary_month_exclusions;
create policy "salary_month_exclusions_select" on public.salary_month_exclusions
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "salary_month_exclusions_insert_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_insert_admin" on public.salary_month_exclusions
  for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "salary_month_exclusions_update_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_update_admin" on public.salary_month_exclusions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "salary_month_exclusions_delete_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_delete_admin" on public.salary_month_exclusions
  for delete to authenticated using (public.is_admin());

-- Employee attendance (one row per employee per date: present/absent/half_day/leave, optional check-in/out)
create table if not exists public.employee_attendance (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.employees (id) on delete restrict,
  date date not null,
  status text not null check (status in ('present', 'absent', 'half_day', 'leave')),
  shift text,
  check_in time,
  check_out time,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  unique (employee_id, date)
);

create index if not exists employee_attendance_date_idx on public.employee_attendance (date desc);
create index if not exists employee_attendance_employee_date_idx on public.employee_attendance (employee_id, date desc);

comment on table public.employee_attendance is 'Daily attendance for employees (present/absent/half_day/leave with optional check-in/out).';

alter table public.employee_attendance enable row level security;

drop policy if exists "employee_attendance_select_authenticated" on public.employee_attendance;
create policy "employee_attendance_select_authenticated" on public.employee_attendance
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "employee_attendance_insert_own" on public.employee_attendance;
create policy "employee_attendance_insert_own" on public.employee_attendance
  for insert to authenticated with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "employee_attendance_update_own" on public.employee_attendance;
create policy "employee_attendance_update_own" on public.employee_attendance
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "employee_attendance_delete_admin" on public.employee_attendance;
create policy "employee_attendance_delete_admin" on public.employee_attendance
  for delete to authenticated using (public.is_admin());

create or replace function public.save_employee_attendance_batch(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row jsonb;
  v_count int := 0;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Supervisor or admin access required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) as t(value)
  loop
    if v_row->>'employee_id' is null then
      continue;
    end if;
    insert into public.employee_attendance (
      employee_id, date, status, shift, note, created_by, updated_at
    )
    values (
      (v_row->>'employee_id')::uuid,
      p_date,
      coalesce(nullif(trim(v_row->>'status'), ''), 'present'),
      nullif(trim(v_row->>'shift'), ''),
      nullif(trim(v_row->>'note'), ''),
      auth.uid(),
      timezone('utc'::text, now())
    )
    on conflict (employee_id, date) do update set
      status = excluded.status,
      shift = excluded.shift,
      note = excluded.note,
      updated_at = excluded.updated_at;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;

comment on function public.save_employee_attendance_batch(date, jsonb) is
  'Upsert attendance rows for one date. Supervisor or admin only.';

grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;

-- Credit customers ledger
create table if not exists public.credit_customers (
  id uuid primary key default uuid_generate_v4(),
  customer_name text not null check (char_length(customer_name) <= 120),
  vehicle_no text check (char_length(vehicle_no) <= 32),
  mobile text check (mobile is null or char_length(trim(mobile)) <= 20),
  address text check (address is null or char_length(trim(address)) <= 500),
  amount_due numeric(14,2) not null default 0,
  prepaid_balance numeric(14,2) not null default 0 check (prepaid_balance >= 0),
  date date not null default current_date,
  last_payment date,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_amount_idx on public.credit_customers (amount_due desc);
create index if not exists credit_customers_created_at_idx on public.credit_customers (created_at desc);
create index if not exists credit_customers_date_idx on public.credit_customers (date desc);
create index if not exists credit_customers_name_norm_idx on public.credit_customers (lower(trim(customer_name)));

comment on table public.credit_customers is 'Credit ledger for fleet and institutional customers.';
comment on column public.credit_customers.date is 'Date for which this credit applies; used for day-closing credit_today sum.';
comment on column public.credit_customers.mobile is 'Customer mobile / phone (optional)';
comment on column public.credit_customers.address is 'Customer address (optional)';
comment on column public.credit_customers.prepaid_balance is 'Advance credit from overpayment. Net balance = amount_due - prepaid_balance.';

alter table public.credit_customers enable row level security;

-- SELECT: All authenticated users can view all records
drop policy if exists "credit_select_authenticated" on public.credit_customers;
drop policy if exists "credit_select_by_role" on public.credit_customers;
create policy "credit_select_authenticated" on public.credit_customers
  for select
  to authenticated
  using (public.is_supervisor_or_admin());

-- INSERT: Users can only insert records owned by themselves
drop policy if exists "credit_insert_authenticated" on public.credit_customers;
drop policy if exists "credit_insert_own" on public.credit_customers;
create policy "credit_insert_own" on public.credit_customers
  for insert
  to authenticated
  with check (
    public.is_supervisor_or_admin() and created_by = auth.uid()
  );

-- UPDATE: Supervisors and admins (contact info; amount_due also updated by payment RPC/triggers)
drop policy if exists "credit_update_authenticated" on public.credit_customers;
drop policy if exists "credit_update_by_role" on public.credit_customers;
create policy "credit_update_by_role" on public.credit_customers
  for update
  to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

-- DELETE: Only admins can delete credit records (audit trail protection)
drop policy if exists "credit_delete_authenticated" on public.credit_customers;
drop policy if exists "credit_delete_admin" on public.credit_customers;
create policy "credit_delete_admin" on public.credit_customers
  for delete
  to authenticated
  using (
    public.is_admin()
  );

-- ============================================================================
-- CREDIT ENTRIES (one row per credit sale – Transaction Date = DSR date)
-- ============================================================================
create table if not exists public.credit_entries (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  transaction_date date not null,
  fuel_type text not null check (fuel_type in ('MS', 'HSD')),
  quantity numeric(14,3) not null check (quantity > 0),
  amount numeric(14,2) not null check (amount > 0),
  amount_settled numeric(14,2) not null default 0 check (amount_settled >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint credit_entries_settled_le_amount check (amount_settled <= amount)
);

create index if not exists credit_entries_customer_date_idx on public.credit_entries (credit_customer_id, transaction_date);
create index if not exists credit_entries_transaction_date_idx on public.credit_entries (transaction_date desc);
create index if not exists credit_entries_open_fifo_idx
  on public.credit_entries (credit_customer_id, transaction_date, id)
  where amount_settled < amount;

comment on table public.credit_entries is 'One row per credit sale. Transaction date = DSR date (business date of fuel delivery).';
comment on column public.credit_entries.transaction_date is 'Business date when fuel was dispensed on credit; drives DSR credit_today.';
comment on column public.credit_entries.amount_settled is 'Amount already paid against this entry (FIFO allocation).';

alter table public.credit_entries enable row level security;

drop policy if exists "credit_entries_select_authenticated" on public.credit_entries;
create policy "credit_entries_select_authenticated" on public.credit_entries
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "credit_entries_insert_own" on public.credit_entries;
create policy "credit_entries_insert_own" on public.credit_entries
  for insert to authenticated with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "credit_entries_update_by_role" on public.credit_entries;
create policy "credit_entries_update_by_role" on public.credit_entries
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "credit_entries_delete_admin" on public.credit_entries;
create policy "credit_entries_delete_admin" on public.credit_entries
  for delete to authenticated using (public.is_admin());

create or replace function public.credit_entries_sync_amount_due()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  if coalesce(current_setting('app.skip_credit_sync', true), '') = 'true' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    v_customer_id := old.credit_customer_id;
  else
    v_customer_id := new.credit_customer_id;
  end if;
  perform public.sync_credit_customer_balances(v_customer_id);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create or replace function public.sync_credit_customer_balances(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_due numeric;
  v_prepaid numeric;
  v_payment_total numeric;
  v_settled_total numeric;
begin
  select
    coalesce(sum(amount - amount_settled), 0),
    coalesce(sum(amount_settled), 0)
  into v_new_due, v_settled_total
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  select coalesce(sum(amount), 0) into v_payment_total
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id;

  v_prepaid := greatest(0, v_payment_total - v_settled_total);

  update public.credit_customers
  set amount_due = v_new_due, prepaid_balance = v_prepaid
  where id = p_credit_customer_id;
end;
$$;

comment on function public.sync_credit_customer_balances(uuid) is
  'Sync amount_due and prepaid_balance from credit_entries and credit_payments.';

revoke all on function public.sync_credit_customer_balances(uuid) from public;
revoke all on function public.sync_credit_customer_balances(uuid) from authenticated;

drop trigger if exists credit_entries_sync_trigger on public.credit_entries;
create trigger credit_entries_sync_trigger
  after insert or update or delete on public.credit_entries
  for each row execute function public.credit_entries_sync_amount_due();

-- ============================================================================
-- CREDIT PAYMENTS (collection = money received from credit; Settlement Date = date)
-- ============================================================================
create table if not exists public.credit_payments (
  id uuid primary key default uuid_generate_v4(),
  credit_customer_id uuid not null references public.credit_customers (id) on delete restrict,
  date date not null,
  amount numeric(14,2) not null check (amount > 0),
  note text check (char_length(note) <= 200),
  payment_mode text check (payment_mode in ('Cash', 'UPI', 'Bank')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_payments_date_idx on public.credit_payments (date desc);
create index if not exists credit_payments_customer_idx on public.credit_payments (credit_customer_id, date desc);

comment on table public.credit_payments is 'Payments received from credit customers. Sum by date = collection for day closing.';
comment on column public.credit_payments.payment_mode is 'Mode of payment (Cash/UPI/Bank). Settlement date = date column.';

alter table public.credit_payments enable row level security;

drop policy if exists "credit_payments_select_authenticated" on public.credit_payments;
create policy "credit_payments_select_authenticated" on public.credit_payments
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "credit_payments_insert_own" on public.credit_payments;
create policy "credit_payments_insert_own" on public.credit_payments
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

drop policy if exists "credit_payments_update_by_role" on public.credit_payments;
create policy "credit_payments_update_by_role" on public.credit_payments
  for update to authenticated
  using (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_supervisor_or_admin() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "credit_payments_delete_admin" on public.credit_payments;
create policy "credit_payments_delete_admin" on public.credit_payments
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- DAY CLOSING (night cash, phone pay, computed short)
-- Formula: (Total sale + Collection + Short previous) - (Night cash + Phone pay + Credit + Expenses) = Today's short
-- ============================================================================
create table if not exists public.day_closing (
  id uuid primary key default uuid_generate_v4(),
  date date not null unique,
  night_cash numeric(14,2) not null default 0 check (night_cash >= 0),
  phone_pay numeric(14,2) not null default 0 check (phone_pay >= 0),
  short_today numeric(14,2),
  total_sale numeric(14,2),
  collection numeric(14,2),
  short_previous numeric(14,2),
  credit_today numeric(14,2),
  expenses_today numeric(14,2),
  closing_reference text,
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists day_closing_date_idx on public.day_closing (date desc);
create unique index if not exists day_closing_closing_reference_idx on public.day_closing (closing_reference) where closing_reference is not null;

comment on table public.day_closing is 'Daily closing statement: full snapshot for accounting and future reference. One row per date.';
comment on column public.day_closing.night_cash is 'Hard cash counted at day end.';
comment on column public.day_closing.phone_pay is 'Money received through PhonePe/UPI.';
comment on column public.day_closing.short_today is 'Computed short; stored for next day short_previous.';
comment on column public.day_closing.total_sale is 'Total sale (₹) at closing – snapshot for accounting.';
comment on column public.day_closing.collection is 'Collection from credit (₹) at closing – snapshot.';
comment on column public.day_closing.short_previous is 'Short carried from previous day (₹) – snapshot.';
comment on column public.day_closing.credit_today is 'New credit (₹) that day – snapshot.';
comment on column public.day_closing.expenses_today is 'Expenses (₹) that day – snapshot.';
comment on column public.day_closing.closing_reference is 'Unique reference for accounting (e.g. DC-2026-00001).';
comment on column public.day_closing.remarks is 'Optional remarks at closing.';

alter table public.day_closing enable row level security;

drop policy if exists "day_closing_select_authenticated" on public.day_closing;
create policy "day_closing_select_authenticated" on public.day_closing
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "day_closing_insert_own" on public.day_closing;
create policy "day_closing_insert_own" on public.day_closing
  for insert to authenticated
  with check (public.is_supervisor_or_admin() and created_by = auth.uid());

create or replace function public.day_closing_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;
drop trigger if exists day_closing_updated_at_trigger on public.day_closing;
create trigger day_closing_updated_at_trigger
  before update on public.day_closing
  for each row execute function public.day_closing_updated_at();

-- ============================================================================
-- NIGHT CASH COLLECTIONS (physical pickup register)
-- ============================================================================
create table if not exists public.night_cash_collections (
  id uuid primary key default uuid_generate_v4(),
  collection_reference text not null,
  from_date date not null,
  to_date date not null,
  day_count integer not null check (day_count > 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  remarks text check (char_length(remarks) <= 500),
  collected_by uuid references auth.users (id) on delete set null,
  collected_at timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone default timezone('utc'::text, now()),
  check (from_date <= to_date)
);

create unique index if not exists night_cash_collections_reference_idx
  on public.night_cash_collections (collection_reference);

create index if not exists night_cash_collections_collected_at_idx
  on public.night_cash_collections (collected_at desc);

comment on table public.night_cash_collections is
  'Register of physical night cash pickups from the pump. Immutable via the app once recorded.';
comment on column public.night_cash_collections.collection_reference is
  'Unique reference for the register (e.g. NCC-2026-00001).';
comment on column public.night_cash_collections.total_amount is
  'Sum of night_cash from all linked day_closing rows in the collection period.';

alter table public.night_cash_collections enable row level security;

drop policy if exists "night_cash_collections_select_authenticated" on public.night_cash_collections;
create policy "night_cash_collections_select_authenticated" on public.night_cash_collections
  for select to authenticated using (public.is_supervisor_or_admin());

alter table public.day_closing
  add column if not exists night_cash_collection_id uuid
  references public.night_cash_collections (id) on delete restrict;

create index if not exists day_closing_night_cash_collection_idx
  on public.day_closing (night_cash_collection_id)
  where night_cash_collection_id is not null;

comment on column public.day_closing.night_cash_collection_id is
  'When set, night cash was collected. Supervisors cannot edit; admins may still modify the closing.';

drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and (night_cash_collection_id is null or public.is_admin())
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and (night_cash_collection_id is null or public.is_admin())
  );

drop policy if exists "day_closing_delete_admin" on public.day_closing;
create policy "day_closing_delete_admin" on public.day_closing
  for delete to authenticated
  using (public.is_admin() and night_cash_collection_id is null);

create or replace function public.day_closing_block_collected_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.night_cash_collection_id is not null then
    if not public.is_admin() then
      raise exception 'Day closing for % is locked: night cash was collected (ref %). Only an admin can modify it.',
        old.date,
        (select collection_reference from public.night_cash_collections where id = old.night_cash_collection_id);
    end if;
    if new.night_cash_collection_id is distinct from old.night_cash_collection_id then
      raise exception 'Cannot change night cash collection link on a collected day closing.';
    end if;
  end if;
  if tg_op = 'DELETE' and old.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected. Remove the collection in the database first.',
      old.date;
  end if;
  if tg_op = 'UPDATE' and new.night_cash_collection_id is distinct from old.night_cash_collection_id
     and old.night_cash_collection_id is null and new.night_cash_collection_id is not null then
    return new;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists day_closing_block_collected_mutation_trigger on public.day_closing;
create trigger day_closing_block_collected_mutation_trigger
  before update or delete on public.day_closing
  for each row execute function public.day_closing_block_collected_mutation();

-- Shared day-closing totals (used by get_day_closing_breakdown and save_day_closing)
create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_expenses_today numeric := 0;
begin
  perform public.require_staff_access();

  -- Total sale: gross litres (total_sales, includes testing) × rate
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

comment on function public.compute_day_closing_components(date) is
  'Shared day-closing totals. Total sale uses gross DSR litres (incl. testing); expenses include all categories.';

grant execute on function public.compute_day_closing_components(date) to authenticated;

create or replace function public.recascade_day_closing_short_from(p_from_date date)
returns void
language plpgsql security definer
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  for v_row in
    select date, night_cash, phone_pay
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    v_components := public.compute_day_closing_components(v_row.date);
    v_short_today := (
      coalesce((v_components->>'total_sale')::numeric, 0)
      + coalesce((v_components->>'collection')::numeric, 0)
      + coalesce((v_components->>'short_previous')::numeric, 0)
    ) - (
      v_row.night_cash + v_row.phone_pay
      + coalesce((v_components->>'credit_today')::numeric, 0)
      + coalesce((v_components->>'expenses_today')::numeric, 0)
    );

    update public.day_closing set
      total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
      collection = coalesce((v_components->>'collection')::numeric, 0),
      short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
      credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
      expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
      short_today = v_short_today
    where date = v_row.date;
  end loop;
end;
$$;

comment on function public.recascade_day_closing_short_from(date) is
  'After a day closing overwrite, recalculate short chain for all later closed dates.';

grant execute on function public.recascade_day_closing_short_from(date) to service_role;
revoke all on function public.recascade_day_closing_short_from(date) from public;
revoke all on function public.recascade_day_closing_short_from(date) from authenticated;

-- RPC: Get day closing breakdown; when already_saved returns stored snapshot (for accounting)
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_live numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and (not v_night_cash_collected or public.is_admin());
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
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref
  );
end;
$$;
comment on function public.get_day_closing_breakdown(date) is
  'Returns day closing components. Supervisors may edit until night cash is collected; after collection only admins may edit.';

-- RPC: Available (uncollected) night cash summary
create or replace function public.get_night_cash_available()
returns jsonb
language plpgsql security definer
as $$
declare
  v_total numeric := 0;
  v_count int := 0;
  v_from date;
  v_to date;
  v_days jsonb;
begin
  perform public.require_staff_access();

  select
    coalesce(sum(night_cash), 0),
    count(*)::int,
    min(date),
    max(date),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', date,
        'night_cash', night_cash,
        'closing_reference', closing_reference
      ) order by date asc
    ), '[]'::jsonb)
  into v_total, v_count, v_from, v_to, v_days
  from public.day_closing
  where night_cash_collection_id is null;

  return jsonb_build_object(
    'total_available', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'from_date', v_from,
    'to_date', v_to,
    'days', v_days
  );
end;
$$;

comment on function public.get_night_cash_available() is
  'Sum of uncollected night cash from saved day closings, with per-day breakdown.';

create or replace function public.preview_night_cash_collection(
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_included jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_collected_count int := 0;
  v_missing_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can preview night cash collection';
  end if;

  if p_from_date is null or p_to_date is null then
    raise exception 'from_date and to_date are required';
  end if;
  if p_from_date > p_to_date then
    raise exception 'from_date must be on or before to_date';
  end if;

  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', dc.date,
        'night_cash', dc.night_cash,
        'closing_reference', dc.closing_reference
      ) order by dc.date asc
    ) filter (where dc.night_cash_collection_id is null), '[]'::jsonb),
    coalesce(sum(dc.night_cash) filter (where dc.night_cash_collection_id is null), 0),
    count(*) filter (where dc.night_cash_collection_id is null)::int,
    count(*) filter (where dc.night_cash_collection_id is not null)::int
  into v_included, v_total, v_count, v_collected_count
  from public.day_closing dc
  where dc.date between p_from_date and p_to_date;

  v_missing_count := (p_to_date - p_from_date + 1) - v_count - v_collected_count;

  return jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'total_amount', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'days', v_included,
    'already_collected_count', coalesce(v_collected_count, 0),
    'missing_closing_count', greatest(coalesce(v_missing_count, 0), 0)
  );
end;
$$;

comment on function public.preview_night_cash_collection(date, date) is
  'Admin-only: preview uncollected night cash in a date range before recording collection.';

create or replace function public.collect_night_cash(
  p_from_date date,
  p_to_date date,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_preview jsonb;
  v_total numeric;
  v_count int;
  v_collection_id uuid;
  v_ref text;
  v_seq bigint;
  v_year int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can record night cash collection';
  end if;

  v_preview := public.preview_night_cash_collection(p_from_date, p_to_date);
  v_total := coalesce((v_preview->>'total_amount')::numeric, 0);
  v_count := coalesce((v_preview->>'day_count')::int, 0);

  if v_count = 0 then
    raise exception 'No uncollected day closings in this date range';
  end if;

  v_year := extract(year from p_to_date)::int;
  select coalesce(max(
    nullif(regexp_replace(collection_reference, '^NCC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
  ), 0) + 1 into v_seq
  from public.night_cash_collections
  where extract(year from collected_at) = v_year
    and collection_reference ~ '^NCC-[0-9]+-[0-9]+$';

  v_ref := 'NCC-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');

  insert into public.night_cash_collections (
    collection_reference, from_date, to_date, day_count, total_amount,
    remarks, collected_by
  )
  values (
    v_ref, p_from_date, p_to_date, v_count, v_total,
    nullif(trim(p_remarks), ''), auth.uid()
  )
  returning id into v_collection_id;

  update public.day_closing
  set night_cash_collection_id = v_collection_id
  where date between p_from_date and p_to_date
    and night_cash_collection_id is null;

  return jsonb_build_object(
    'id', v_collection_id,
    'collection_reference', v_ref,
    'from_date', p_from_date,
    'to_date', p_to_date,
    'day_count', v_count,
    'total_amount', v_total,
    'remarks', nullif(trim(p_remarks), ''),
    'days', v_preview->'days'
  );
end;
$$;

comment on function public.collect_night_cash(date, date, text) is
  'Admin-only: record physical night cash collection for a date range. Locks linked day closings.';

-- RPC: Save day closing with full statement snapshot and accounting reference
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
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

  select closing_reference, night_cash_collection_id into v_existing
  from public.day_closing where date = p_date;
  if found then
    if v_existing.night_cash_collection_id is not null and not public.is_admin() then
      raise exception 'Day closing for % is locked: night cash was collected. Only an admin can modify it.', p_date;
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
comment on function public.save_day_closing(date, numeric, numeric, text) is
  'Save or overwrite day closing. Supervisors may edit until night cash is collected; after collection only admins may edit.';

-- RPC: Add credit entry (Transaction Date = DSR date)
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
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
  v_remaining numeric;
  v_entry record;
  v_alloc numeric;
  v_prepaid numeric;
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

  select prepaid_balance into v_prepaid
  from public.credit_customers
  where id = v_customer_id;

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
  end if;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;
comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text) is 'Add a credit sale. Optional mobile/address on new or existing customer. Rejects future dates.';

-- RPC: Record credit payment (FIFO allocation; Settlement Date; payment_mode)
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_prepaid numeric;
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

    insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
    values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

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

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;
comment on function public.record_credit_payment(uuid, date, numeric, text, text) is 'Record payment; allocate to entries FIFO. Overpayment is stored as prepaid_balance.';

-- Re-apply FIFO settlements after a payment is removed (admin delete)
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay record;
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    update public.credit_entries
    set amount_settled = 0
    where credit_customer_id = p_credit_customer_id;

    for v_pay in
      select id, amount
      from public.credit_payments
      where credit_customer_id = p_credit_customer_id
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
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
    end loop;

    perform public.sync_credit_customer_balances(p_credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);
end;
$$;

comment on function public.reallocate_credit_settlements(uuid) is
  'Reset amount_settled on all entries for a customer, then re-apply remaining payments FIFO.';

revoke all on function public.reallocate_credit_settlements(uuid) from public;
revoke all on function public.reallocate_credit_settlements(uuid) from authenticated;

create or replace function public.sync_saved_day_closing_for_date(p_date date)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  select night_cash, phone_pay
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_short_today := (
    coalesce((v_components->>'total_sale')::numeric, 0)
    + coalesce((v_components->>'collection')::numeric, 0)
    + coalesce((v_components->>'short_previous')::numeric, 0)
  ) - (
    coalesce(v_row.night_cash, 0) + coalesce(v_row.phone_pay, 0)
    + coalesce((v_components->>'credit_today')::numeric, 0)
    + coalesce((v_components->>'expenses_today')::numeric, 0)
  );

  update public.day_closing set
    total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
    collection = coalesce((v_components->>'collection')::numeric, 0),
    short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
    credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
    expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.sync_saved_day_closing_for_date(date) is
  'Refresh saved day_closing snapshot from live DSR/credit/expense data and recascade short chain.';

revoke all on function public.sync_saved_day_closing_for_date(date) from public;
revoke all on function public.sync_saved_day_closing_for_date(date) from authenticated;

create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_prepaid numeric;
  v_last_payment date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    delete from public.credit_payments where id = p_payment_id;
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id;

  update public.credit_customers
  set last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  perform public.sync_saved_day_closing_for_date(v_payment.date);

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_payment(uuid) is
  'Admin-only: delete a credit settlement and re-allocate remaining payments FIFO.';

create or replace function public.delete_day_closing(p_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row record;
  v_latest_date date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete day closing records';
  end if;

  select * into v_row from public.day_closing where id = p_id;
  if not found then
    raise exception 'Day closing record not found';
  end if;

  if v_row.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected.', v_row.date;
  end if;

  select max(date) into v_latest_date from public.day_closing;

  if v_row.date < v_latest_date then
    raise exception 'Only the most recent day closing can be deleted. Remove newer closings first.';
  end if;

  delete from public.day_closing where id = p_id;

  return jsonb_build_object(
    'date', v_row.date,
    'closing_reference', v_row.closing_reference
  );
end;
$$;

comment on function public.delete_day_closing(uuid) is
  'Admin-only: delete the latest day closing so the date can be re-closed.';

create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_entry record;
  v_new_due numeric;
  v_prepaid numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit entries';
  end if;

  select * into v_entry
  from public.credit_entries
  where id = p_entry_id;

  if not found then
    raise exception 'Credit entry not found';
  end if;

  if coalesce(v_entry.amount_settled, 0) > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    begin
      delete from public.credit_entries where id = p_entry_id;
      perform public.reallocate_credit_settlements(v_entry.credit_customer_id);
    exception
      when others then
        perform set_config('app.skip_credit_sync', '', true);
        raise;
    end;
    perform set_config('app.skip_credit_sync', '', true);
  else
    delete from public.credit_entries where id = p_entry_id;
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_entry.credit_customer_id;

  perform public.sync_saved_day_closing_for_date(v_entry.transaction_date);

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount,
    'transaction_date', v_entry.transaction_date,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_entry(uuid) is
  'Admin-only: delete a credit sale entry. Settled entries re-allocate remaining payments FIFO.';

-- Open credit as of date D (entries with transaction_date <= D minus payments with date <= D)
create or replace function public.get_open_credit_as_of(p_date date)
returns numeric
language plpgsql security definer stable
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
comment on function public.get_open_credit_as_of(date) is 'Total outstanding credit as of date D; all customers, clamped >= 0 (matches overdue list).';

create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language plpgsql security definer stable
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
comment on function public.get_outstanding_credit_list_as_of(date) is 'Customers with outstanding balance as of date D; one row per customer (grouped by name). sale_date is the latest credit entry date on or before D; last_payment_date is as of D.';

-- Credit summary for a single customer (by name) as of a date (for overdue page detail modal)
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
comment on function public.get_customer_credit_summary_as_of(text, date) is 'Credit summary for one customer (by name) as of date: credit_taken, settlement_done, remaining (clamped >= 0).';

-- Per-entry breakdown of credit and settlement for a customer (by name) as of a date
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
comment on function public.get_customer_credit_breakdown_as_of(text, date) is 'Per-entry breakdown: credit and payment rows with date and amount for overdue detail modal.';

-- Combined: summary + breakdown in one call (one round-trip for overdue modal)
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
         a.last_payment_date, a.first_sale_date, a.last_credit_date, cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;
comment on function public.get_customer_credit_detail_as_of(text, date) is 'Combined credit detail: summary + credit_entries and payment_entries jsonb for overdue modal (one round-trip).';

-- Credit ledger aggregated by customer name (one row per customer; primary id for Settle/Delete)
create or replace function public.get_credit_ledger_aggregated()
returns table (
  id uuid,
  customer_name text,
  vehicle_no text,
  amount_due numeric,
  prepaid_balance numeric,
  date date,
  last_payment date,
  notes text
)
language plpgsql security definer stable
as $$
begin
  perform public.require_staff_access();
  return query
  with ranked as (
    select c.id, c.customer_name, c.vehicle_no, c.amount_due, c.prepaid_balance, c.date, c.last_payment, c.notes,
           row_number() over (
             partition by lower(trim(c.customer_name))
             order by c.amount_due desc nulls last, c.prepaid_balance desc nulls last, c.created_at desc
           ) as rn
    from public.credit_customers c
  ),
  agg as (
    select lower(trim(r.customer_name)) as name_key,
           sum(r.amount_due) as total_due,
           sum(r.prepaid_balance) as total_prepaid,
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
         a.total_prepaid::numeric as prepaid_balance,
         a.min_date as date,
         a.max_last_pay as last_payment,
         a.first_notes::text as notes
  from ranked r
  join agg a on lower(trim(r.customer_name)) = a.name_key
  where r.rn = 1
  order by
    case when a.total_prepaid > 0 and a.total_due <= a.total_prepaid then 0 else 1 end,
    case
      when a.total_prepaid > 0 and a.total_due <= a.total_prepaid then a.total_prepaid
      else a.total_due - a.total_prepaid
    end desc nulls last,
    r.customer_name;
end;
$$;
comment on function public.get_credit_ledger_aggregated() is 'Credit ledger with one row per customer (grouped by name). Advance payments listed first.';

-- Portfolio credit activity for overview page (totals + per-customer breakdown)
create or replace function public.get_credit_overview_period(
  p_from date,
  p_to date
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  credit_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(e.amount), 0)::numeric as credit_taken
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_to
      and (p_from is null or e.transaction_date >= p_from)
    group by 1
  ),
  payment_agg as (
    select lower(trim(c.customer_name)) as name_key,
           min(c.customer_name)::text as customer_name,
           coalesce(sum(p.amount), 0)::numeric as settled
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_to
      and (p_from is null or p.date >= p_from)
    group by 1
  ),
  merged as (
    select coalesce(c.customer_name, p.customer_name) as customer_name,
           coalesce(c.credit_taken, 0) as credit_taken,
           coalesce(p.settled, 0) as settled,
           coalesce(c.credit_taken, 0) - coalesce(p.settled, 0) as overdue
    from credit_agg c
    full outer join payment_agg p using (name_key)
  ),
  totals as (
    select coalesce((select sum(credit_taken) from credit_agg), 0)::numeric as credit_taken,
           coalesce((select sum(settled) from payment_agg), 0)::numeric as settled
  ),
  top_customers as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'credit_taken', s.credit_taken,
          'settled', s.settled,
          'overdue', s.overdue
        )
        order by s.credit_taken desc, s.customer_name
      ),
      '[]'::jsonb
    ) as rows
    from (
      select customer_name, credit_taken, settled, overdue
      from merged
      where credit_taken > 0 or settled > 0
      order by credit_taken desc, customer_name
      limit 50
    ) s
  )
  select jsonb_build_object(
    'credit_taken', t.credit_taken,
    'settled', t.settled,
    'overdue', t.credit_taken - t.settled,
    'customers', tc.rows
  )
  from _auth
  cross join totals t
  cross join top_customers tc;
$$;
comment on function public.get_credit_overview_period(date, date) is
  'Portfolio credit activity for a date range (null p_from = all time): totals and per-customer breakdown.';

-- ============================================================================
-- AUDIT TRIGGERS (automatic logging of sensitive operations)
-- ============================================================================

-- Generic audit trigger function
create or replace function public.audit_trigger_fn()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'DELETE' then
    insert into public.audit_log (table_name, record_id, action, old_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, OLD.id, TG_OP, to_jsonb(OLD), auth.uid(), auth.jwt() ->> 'email');
    return OLD;
  elsif TG_OP = 'UPDATE' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(OLD), to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  elsif TG_OP = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, new_data, performed_by, performed_by_email)
    values (TG_TABLE_NAME, NEW.id, TG_OP, to_jsonb(NEW), auth.uid(), auth.jwt() ->> 'email');
    return NEW;
  end if;
  return null;
end;
$$;

comment on function public.audit_trigger_fn() is 'Generic trigger function for audit logging.';

-- Audit triggers for sensitive tables (users: full trail; financial: full trail)
drop trigger if exists audit_staff_trigger on public.users;
drop trigger if exists audit_users_trigger on public.users;
create trigger audit_users_trigger
  after insert or update or delete on public.users
  for each row execute function public.audit_trigger_fn();

-- DSR petrol: full audit
drop trigger if exists audit_dsr_petrol_trigger on public.dsr_petrol;
create trigger audit_dsr_petrol_trigger
  after insert or update or delete on public.dsr_petrol
  for each row execute function public.audit_trigger_fn();

-- DSR diesel: full audit
drop trigger if exists audit_dsr_diesel_trigger on public.dsr_diesel;
create trigger audit_dsr_diesel_trigger
  after insert or update or delete on public.dsr_diesel
  for each row execute function public.audit_trigger_fn();

-- DSR stock: audit triggers live on the underlying per-product tables (applied by prior migration).
-- No trigger needed on the dsr_stock view itself.

-- Expenses: full audit
drop trigger if exists audit_expenses_delete_trigger on public.expenses;
drop trigger if exists audit_expenses_trigger on public.expenses;
create trigger audit_expenses_trigger
  after insert or update or delete on public.expenses
  for each row execute function public.audit_trigger_fn();

-- Credit customers: full audit
drop trigger if exists audit_credit_delete_trigger on public.credit_customers;
drop trigger if exists audit_credit_trigger on public.credit_customers;
create trigger audit_credit_trigger
  after insert or update or delete on public.credit_customers
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_credit_entries_trigger on public.credit_entries;
create trigger audit_credit_entries_trigger
  after insert or update or delete on public.credit_entries
  for each row execute function public.audit_trigger_fn();

-- Staff members: full audit
drop trigger if exists audit_staff_members_trigger on public.employees;
drop trigger if exists audit_employees_trigger on public.employees;
create trigger audit_employees_trigger
  after insert or update or delete on public.employees
  for each row execute function public.audit_trigger_fn();

-- Salary payments: full audit
drop trigger if exists audit_salary_payments_trigger on public.salary_payments;
create trigger audit_salary_payments_trigger
  after insert or update or delete on public.salary_payments
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_salary_month_exclusions_trigger on public.salary_month_exclusions;
create trigger audit_salary_month_exclusions_trigger
  after insert or update or delete on public.salary_month_exclusions
  for each row execute function public.audit_trigger_fn();

-- Staff attendance: full audit
drop trigger if exists audit_staff_attendance_trigger on public.employee_attendance;
drop trigger if exists audit_employee_attendance_trigger on public.employee_attendance;
create trigger audit_employee_attendance_trigger
  after insert or update or delete on public.employee_attendance
  for each row execute function public.audit_trigger_fn();

-- Credit payments: full audit
drop trigger if exists audit_credit_payments_trigger on public.credit_payments;
create trigger audit_credit_payments_trigger
  after insert or update or delete on public.credit_payments
  for each row execute function public.audit_trigger_fn();

-- Day closing: full audit
drop trigger if exists audit_day_closing_trigger on public.day_closing;
create trigger audit_day_closing_trigger
  after insert or update or delete on public.day_closing
  for each row execute function public.audit_trigger_fn();

-- Invoices: full audit
drop trigger if exists audit_invoices_trigger on public.invoices;
create trigger audit_invoices_trigger
  after insert or update or delete on public.invoices
  for each row execute function public.audit_trigger_fn();

-- ─── Pump settings (centralized configuration) ───────────────────────────────

create table if not exists public.pump_settings (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.pump_settings is 'Single-row JSON config for station branding, alerts, shifts, pump layout, billing defaults.';

insert into public.pump_settings (id, config)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.pump_settings enable row level security;

drop policy if exists pump_settings_select_authenticated on public.pump_settings;
create policy pump_settings_select_authenticated
  on public.pump_settings for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists pump_settings_upsert_admin on public.pump_settings;
create policy pump_settings_upsert_admin
  on public.pump_settings for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.pump_settings to authenticated;
grant insert, update on public.pump_settings to authenticated;

-- RPC execute grants for authenticated clients
grant execute on function public.require_staff_access() to authenticated;
grant execute on function public.check_page_access(text) to authenticated;
grant execute on function public.update_dsr_buying_price(uuid, numeric) to authenticated;
grant execute on function public.get_day_closing_breakdown(date) to authenticated;
grant execute on function public.get_night_cash_available() to authenticated;
grant execute on function public.preview_night_cash_collection(date, date) to authenticated;
grant execute on function public.collect_night_cash(date, date, text) to authenticated;
grant execute on function public.save_day_closing(date, numeric, numeric, text) to authenticated;
grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.record_credit_payment(uuid, date, numeric, text, text) to authenticated;
grant execute on function public.delete_credit_payment(uuid) to authenticated;
grant execute on function public.delete_credit_entry(uuid) to authenticated;
grant execute on function public.delete_day_closing(uuid) to authenticated;
grant execute on function public.get_credit_ledger_aggregated() to authenticated;
grant execute on function public.get_credit_overview_period(date, date) to authenticated;
grant execute on function public.get_open_credit_as_of(date) to authenticated;
grant execute on function public.get_outstanding_credit_list_as_of(date) to authenticated;
grant execute on function public.get_customer_credit_summary_as_of(text, date) to authenticated;
grant execute on function public.get_customer_credit_detail_as_of(text, date) to authenticated;
grant execute on function public.upsert_staff(text, text, text) to authenticated;
grant execute on function public.delete_staff(text) to authenticated;
grant execute on function public.save_invoice(date, text, text, text, text, text, text, text, numeric, text, jsonb) to authenticated;
grant execute on function public.get_dsr_stock_range(date, date) to authenticated;
grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;
grant execute on function public.compute_day_closing_components(date) to authenticated;
