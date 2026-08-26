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

-- True when daily meter sheet was finished (not a shift-sync stub with meters only).
create or replace function public.dsr_meter_row_is_complete(
  p_selling_rate numeric,
  p_dip_reading numeric,
  p_stock numeric,
  p_receipts numeric
)
returns boolean
language sql
immutable
as $$
  select
    (p_selling_rate is not null and p_selling_rate > 0)
    and (
      coalesce(p_dip_reading, 0) <> 0
      or coalesce(p_stock, 0) > 0
    );
$$;

comment on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) is
  'True when daily meter sheet is finished: selling rate set and dip or stock entered. Receipts/rate alone do not count.';

grant execute on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) to authenticated;

-- RPC to update DSR buying price (used from Meter Reading → Purchase cost); bypasses RLS so admin update always succeeds.
-- Checks both dsr_petrol and dsr_diesel since caller only has the row UUID.
create or replace function public.update_dsr_buying_price(
  p_dsr_id uuid,
  p_value numeric,
  p_supplier_invoice_no text default null,
  p_supplier_gstin text default null,
  p_invoice_document_id uuid default null,
  p_purchase_delivery_per_kl numeric default null,
  p_purchase_lfr_per_kl numeric default null,
  p_purchase_delivery_total numeric default null,
  p_purchase_delivery_qty_kl numeric default null,
  p_purchase_lfr_total numeric default null,
  p_purchase_lfr_qty_kl numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta boolean := p_supplier_invoice_no is not null
    or p_supplier_gstin is not null
    or p_invoice_document_id is not null;
  v_date date;
  v_table text;
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;

  update public.dsr_petrol
  set
    buying_price_per_litre = p_value,
    supplier_invoice_no = case
      when not v_meta then supplier_invoice_no
      else nullif(trim(p_supplier_invoice_no), '')
    end,
    supplier_gstin = case
      when not v_meta then supplier_gstin
      else nullif(upper(trim(p_supplier_gstin)), '')
    end,
    invoice_document_id = case
      when not v_meta then invoice_document_id
      else p_invoice_document_id
    end,
    purchase_delivery_per_kl = coalesce(p_purchase_delivery_per_kl, purchase_delivery_per_kl),
    purchase_lfr_per_kl = coalesce(p_purchase_lfr_per_kl, purchase_lfr_per_kl),
    purchase_delivery_total = coalesce(p_purchase_delivery_total, purchase_delivery_total),
    purchase_delivery_qty_kl = coalesce(p_purchase_delivery_qty_kl, purchase_delivery_qty_kl),
    purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
    purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
  where id = p_dsr_id
  returning date into v_date;
  if found then
    v_table := 'petrol';
  else
    update public.dsr_diesel
    set
      buying_price_per_litre = p_value,
      supplier_invoice_no = case
        when not v_meta then supplier_invoice_no
        else nullif(trim(p_supplier_invoice_no), '')
      end,
      supplier_gstin = case
        when not v_meta then supplier_gstin
        else nullif(upper(trim(p_supplier_gstin)), '')
      end,
      invoice_document_id = case
        when not v_meta then invoice_document_id
        else p_invoice_document_id
      end,
      purchase_delivery_per_kl = coalesce(p_purchase_delivery_per_kl, purchase_delivery_per_kl),
      purchase_lfr_per_kl = coalesce(p_purchase_lfr_per_kl, purchase_lfr_per_kl),
      purchase_delivery_total = coalesce(p_purchase_delivery_total, purchase_delivery_total),
      purchase_delivery_qty_kl = coalesce(p_purchase_delivery_qty_kl, purchase_delivery_qty_kl),
      purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
      purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
    where id = p_dsr_id
    returning date into v_date;
    if not found then
      raise exception 'DSR record not found';
    end if;
    v_table := 'diesel';
  end if;

  if p_purchase_lfr_per_kl is not null and v_date is not null then
    if v_table = 'petrol' then
      update public.dsr_diesel
      set
        purchase_lfr_per_kl = p_purchase_lfr_per_kl,
        purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
        purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
      where date = v_date and receipts > 0;
    else
      update public.dsr_petrol
      set
        purchase_lfr_per_kl = p_purchase_lfr_per_kl,
        purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
        purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
      where date = v_date and receipts > 0;
    end if;
  end if;
end;
$$;
comment on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) is
  'Admin-only: set pre-VAT buying price, optional supplier invoice link, and per-receipt delivery/LFR. Null charge args leave existing values. Shared LFR syncs to the other product on the same date.';

grant execute on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;


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

-- Secure function to delete app user and Supabase Auth account (admin-only)
create or replace function public.delete_staff(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(p_email));
  v_auth_id uuid;
  v_app_deleted boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Access denied: Admin role required';
  end if;
  if v_email = lower(trim(auth.jwt() ->> 'email')) then
    raise exception 'Cannot delete your own account';
  end if;

  select id into v_auth_id
  from auth.users
  where lower(trim(email)) = v_email;

  delete from public.users where email = v_email;
  v_app_deleted := found;

  if v_auth_id is not null then
    delete from auth.users where id = v_auth_id;
  end if;

  return v_app_deleted or v_auth_id is not null;
end;
$$;

comment on function public.delete_staff(text) is 'Securely delete app user and Supabase Auth account with server-side admin validation.';

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
    when 'letterhead' then v_role in ('admin', 'supervisor')
    when 'reminders' then v_role in ('admin', 'supervisor')
    when 'e20-register' then v_role in ('admin', 'supervisor')
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
  supplier_invoice_no text,
  supplier_gstin text,
  invoice_document_id uuid,
  purchase_delivery_per_kl numeric(12, 4),
  purchase_lfr_per_kl numeric(12, 4),
  purchase_delivery_total numeric(14, 2),
  purchase_delivery_qty_kl numeric(12, 4),
  purchase_lfr_total numeric(14, 2),
  purchase_lfr_qty_kl numeric(12, 4),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint dsr_petrol_date_unique unique (date)
);

comment on table public.dsr_petrol is 'Petrol (MS) meter readings. One row per date (unique). From Meter Reading form.';
comment on constraint dsr_petrol_date_unique on public.dsr_petrol is
  'One MS meter row per business date (prevents day-closing / stock double-count).';
comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
comment on column public.dsr_petrol.supplier_invoice_no is
  'BPCL / supplier invoice number for this receipt day (GST purchase register).';
comment on column public.dsr_petrol.supplier_gstin is
  'Supplier GSTIN for this receipt (defaults from Settings when blank).';
comment on column public.dsr_petrol.invoice_document_id is
  'Optional link to vault purchase PDF (invoice_documents) for this receipt day.';

alter table public.dsr_petrol enable row level security;

drop policy if exists "dsr_petrol_select_authenticated" on public.dsr_petrol;
create policy "dsr_petrol_select_authenticated" on public.dsr_petrol
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "dsr_petrol_insert_own" on public.dsr_petrol;
create policy "dsr_petrol_insert_own" on public.dsr_petrol
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
    and (public.is_admin() or not public.meter_day_is_locked(date))
  );

drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
      and not public.dsr_meter_row_is_complete(
        petrol_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
    )
  );

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
  supplier_invoice_no text,
  supplier_gstin text,
  invoice_document_id uuid,
  purchase_delivery_per_kl numeric(12, 4),
  purchase_lfr_per_kl numeric(12, 4),
  purchase_delivery_total numeric(14, 2),
  purchase_delivery_qty_kl numeric(12, 4),
  purchase_lfr_total numeric(14, 2),
  purchase_lfr_qty_kl numeric(12, 4),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint dsr_diesel_date_unique unique (date)
);

create index if not exists dsr_petrol_receipts_buying_idx
  on public.dsr_petrol (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

create index if not exists dsr_diesel_receipts_buying_idx
  on public.dsr_diesel (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

create index if not exists dsr_petrol_missing_buying_idx
  on public.dsr_petrol (date desc)
  where receipts > 0
    and (buying_price_per_litre is null or buying_price_per_litre <= 0);

create index if not exists dsr_diesel_missing_buying_idx
  on public.dsr_diesel (date desc)
  where receipts > 0
    and (buying_price_per_litre is null or buying_price_per_litre <= 0);

create index if not exists dsr_petrol_invoice_document_idx
  on public.dsr_petrol (invoice_document_id)
  where invoice_document_id is not null;

create index if not exists dsr_diesel_invoice_document_idx
  on public.dsr_diesel (invoice_document_id)
  where invoice_document_id is not null;

comment on table public.dsr_diesel is 'Diesel (HSD) meter readings. One row per date (unique). From Meter Reading form.';
comment on constraint dsr_diesel_date_unique on public.dsr_diesel is
  'One HSD meter row per business date (prevents day-closing / stock double-count).';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
comment on column public.dsr_diesel.supplier_invoice_no is
  'BPCL / supplier invoice number for this receipt day (GST purchase register).';
comment on column public.dsr_diesel.supplier_gstin is
  'Supplier GSTIN for this receipt (defaults from Settings when blank).';
comment on column public.dsr_diesel.invoice_document_id is
  'Optional link to vault purchase PDF (invoice_documents) for this receipt day.';

alter table public.dsr_diesel enable row level security;

drop policy if exists "dsr_diesel_select_authenticated" on public.dsr_diesel;
create policy "dsr_diesel_select_authenticated" on public.dsr_diesel
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "dsr_diesel_insert_own" on public.dsr_diesel;
create policy "dsr_diesel_insert_own" on public.dsr_diesel
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
    and (public.is_admin() or not public.meter_day_is_locked(date))
  );

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
      and not public.dsr_meter_row_is_complete(
        diesel_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
    )
  );

drop policy if exists "dsr_diesel_delete_admin" on public.dsr_diesel;
create policy "dsr_diesel_delete_admin" on public.dsr_diesel
  for delete to authenticated using (public.is_admin());

-- Backward-compatible union view (used by dashboard, sales-daily, analysis, day-closing)
create or replace view public.dsr
with (security_invoker = true) as
  select id, date, 'petrol'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date) *
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
  union all
  select id, date, 'diesel'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date) *
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d;

comment on view public.dsr is
  'Backward-compatible union view (one row per product per date). SELECT only; writes go to dsr_petrol / dsr_diesel.';


-- ============================================================================
-- DSR STOCK: computed stock reconciliation view (derived from dsr_petrol/dsr_diesel)
-- ============================================================================
-- All stock values are derived on-the-fly: opening_stock = previous day's
-- dip_stock (LAG window), closing_stock = total_stock - net_sale, etc.
-- No separate tables needed; always consistent with meter readings.
-- At ~730 rows/year the window function is trivial.

create or replace view public.dsr_stock
with (security_invoker = true) as
with base as (
  select
    date,
    'petrol'::text as product,
    (
      case
        when public.dsr_meter_row_is_complete(petrol_rate, dip_reading, stock, receipts)
          then stock
        else null
      end
    )::numeric(14,2) as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from (
    select distinct on (date) *
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
  union all
  select
    date,
    'diesel'::text as product,
    (
      case
        when public.dsr_meter_row_is_complete(diesel_rate, dip_reading, stock, receipts)
          then stock
        else null
      end
    )::numeric(14,2) as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from (
    select distinct on (date) *
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d
),
with_opening as (
  select
    b.*,
    coalesce(
      (
        select p.dip_stock
        from base p
        where p.product = b.product
          and p.date < b.date
          and p.dip_stock is not null
        order by p.date desc
        limit 1
      ),
      0
    )::numeric(14,2) as opening_stock
  from base b
)
select
  date,
  product,
  opening_stock,
  receipts,
  (opening_stock + receipts)::numeric(14,2) as total_stock,
  sale_from_meter,
  testing,
  net_sale,
  ((opening_stock + receipts) - net_sale)::numeric(14,2) as closing_stock,
  dip_stock,
  (
    case
      when dip_stock is null then null
      else (((opening_stock + receipts) - net_sale) - dip_stock)
    end
  )::numeric(14,2) as variation,
  remark,
  created_by,
  created_at
from with_opening;

comment on view public.dsr_stock is
  'Stock reconciliation from dsr_petrol/dsr_diesel. Shift stubs (no rate/dip/stock) expose NULL dip_stock so opening looks back to last real dip.';


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
    select
      d.date,
      'petrol'::text as product,
      case
        when public.dsr_meter_row_is_complete(d.petrol_rate, d.dip_reading, d.stock, d.receipts)
          then d.stock
        else null
      end::numeric(14,2) as dip_stock,
      d.receipts,
      d.total_sales as sale_from_meter,
      d.testing,
      greatest(d.total_sales - d.testing, 0) as net_sale,
      d.remarks as remark,
      d.created_by,
      d.created_at
    from (
      select distinct on (p.date) p.*
      from public.dsr_petrol p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
    union all
    select
      d.date,
      'diesel'::text,
      case
        when public.dsr_meter_row_is_complete(d.diesel_rate, d.dip_reading, d.stock, d.receipts)
          then d.stock
        else null
      end::numeric(14,2),
      d.receipts,
      d.total_sales,
      d.testing,
      greatest(d.total_sales - d.testing, 0),
      d.remarks,
      d.created_by,
      d.created_at
    from (
      select distinct on (p.date) p.*
      from public.dsr_diesel p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
  ),
  with_opening as (
    select
      b.*,
      coalesce(
        (
          select p.dip_stock
          from base p
          where p.product = b.product
            and p.date < b.date
            and p.dip_stock is not null
          order by p.date desc
          limit 1
        ),
        0
      ) as opening_stock
    from base b
  )
  select
    w.date,
    w.product,
    w.opening_stock,
    w.receipts,
    (w.opening_stock + w.receipts) as total_stock,
    w.sale_from_meter,
    w.testing,
    w.net_sale,
    ((w.opening_stock + w.receipts) - w.net_sale) as closing_stock,
    w.dip_stock,
    case
      when w.dip_stock is null then null
      else (((w.opening_stock + w.receipts) - w.net_sale) - w.dip_stock)
    end as variation,
    w.remark,
    w.created_by,
    w.created_at
  from with_opening w
  where w.date >= p_start and w.date <= p_end;
end;
$$;

comment on function public.get_dsr_stock_range(date, date) is
  'DSR stock range; incomplete shift stubs return NULL dip_stock; opening uses last real dip before the date.';


-- Operating expenses
create table if not exists public.expenses (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  category text,
  description text,
  amount numeric(14,2) not null default 0,
  salary_payment_id uuid references public.salary_payments (id) on delete set null,
  employee_id uuid references public.employees (id) on delete set null,
  shift text check (shift is null or shift in ('morning', 'afternoon')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create unique index if not exists expenses_salary_payment_id_unique on public.expenses (salary_payment_id) where salary_payment_id is not null;

create index if not exists expenses_date_idx on public.expenses (date desc);
create index if not exists expenses_created_at_idx on public.expenses (created_at desc);
create index if not exists expenses_category_idx on public.expenses (category);
create index if not exists expenses_shift_staff_idx
  on public.expenses (date, shift, employee_id)
  where employee_id is not null;

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
    or (
      public.is_supervisor_or_admin()
      and created_by = auth.uid()
      and employee_id is not null
      and shift is not null
    )
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


-- Typed letterhead history (blank stationery is not stored)
create table if not exists public.letterhead_letters (
  id uuid primary key default uuid_generate_v4(),
  letter_date date not null default current_date,
  subject text not null default '',
  body text not null default '',
  export_type text not null default 'print'
    check (export_type in ('print', 'word')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint letterhead_letters_has_content check (
    length(trim(subject)) > 0 or length(trim(body)) > 0
  )
);

create index if not exists letterhead_letters_date_idx
  on public.letterhead_letters (letter_date desc, created_at desc);

create index if not exists letterhead_letters_created_at_idx
  on public.letterhead_letters (created_at desc);

comment on table public.letterhead_letters is
  'History of typed station letterhead letters (print/Word). Blank stationery is not recorded.';

alter table public.letterhead_letters enable row level security;

drop policy if exists "letterhead_letters_select" on public.letterhead_letters;
create policy "letterhead_letters_select" on public.letterhead_letters
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "letterhead_letters_insert_own" on public.letterhead_letters;
create policy "letterhead_letters_insert_own" on public.letterhead_letters
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "letterhead_letters_update_by_role" on public.letterhead_letters;
create policy "letterhead_letters_update_by_role" on public.letterhead_letters
  for update to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  );

drop policy if exists "letterhead_letters_delete_admin" on public.letterhead_letters;
create policy "letterhead_letters_delete_admin" on public.letterhead_letters
  for delete to authenticated
  using (public.is_admin());


-- Document types (user-managed; admin add/edit/delete in Settings)
create table if not exists public.document_categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  label text not null,
  folder_layout text not null default 'year'
    check (folder_layout in ('year_month', 'year')),
  sort_order int not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists document_categories_sort_idx on public.document_categories (sort_order, label);

comment on table public.document_categories is
  'User-managed document types shown in Vault upload/filter and Settings. folder_layout controls Drive path (year_month vs year).';

alter table public.document_categories enable row level security;

drop policy if exists "document_categories_select_authenticated" on public.document_categories;
create policy "document_categories_select_authenticated" on public.document_categories
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "document_categories_insert_admin" on public.document_categories;
create policy "document_categories_insert_admin" on public.document_categories
  for insert to authenticated with check (public.is_admin());

drop policy if exists "document_categories_update_admin" on public.document_categories;
create policy "document_categories_update_admin" on public.document_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "document_categories_delete_admin" on public.document_categories;
create policy "document_categories_delete_admin" on public.document_categories
  for delete to authenticated using (public.is_admin());

insert into public.document_categories (name, label, folder_layout, sort_order)
values
  ('purchase', 'Purchase invoices', 'year_month', 1),
  ('license', 'License / permit', 'year', 2),
  ('insurance', 'Insurance', 'year', 3),
  ('compliance', 'Tax / compliance', 'year', 4),
  ('bank', 'Bank / finance', 'year', 5),
  ('other', 'Other', 'year', 6)
on conflict (name) do update set
  label = excluded.label,
  folder_layout = excluded.folder_layout,
  sort_order = excluded.sort_order;

-- Pump vault documents (purchase invoices + other important files in Google Drive)
create table if not exists public.invoice_documents (
  id uuid primary key default uuid_generate_v4(),
  invoice_date date not null,
  year smallint not null,
  month smallint not null check (month between 1 and 12),
  category text not null default 'purchase',
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
create index if not exists invoice_documents_category_idx on public.invoice_documents (category);
create index if not exists invoice_documents_purchase_date_idx
  on public.invoice_documents (invoice_date desc)
  where category = 'purchase';

comment on table public.invoice_documents is
  'Pump vault documents (purchase invoices and other important files) stored in Google Drive under year/month folders.';
comment on column public.invoice_documents.category is
  'Document type slug; display label comes from document_categories.';
comment on column public.invoice_documents.invoice_date is
  'Document date used for year/month Drive folders and library filters.';

alter table public.dsr_petrol
  drop constraint if exists dsr_petrol_invoice_document_id_fkey;
alter table public.dsr_petrol
  add constraint dsr_petrol_invoice_document_id_fkey
  foreign key (invoice_document_id) references public.invoice_documents (id) on delete set null;

alter table public.dsr_diesel
  drop constraint if exists dsr_diesel_invoice_document_id_fkey;
alter table public.dsr_diesel
  add constraint dsr_diesel_invoice_document_id_fkey
  foreign key (invoice_document_id) references public.invoice_documents (id) on delete set null;

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
create index if not exists employees_active_roster_idx
  on public.employees (display_order, name)
  where is_active = true;

comment on table public.employees is 'Pump employees who receive salary. Mutations: admin or supervisor (delete: admin only). Used for salary and attendance.';
comment on column public.employees.is_active is
  'Employment status. false = inactive everywhere (salary, attendance, E-20, settings).';
comment on column public.employees.photo_url is 'Public URL of staff photo for ID card (staff-photos bucket).';
comment on column public.employees.date_of_birth is 'Date of birth (shown on staff ID card).';
comment on column public.employees.id_valid_from is 'ID card valid from (back of card).';
comment on column public.employees.id_valid_to is 'ID card valid until (back of card).';

create or replace function public.set_employee_active(
  p_employee_id uuid,
  p_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required';
  end if;

  if p_employee_id is null then
    raise exception 'Employee id is required';
  end if;

  update public.employees
  set is_active = coalesce(p_is_active, false)
  where id = p_employee_id;

  if not found then
    raise exception 'Employee not found';
  end if;
end;
$$;

comment on function public.set_employee_active(uuid, boolean) is
  'Admin-only: mark employee active or inactive. Inactive staff are excluded from all operational rosters.';

grant execute on function public.set_employee_active(uuid, boolean) to authenticated;

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
  where id = p_employee_id;
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

create or replace function public.get_employees_by_ids(p_ids uuid[])
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
  id_valid_to date,
  is_active boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform public.require_staff_access();
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
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
    e.id_valid_to,
    e.is_active
  from public.employees e
  where e.id = any (p_ids);
end;
$$;

comment on function public.get_employees_by_ids(uuid[]) is
  'Lookup employees by id including inactive — for historical salary/attendance display.';

grant execute on function public.get_employees_by_ids(uuid[]) to authenticated;

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
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_count int := 0;
  v_emp_id uuid;
  v_bad_count int;
begin
  if not public.is_supervisor_or_admin() then
    raise exception 'Supervisor or admin access required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  select count(*)::int into v_bad_count
  from (
    select distinct (t.value->>'employee_id')::uuid as emp_id
    from jsonb_array_elements(p_rows) as t(value)
    where nullif(trim(t.value->>'employee_id'), '') is not null
  ) ids
  left join public.employees e on e.id = ids.emp_id
  where e.id is null or e.is_active is not true;

  if v_bad_count > 0 then
    raise exception 'Cannot mark attendance for missing or inactive staff';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) as t(value)
  loop
    if nullif(trim(v_row->>'employee_id'), '') is null then
      continue;
    end if;

    v_emp_id := (v_row->>'employee_id')::uuid;

    insert into public.employee_attendance (
      employee_id, date, status, shift, note, created_by, updated_at
    )
    values (
      v_emp_id,
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
  'Upsert attendance rows for one date. Supervisor or admin only. Rejects inactive employees.';

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
  employee_id uuid references public.employees (id) on delete set null,
  shift text check (shift is null or shift in ('morning', 'afternoon')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  constraint credit_entries_settled_le_amount check (amount_settled <= amount)
);

create index if not exists credit_entries_customer_date_idx on public.credit_entries (credit_customer_id, transaction_date);
create index if not exists credit_entries_transaction_date_idx on public.credit_entries (transaction_date desc);
create index if not exists credit_entries_open_fifo_idx
  on public.credit_entries (credit_customer_id, transaction_date, id)
  where amount_settled < amount;
create index if not exists credit_entries_shift_staff_idx
  on public.credit_entries (transaction_date, shift, employee_id)
  where employee_id is not null;

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
  same_day_settlement boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists credit_payments_date_idx on public.credit_payments (date desc);
create index if not exists credit_payments_customer_idx on public.credit_payments (credit_customer_id, date desc);
create index if not exists credit_payments_same_day_date_idx
  on public.credit_payments (date)
  where same_day_settlement;

comment on table public.credit_payments is 'Payments received from credit customers. Sum by date = collection for day closing.';
comment on column public.credit_payments.payment_mode is 'Mode of payment (Cash/UPI/Bank). Settlement date = date column.';
comment on column public.credit_payments.same_day_settlement is
  'When true, payment settles same-day credit: excluded from Collection, counted in Night cash / Phone pay.';

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
-- REMINDERS (station todos: credit follow-ups, calls, dated tasks)
-- ============================================================================
create table if not exists public.reminders (
  id uuid primary key default uuid_generate_v4(),
  title text not null
    check (char_length(trim(title)) between 1 and 200),
  notes text
    check (notes is null or char_length(notes) <= 2000),
  -- null due_date = undated todo (Backlog); set a date to treat as a reminder
  due_date date,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  reminder_type text not null default 'general'
    check (reminder_type in ('general', 'todo', 'credit_followup', 'call', 'payment', 'other')),
  status text not null default 'open'
    check (status in ('open', 'done', 'cancelled')),
  credit_customer_id uuid references public.credit_customers (id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint reminders_completed_consistency check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null and completed_by is null)
  )
);

create index if not exists reminders_open_due_idx
  on public.reminders (due_date asc nulls last, priority)
  where status = 'open';

create index if not exists reminders_open_backlog_idx
  on public.reminders (priority, created_at desc)
  where status = 'open' and due_date is null;

create index if not exists reminders_status_due_idx
  on public.reminders (status, due_date desc nulls last, created_at desc);

create index if not exists reminders_credit_customer_idx
  on public.reminders (credit_customer_id)
  where credit_customer_id is not null;

comment on table public.reminders is
  'Station tasks: dated reminders and undated todos (credit follow-ups, calls, general work).';

comment on column public.reminders.due_date is
  'When set, item is a dated reminder. Null = undated todo in Backlog (high priority still surfaces on dashboard).';

alter table public.reminders enable row level security;

drop policy if exists "reminders_select" on public.reminders;
create policy "reminders_select" on public.reminders
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "reminders_insert_own" on public.reminders;
create policy "reminders_insert_own" on public.reminders
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "reminders_update_staff" on public.reminders;
create policy "reminders_update_staff" on public.reminders
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "reminders_delete_admin" on public.reminders;
create policy "reminders_delete_admin" on public.reminders
  for delete to authenticated
  using (public.is_admin());

-- ============================================================================
-- E-20 TESTING REGISTER (daily quality monitoring — Part A water dip + Part B 2-hourly)
-- ============================================================================
create table if not exists public.e20_testing_registers (
  id uuid primary key default uuid_generate_v4(),
  register_date date not null,
  retail_outlet_name text
    check (retail_outlet_name is null or char_length(trim(retail_outlet_name)) <= 200),
  cc_code text
    check (cc_code is null or char_length(trim(cc_code)) <= 32),
  certified boolean not null default false,
  certified_at timestamptz,
  dealer_sign_name text
    check (dealer_sign_name is null or char_length(trim(dealer_sign_name)) <= 120),
  remarks text
    check (remarks is null or char_length(remarks) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint e20_testing_registers_date_unique unique (register_date),
  constraint e20_testing_registers_certified_consistency check (
    (certified = false and certified_at is null)
    or (certified = true)
  )
);

-- Unique(register_date) already indexes date lookups; no extra date index.

comment on table public.e20_testing_registers is
  'Daily E-20 Testing Register header (outlet, CC code, RO dealer certification).';

create table if not exists public.e20_water_checks (
  id uuid primary key default uuid_generate_v4(),
  register_id uuid not null references public.e20_testing_registers (id) on delete cascade,
  check_time time,
  tank_no text not null
    check (char_length(trim(tank_no)) between 1 and 64),
  opening_dip_mm numeric(10, 2),
  water_finding_mm numeric(10, 2),
  water_present boolean,
  corrective_action text
    check (corrective_action is null or char_length(corrective_action) <= 500),
  tested_by text
    check (tested_by is null or char_length(trim(tested_by)) <= 120),
  manager_signed boolean not null default false,
  sort_order smallint not null default 0,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists e20_water_checks_register_idx
  on public.e20_water_checks (register_id, sort_order);

comment on table public.e20_water_checks is
  'Part A — morning water check through tank dip (one row per product tank).';

create table if not exists public.e20_quality_checks (
  id uuid primary key default uuid_generate_v4(),
  register_id uuid not null references public.e20_testing_registers (id) on delete cascade,
  slot_no smallint not null
    check (slot_no between 1 and 12),
  check_time time not null,
  visual_appearance text
    check (visual_appearance is null or visual_appearance in ('clear_bright', 'hazy')),
  water_separation boolean,
  action_taken text
    check (action_taken is null or char_length(action_taken) <= 500),
  tested_by text
    check (tested_by is null or char_length(trim(tested_by)) <= 120),
  tester_signed boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint e20_quality_checks_register_slot unique (register_id, slot_no)
);

-- Unique(register_id, slot_no) covers register lookups; no extra quality index.

comment on table public.e20_quality_checks is
  'Part B — E-20 petrol quality monitoring every 2 hours (12 fixed slots).';

alter table public.e20_testing_registers enable row level security;
alter table public.e20_water_checks enable row level security;
alter table public.e20_quality_checks enable row level security;

-- Header: full CRUD (delete admin-only). Children: select only — writes go through save RPC.
drop policy if exists "e20_registers_select" on public.e20_testing_registers;
create policy "e20_registers_select" on public.e20_testing_registers
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "e20_registers_insert_own" on public.e20_testing_registers;
create policy "e20_registers_insert_own" on public.e20_testing_registers
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "e20_registers_update_staff" on public.e20_testing_registers;
create policy "e20_registers_update_staff" on public.e20_testing_registers
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "e20_registers_delete_admin" on public.e20_testing_registers;
create policy "e20_registers_delete_admin" on public.e20_testing_registers
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "e20_water_select" on public.e20_water_checks;
drop policy if exists "e20_water_insert" on public.e20_water_checks;
drop policy if exists "e20_water_update" on public.e20_water_checks;
drop policy if exists "e20_water_delete" on public.e20_water_checks;
drop policy if exists "e20_water_delete_admin" on public.e20_water_checks;
create policy "e20_water_select" on public.e20_water_checks
  for select to authenticated
  using (public.is_supervisor_or_admin());
-- DELETE needed so admin parent-row cascade is not blocked by RLS.
create policy "e20_water_delete_admin" on public.e20_water_checks
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "e20_quality_select" on public.e20_quality_checks;
drop policy if exists "e20_quality_insert" on public.e20_quality_checks;
drop policy if exists "e20_quality_update" on public.e20_quality_checks;
drop policy if exists "e20_quality_delete" on public.e20_quality_checks;
drop policy if exists "e20_quality_delete_admin" on public.e20_quality_checks;
create policy "e20_quality_select" on public.e20_quality_checks
  for select to authenticated
  using (public.is_supervisor_or_admin());
create policy "e20_quality_delete_admin" on public.e20_quality_checks
  for delete to authenticated
  using (public.is_admin());

-- Parse Yes/No/boolean text from JSON payloads.
create or replace function public.e20_parse_yes_no(p_val text)
returns boolean
language sql
immutable
as $$
  select case
    when p_val is null or btrim(p_val) = '' then null
    when lower(btrim(p_val)) in ('true', 'yes', 'y', '1', 't') then true
    when lower(btrim(p_val)) in ('false', 'no', 'n', '0', 'f') then false
    else null
  end;
$$;

-- Atomic save: upsert header, replace Part A/B via set-based inserts.
create or replace function public.save_e20_testing_register(
  p_date date,
  p_outlet_name text,
  p_cc_code text,
  p_water_checks jsonb,
  p_quality_checks jsonb,
  p_certified boolean default false,
  p_certified_at timestamptz default null,
  p_dealer_sign_name text default null,
  p_remarks text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Register date is required';
  end if;

  insert into public.e20_testing_registers (
    register_date,
    retail_outlet_name,
    cc_code,
    certified,
    certified_at,
    dealer_sign_name,
    remarks,
    created_by,
    updated_at
  )
  values (
    p_date,
    nullif(btrim(coalesce(p_outlet_name, '')), ''),
    nullif(btrim(coalesce(p_cc_code, '')), ''),
    coalesce(p_certified, false),
    case
      when coalesce(p_certified, false)
        then coalesce(p_certified_at, timezone('utc'::text, now()))
      else null
    end,
    nullif(btrim(coalesce(p_dealer_sign_name, '')), ''),
    nullif(btrim(coalesce(p_remarks, '')), ''),
    auth.uid(),
    timezone('utc'::text, now())
  )
  on conflict (register_date) do update set
    retail_outlet_name = excluded.retail_outlet_name,
    cc_code = excluded.cc_code,
    certified = excluded.certified,
    certified_at = excluded.certified_at,
    dealer_sign_name = excluded.dealer_sign_name,
    remarks = excluded.remarks,
    updated_at = excluded.updated_at
  returning id into v_id;

  delete from public.e20_water_checks where register_id = v_id;
  delete from public.e20_quality_checks where register_id = v_id;

  if p_water_checks is not null and jsonb_typeof(p_water_checks) = 'array' then
    insert into public.e20_water_checks (
      register_id,
      check_time,
      tank_no,
      opening_dip_mm,
      water_finding_mm,
      water_present,
      corrective_action,
      tested_by,
      manager_signed,
      sort_order
    )
    select
      v_id,
      nullif(btrim(coalesce(t.value->>'check_time', '')), '')::time,
      btrim(t.value->>'tank_no'),
      nullif(btrim(coalesce(t.value->>'opening_dip_mm', '')), '')::numeric,
      nullif(btrim(coalesce(t.value->>'water_finding_mm', '')), '')::numeric,
      public.e20_parse_yes_no(t.value->>'water_present'),
      nullif(btrim(coalesce(t.value->>'corrective_action', '')), ''),
      nullif(btrim(coalesce(t.value->>'tested_by', '')), ''),
      coalesce(public.e20_parse_yes_no(t.value->>'manager_signed'), false),
      coalesce(nullif(t.value->>'sort_order', '')::smallint, (t.ord - 1)::smallint)
    from jsonb_array_elements(p_water_checks) with ordinality as t(value, ord)
    where nullif(btrim(coalesce(t.value->>'tank_no', '')), '') is not null;
  end if;

  if p_quality_checks is not null and jsonb_typeof(p_quality_checks) = 'array' then
    insert into public.e20_quality_checks (
      register_id,
      slot_no,
      check_time,
      visual_appearance,
      water_separation,
      action_taken,
      tested_by,
      tester_signed
    )
    select
      v_id,
      (t.value->>'slot_no')::smallint,
      btrim(t.value->>'check_time')::time,
      nullif(btrim(coalesce(t.value->>'visual_appearance', '')), ''),
      public.e20_parse_yes_no(t.value->>'water_separation'),
      nullif(btrim(coalesce(t.value->>'action_taken', '')), ''),
      nullif(btrim(coalesce(t.value->>'tested_by', '')), ''),
      coalesce(
        public.e20_parse_yes_no(coalesce(t.value->>'tester_signed', t.value->>'signed')),
        false
      )
    from jsonb_array_elements(p_quality_checks) as t(value)
    where t.value->>'slot_no' is not null
      and nullif(btrim(coalesce(t.value->>'check_time', '')), '') is not null
      and (
        nullif(btrim(coalesce(t.value->>'visual_appearance', '')), '') is not null
        or public.e20_parse_yes_no(t.value->>'water_separation') is not null
        or nullif(btrim(coalesce(t.value->>'tested_by', '')), '') is not null
        or nullif(btrim(coalesce(t.value->>'action_taken', '')), '') is not null
        or coalesce(
          public.e20_parse_yes_no(coalesce(t.value->>'tester_signed', t.value->>'signed')),
          false
        )
      );
  end if;

  return v_id;
end;
$$;

comment on function public.save_e20_testing_register(date, text, text, jsonb, jsonb, boolean, timestamptz, text, text) is
  'Upsert daily E-20 Testing Register and replace Part A/B rows (set-based). Staff only.';

grant execute on function public.save_e20_testing_register(date, text, text, jsonb, jsonb, boolean, timestamptz, text, text) to authenticated;
grant execute on function public.e20_parse_yes_no(text) to authenticated;

grant select, insert, update, delete on public.e20_testing_registers to authenticated;
grant select, delete on public.e20_water_checks to authenticated;
grant select, delete on public.e20_quality_checks to authenticated;

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
  certified boolean not null default false,
  certified_at timestamptz,
  certified_by uuid references auth.users (id) on delete set null,
  certified_by_name text check (certified_by_name is null or char_length(trim(certified_by_name)) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  constraint day_closing_certified_consistency check (
    (certified = false and certified_at is null and certified_by is null and certified_by_name is null)
    or (certified = true and certified_at is not null)
  )
);

create index if not exists day_closing_date_idx on public.day_closing (date desc);
create unique index if not exists day_closing_closing_reference_idx on public.day_closing (closing_reference) where closing_reference is not null;
create index if not exists day_closing_uncertified_idx on public.day_closing (date desc) where certified = false;

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
comment on column public.day_closing.certified is 'True after an admin acknowledges the supervisor''s saved statement.';
comment on column public.day_closing.certified_at is 'When the admin certified this closing.';
comment on column public.day_closing.certified_by is 'auth.users.id of the admin who certified.';
comment on column public.day_closing.certified_by_name is 'Display name (or email) snapshot of the certifying admin.';

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
    and (certified = false or public.is_admin())
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and (night_cash_collection_id is null or public.is_admin())
    and (certified = false or public.is_admin())
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
set search_path = public
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_ledger numeric := 0;
  v_credit_shift numeric := 0;
  v_credit_shift_gross numeric := 0;
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_same_day_settle numeric := 0;
  v_same_day_cash numeric := 0;
  v_same_day_upi numeric := 0;
  v_same_day_bank numeric := 0;
  v_payments_raw numeric := 0;
  v_credit_entries numeric := 0;
  v_credit_legacy numeric := 0;
  v_pay_cash numeric := 0;
  v_pay_upi numeric := 0;
  v_same_day_credit_reduce numeric := 0;
  v_open_credit numeric := 0;
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
  from (
    select distinct on (product)
      product, total_sales, petrol_rate, diesel_rate
    from public.dsr
    where date = p_date
    order by product, created_at desc nulls last, id desc
  ) v_row;

  with pay as (
    select
      credit_customer_id,
      sum(amount) as pay_today,
      sum(amount) filter (where coalesce(same_day_settlement, false)) as same_day_pay,
      sum(amount) filter (where not coalesce(same_day_settlement, false)) as collection_pay,
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as pay_cash,
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as pay_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as same_day_cash,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as same_day_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'bank'
      ) as same_day_bank
    from public.credit_payments
    where date = p_date
    group by credit_customer_id
  ),
  cred as (
    select
      credit_customer_id,
      sum(amount) as credit_today,
      sum(amount) filter (
        where employee_id is not null and shift is not null
      ) as credit_shift
    from public.credit_entries
    where transaction_date = p_date
    group by credit_customer_id
  ),
  split as (
    select
      coalesce(p.pay_today, 0) as pay_today,
      coalesce(p.collection_pay, 0) as collection_pay,
      coalesce(p.same_day_pay, 0) as same_day_pay,
      coalesce(p.pay_cash, 0) as pay_cash,
      coalesce(p.pay_upi, 0) as pay_upi,
      coalesce(p.same_day_cash, 0) as same_day_cash,
      coalesce(p.same_day_upi, 0) as same_day_upi,
      coalesce(p.same_day_bank, 0) as same_day_bank,
      coalesce(c.credit_today, 0) as credit_today,
      coalesce(c.credit_shift, 0) as credit_shift,
      least(coalesce(p.same_day_pay, 0), coalesce(c.credit_today, 0)) as same_day_credit_reduce
    from pay p
    full outer join cred c using (credit_customer_id)
  )
  select
    coalesce(sum(pay_today), 0),
    coalesce(sum(collection_pay), 0),
    coalesce(sum(pay_cash), 0),
    coalesce(sum(pay_upi), 0),
    coalesce(sum(credit_today), 0),
    coalesce(sum(credit_shift), 0),
    coalesce(sum(same_day_pay), 0),
    coalesce(sum(same_day_cash), 0),
    coalesce(sum(same_day_upi), 0),
    coalesce(sum(same_day_bank), 0),
    coalesce(sum(same_day_credit_reduce), 0)
  into
    v_payments_raw, v_collection,
    v_pay_cash, v_pay_upi,
    v_credit_entries, v_credit_shift_gross,
    v_same_day_settle, v_same_day_cash, v_same_day_upi, v_same_day_bank,
    v_same_day_credit_reduce
  from split;

  select coalesce(sum(c.amount_due), 0) into v_credit_legacy
  from public.credit_customers c
  where c.date = p_date
    and not exists (
      select 1 from public.credit_entries e where e.credit_customer_id = c.id
    );

  -- Day closing Credit today = open credit only (same-day settled removed).
  v_open_credit := greatest(v_credit_entries - v_same_day_credit_reduce, 0);
  v_credit_ledger := v_open_credit + v_credit_legacy;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  -- Open shift-attributed credit only (for Credit today breakdown).
  -- Gross shift credit stays on meter_shift_cash for shift short.
  v_credit_shift := least(v_credit_shift_gross, v_open_credit);

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  select
    coalesce(sum(cash_collected), 0),
    coalesce(sum(phone_pay), 0)
  into v_shift_cash, v_shift_phone
  from public.meter_shift_cash
  where reading_date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0) - coalesce(v_credit_shift, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'credit_shift_gross', coalesce(v_credit_shift_gross, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0) - coalesce(v_expenses_shift, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0),
    'shift_cash_total', coalesce(v_shift_cash, 0),
    'shift_phone_pay_total', coalesce(v_shift_phone, 0),
    'same_day_settle', coalesce(v_same_day_settle, 0),
    'same_day_settle_cash', coalesce(v_same_day_cash, 0),
    'same_day_settle_upi', coalesce(v_same_day_upi, 0),
    'same_day_settle_bank', coalesce(v_same_day_bank, 0),
    'settle_cash_total', coalesce(v_pay_cash, 0),
    'settle_upi_total', coalesce(v_pay_upi, 0),
    'suggested_night_cash', coalesce(v_shift_cash, 0) + coalesce(v_pay_cash, 0),
    'suggested_phone_pay', coalesce(v_shift_phone, 0) + coalesce(v_pay_upi, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Day closing: credit_today = open credit (same-day settled excluded). credit_shift_gross = shift register credit for shift short.';



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
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_certified boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_today numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_settle_cash numeric := 0;
  v_settle_upi numeric := 0;
  v_suggested_cash numeric := 0;
  v_suggested_phone numeric := 0;
  v_saved_cash numeric := null;
  v_saved_phone numeric := null;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.certified, dc.certified_at, dc.certified_by_name,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_certified := v_already_saved and coalesce(v_existing.certified, false);
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and (
    public.is_admin()
    or (not v_night_cash_collected and not v_certified)
  );
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  v_components := public.compute_day_closing_components(p_date);
  v_shift_cash := coalesce((v_components->>'shift_cash_total')::numeric, 0);
  v_shift_phone := coalesce((v_components->>'shift_phone_pay_total')::numeric, 0);
  v_settle_cash := coalesce((v_components->>'settle_cash_total')::numeric, 0);
  v_settle_upi := coalesce((v_components->>'settle_upi_total')::numeric, 0);
  -- Authoritative suggestion: always shift + settles (ignore stale keys)
  v_suggested_cash := v_shift_cash + v_settle_cash;
  v_suggested_phone := v_shift_phone + v_settle_upi;

  if v_already_saved then
    v_saved_cash := coalesce(v_existing.night_cash, 0);
    v_saved_phone := coalesce(v_existing.phone_pay, 0);
  end if;

  if v_use_snapshot then
    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
    v_expenses_today := coalesce(v_existing.expenses_today, 0);
  else
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'credit_ledger', coalesce((v_components->>'credit_ledger')::numeric, 0),
    'credit_shift', coalesce((v_components->>'credit_shift')::numeric, 0),
    'credit_shift_gross', coalesce((v_components->>'credit_shift_gross')::numeric, 0),
    'expenses_ledger', coalesce((v_components->>'expenses_ledger')::numeric, 0),
    'expenses_shift', coalesce((v_components->>'expenses_shift')::numeric, 0),
    'shift_cash_total', v_shift_cash,
    'shift_phone_pay_total', v_shift_phone,
    'same_day_settle', coalesce((v_components->>'same_day_settle')::numeric, 0),
    'same_day_settle_cash', coalesce((v_components->>'same_day_settle_cash')::numeric, 0),
    'same_day_settle_upi', coalesce((v_components->>'same_day_settle_upi')::numeric, 0),
    'same_day_settle_bank', coalesce((v_components->>'same_day_settle_bank')::numeric, 0),
    'settle_cash_total', v_settle_cash,
    'settle_upi_total', v_settle_upi,
    'suggested_night_cash', v_suggested_cash,
    'suggested_phone_pay', v_suggested_phone,
    'saved_night_cash', v_saved_cash,
    'saved_phone_pay', v_saved_phone,
    'snapshot', v_use_snapshot,
    -- Already saved: always return registered amounts. Suggestions stay in suggested_*.
    'night_cash', case
      when v_already_saved then v_saved_cash
      else v_suggested_cash
    end,
    'phone_pay', case
      when v_already_saved then v_saved_phone
      else v_suggested_phone
    end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref,
    'certified', v_certified,
    'certified_at', case when v_certified then v_existing.certified_at else null end,
    'certified_by_name', case when v_certified then v_existing.certified_by_name else null end,
    'can_certify', v_already_saved and not v_certified and public.is_admin()
  );
end;
$$;

comment on function public.get_day_closing_breakdown(date) is
  'Day closing breakdown. suggested_* = shift + Cash/UPI settles; night_cash/phone_pay = saved when already registered, else suggested.';


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

  select closing_reference, night_cash_collection_id, certified into v_existing
  from public.day_closing where date = p_date;
  if found then
    if v_existing.night_cash_collection_id is not null and not public.is_admin() then
      raise exception 'Day closing for % is locked: night cash was collected. Only an admin can modify it.', p_date;
    end if;
    if coalesce(v_existing.certified, false) and not public.is_admin() then
      raise exception 'Day closing for % is locked: it has been certified. Only an admin can modify it.', p_date;
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
      remarks = nullif(trim(p_remarks), ''),
      certified = false,
      certified_at = null,
      certified_by = null,
      certified_by_name = null
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
    'overwritten', v_is_overwrite,
    'certified', false
  );
end;
$$;
comment on function public.save_day_closing(date, numeric, numeric, text) is
  'Save or overwrite day closing. Supervisors may edit until certified or night cash is collected. Overwrite clears certification.';

create or replace function public.set_day_closing_certified(
  p_date date,
  p_certified boolean
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_existing record;
  v_name text;
  v_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can certify or remove certification on a day closing';
  end if;

  if p_date is null then
    raise exception 'date is required';
  end if;

  select date, closing_reference, certified, certified_at, certified_by_name
  into v_existing
  from public.day_closing
  where date = p_date
  for update;

  if not found then
    raise exception 'Save day closing for % before certifying it.', p_date;
  end if;

  if coalesce(p_certified, false) then
    if coalesce(v_existing.certified, false) then
      return jsonb_build_object(
        'date', v_existing.date,
        'closing_reference', v_existing.closing_reference,
        'certified', true,
        'certified_at', v_existing.certified_at,
        'certified_by_name', v_existing.certified_by_name
      );
    end if;

    select coalesce(nullif(trim(u.display_name), ''), u.email)
    into v_name
    from public.users u
    where lower(trim(u.email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    limit 1;
    v_name := coalesce(nullif(trim(v_name), ''), 'Admin');
    v_at := timezone('utc'::text, now());

    update public.day_closing set
      certified = true,
      certified_at = v_at,
      certified_by = auth.uid(),
      certified_by_name = v_name
    where date = p_date;

    return jsonb_build_object(
      'date', p_date,
      'closing_reference', v_existing.closing_reference,
      'certified', true,
      'certified_at', v_at,
      'certified_by_name', v_name
    );
  end if;

  if not coalesce(v_existing.certified, false) then
    return jsonb_build_object(
      'date', v_existing.date,
      'closing_reference', v_existing.closing_reference,
      'certified', false,
      'certified_at', null,
      'certified_by_name', null
    );
  end if;

  update public.day_closing set
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null
  where date = p_date;

  return jsonb_build_object(
    'date', p_date,
    'closing_reference', v_existing.closing_reference,
    'certified', false,
    'certified_at', null,
    'certified_by_name', null
  );
end;
$$;

comment on function public.set_day_closing_certified(date, boolean) is
  'Admin-only: acknowledge (certify) a saved day closing, or remove certification so figures can be edited again.';

-- RPC: Add credit entry (Transaction Date = DSR date; optional shift attribution)
drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text);
drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text);

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
  p_shift text default null
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
  v_remaining numeric;
  v_entry record;
  v_alloc numeric;
  v_prepaid numeric;
  v_shift text;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
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

  insert into public.credit_entries (
    credit_customer_id, transaction_date, fuel_type, quantity, amount,
    created_by, employee_id, shift
  )
  values (
    v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount,
    auth.uid(), p_employee_id, v_shift
  )
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

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount,
    'employee_id', p_employee_id,
    'shift', v_shift
  );
end;
$$;
comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text) is
  'Add a credit sale. Optional p_employee_id + p_shift attribute to shift register. Rejects future dates.';

create or replace function public.apply_credit_payment_to_day_closing(
  p_date date,
  p_same_day_settlement boolean default false,
  p_payment_mode text default 'Cash',
  p_amount numeric default 0
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_night_cash numeric;
  v_phone_pay numeric;
  v_short_today numeric;
  v_mode text;
  v_locked boolean := false;
begin
  if p_date is null then
    return;
  end if;

  select
    night_cash, phone_pay, total_sale, collection, short_previous, credit_today,
    expenses_today, short_today, night_cash_collection_id, certified
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  v_locked := (v_row.night_cash_collection_id is not null) or coalesce(v_row.certified, false);
  if v_locked and not public.is_admin() then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_night_cash := coalesce(v_row.night_cash, 0);
  v_phone_pay := coalesce(v_row.phone_pay, 0);

  if coalesce(p_same_day_settlement, false) and coalesce(p_amount, 0) > 0
     and v_row.night_cash_collection_id is null then
    v_mode := lower(trim(coalesce(p_payment_mode, 'Cash')));
    if v_mode = 'upi' then
      v_phone_pay := v_phone_pay + p_amount;
    elsif v_mode = 'bank' then
      null;
    else
      v_night_cash := v_night_cash + p_amount;
    end if;
  end if;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (v_night_cash + v_phone_pay + v_credit_today + v_expenses_today);

  update public.day_closing set
    total_sale = v_total_sale,
    collection = v_collection,
    short_previous = v_short_previous,
    credit_today = v_credit_today,
    expenses_today = v_expenses_today,
    night_cash = v_night_cash,
    phone_pay = v_phone_pay,
    short_today = v_short_today,
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) is
  'After a credit payment: refresh day_closing open credit; same-day Cash/UPI bumps night_cash/phone_pay.';

revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from public;
revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from authenticated;

-- RPC: Record credit payment (LIFO allocation; Settlement Date; payment_mode; same-day flag)
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false
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

  perform public.apply_credit_payment_to_day_closing(
    p_date,
    coalesce(p_same_day_settlement, false),
    coalesce(p_payment_mode, 'Cash'),
    p_amount
  );

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text, boolean) is
  'Record payment. Same-day flag excludes from Collection and nets Credit today; syncs day closing.';


-- Batch settlement across multiple credit customer rows (one payment, one round trip)
create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_total_amount;
  v_cust_id uuid;
  v_due numeric;
  v_pay_amount numeric;
  v_result jsonb;
  v_settlements jsonb := '[]'::jsonb;
begin
  perform public.require_staff_access();

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
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

  return jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'settlements', v_settlements
  );
end;
$$;
comment on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean) is
  'Record one payment split across credit customer rows. Optional same-day settlement flag.';

-- Re-apply LIFO settlements after a payment is removed (admin delete)
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql security definer
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
      select id, amount, date
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
          and transaction_date <= v_pay.date
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
  'Reset amount_settled; re-apply each payment LIFO to entries on/before that payment date.';


comment on function public.reallocate_credit_settlements(uuid) is
  'Reset amount_settled, then re-apply payments with LIFO (newest credit first).';

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
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_changed boolean := false;
begin
  select night_cash, phone_pay, total_sale, collection, short_previous, credit_today,
         expenses_today, short_today
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (coalesce(v_row.night_cash, 0) + coalesce(v_row.phone_pay, 0) + v_credit_today + v_expenses_today);

  v_changed :=
    v_row.total_sale is distinct from v_total_sale
    or v_row.collection is distinct from v_collection
    or v_row.short_previous is distinct from v_short_previous
    or v_row.credit_today is distinct from v_credit_today
    or v_row.expenses_today is distinct from v_expenses_today
    or v_row.short_today is distinct from v_short_today;

  if not v_changed then
    return;
  end if;

  update public.day_closing set
    total_sale = v_total_sale,
    collection = v_collection,
    short_previous = v_short_previous,
    credit_today = v_credit_today,
    expenses_today = v_expenses_today,
    short_today = v_short_today,
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.sync_saved_day_closing_for_date(date) is
  'Refresh saved day_closing snapshot from live DSR/credit/expense data; clear certification only when values change; recascade short chain.';

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
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
    group by 1
  )
  select coalesce(sum(
    greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)
  ), 0)
  from bal b
  full outer join pay p using (name_key);
$$;
comment on function public.get_open_credit_as_of(date) is
  'Total outstanding credit as of date D; one balance per customer name (clamped >= 0), matching credit ledger / Total outstanding.';

create or replace function public.get_outstanding_credit_list_as_of(p_date date)
returns table (
  customer_name text,
  vehicle_no text,
  amount_due_as_of numeric,
  last_payment_date date,
  sale_date date
)
language sql
security definer
stable
set search_path = public
as $$
  with _auth as (select public.require_staff_access()),
  cust as (
    select distinct on (lower(trim(c.customer_name)))
           lower(trim(c.customer_name)) as name_key,
           c.customer_name::text as customer_name,
           c.vehicle_no::text as vehicle_no
    from public.credit_customers c
    order by lower(trim(c.customer_name)),
             c.amount_due desc nulls last,
             c.created_at desc
  ),
  bal as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(e.amount), 0) as credit_tot,
           max(e.transaction_date) as last_txn_date
    from public.credit_entries e
    inner join public.credit_customers c on c.id = e.credit_customer_id
    where e.transaction_date <= p_date
    group by 1
  ),
  pay as (
    select lower(trim(c.customer_name)) as name_key,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    inner join public.credit_customers c on c.id = p.credit_customer_id
    where p.date <= p_date
    group by 1
  )
  select cust.customer_name,
         cust.vehicle_no,
         greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric,
         p.last_pay_date,
         b.last_txn_date
  from bal b
  full outer join pay p using (name_key)
  inner join cust on cust.name_key = coalesce(b.name_key, p.name_key)
  where greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0) > 0
  order by 3 desc, 1;
$$;
comment on function public.get_outstanding_credit_list_as_of(date) is
  'Customers with outstanding balance as of date D; one row per customer name with net (credit - payments) clamped >= 0.';
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
          'note', p.note,
          'same_day_settlement', coalesce(p.same_day_settlement, false)
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
grant execute on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;
grant execute on function public.get_day_closing_breakdown(date) to authenticated;
grant execute on function public.get_night_cash_available() to authenticated;
grant execute on function public.preview_night_cash_collection(date, date) to authenticated;
grant execute on function public.collect_night_cash(date, date, text) to authenticated;
grant execute on function public.save_day_closing(date, numeric, numeric, text) to authenticated;
grant execute on function public.set_day_closing_certified(date, boolean) to authenticated;
grant execute on function public.save_e20_testing_register(date, text, text, jsonb, jsonb, boolean, timestamptz, text, text) to authenticated;
grant execute on function public.e20_parse_yes_no(text) to authenticated;
grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text, uuid, text) to authenticated;
grant execute on function public.record_credit_payment(uuid, date, numeric, text, text, boolean) to authenticated;
grant execute on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean) to authenticated;
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
-- Shift-wise meter readings with staff attribution and cash short.
-- Additive / backward compatible: daily dsr_petrol / dsr_diesel are unchanged.
-- Optional enrichment so operators can see who sold how much from which nozzle.

-- ─── Nozzle assignments (who ran which meter this shift) ─────────────────────

create table if not exists public.meter_shift_readings (
  id uuid primary key default uuid_generate_v4(),
  reading_date date not null,
  product text not null
    check (product in ('petrol', 'diesel')),
  shift text not null
    check (shift in ('morning', 'afternoon')),
  employee_id uuid not null references public.employees (id) on delete restrict,
  pump_no smallint not null
    check (pump_no between 1 and 8),
  nozzle_no smallint not null
    check (nozzle_no between 1 and 8),
  opening_meter numeric(14, 2) not null default 0
    check (opening_meter >= 0),
  closing_meter numeric(14, 2) not null default 0
    check (closing_meter >= 0),
  testing_litres numeric(14, 2) not null default 0
    check (testing_litres >= 0),
  remarks text
    check (remarks is null or char_length(remarks) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint meter_shift_readings_unique_nozzle
    unique (reading_date, product, shift, pump_no, nozzle_no),
  constraint meter_shift_readings_closing_gte_opening
    check (closing_meter >= opening_meter)
);

create index if not exists meter_shift_readings_date_shift_idx
  on public.meter_shift_readings (reading_date desc, shift);

create index if not exists meter_shift_readings_employee_date_idx
  on public.meter_shift_readings (employee_id, reading_date desc);

comment on table public.meter_shift_readings is
  'Per-nozzle shift meters + staff. Writes only via save/delete_meter_shift_readings RPCs.';

comment on column public.meter_shift_readings.shift is
  'Shift key: morning | afternoon (labels from pump_settings.config.shifts).';

comment on column public.meter_shift_readings.testing_litres is
  'Testing litres attributed to this nozzle for the shift (subtracted from gross sale for expected cash).';

-- ─── Staff cash handover per shift (short = expected − collected) ───────────

create table if not exists public.meter_shift_cash (
  id uuid primary key default uuid_generate_v4(),
  reading_date date not null,
  shift text not null
    check (shift in ('morning', 'afternoon')),
  employee_id uuid not null references public.employees (id) on delete restrict,
  cash_collected numeric(14, 2) not null default 0
    check (cash_collected >= 0),
  phone_pay numeric(14, 2) not null default 0
    check (phone_pay >= 0),
  credit_amount numeric(14, 2) not null default 0
    check (credit_amount >= 0),
  expense_amount numeric(14, 2) not null default 0
    check (expense_amount >= 0),
  remarks text
    check (remarks is null or char_length(remarks) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint meter_shift_cash_unique_staff
    unique (reading_date, shift, employee_id)
);

create index if not exists meter_shift_cash_date_shift_idx
  on public.meter_shift_cash (reading_date desc, shift);

comment on table public.meter_shift_cash is
  'Staff handover per shift: cash + phone + cached credit/expense from ledger. Writes via save/delete_meter_shift_readings RPCs. Total = sum of four.';

comment on column public.meter_shift_cash.cash_collected is
  'Hard cash handed over by staff for the shift (₹).';

comment on column public.meter_shift_cash.phone_pay is
  'PhonePe / UPI collected by staff for the shift (₹).';

comment on column public.meter_shift_cash.credit_amount is
  'Cached sum of shift-attributed credit_entries (₹). Synced by trigger; not written from client.';

comment on column public.meter_shift_cash.expense_amount is
  'Cached sum of shift-attributed expenses (₹). Synced by trigger; not written from client.';
-- ─── RLS (select only — writes go through SECURITY DEFINER RPCs) ─────────────

alter table public.meter_shift_readings enable row level security;
alter table public.meter_shift_cash enable row level security;

drop policy if exists "meter_shift_readings_select" on public.meter_shift_readings;
create policy "meter_shift_readings_select" on public.meter_shift_readings
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_readings_insert" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_update" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_admin" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_staff" on public.meter_shift_readings;

drop policy if exists "meter_shift_cash_select" on public.meter_shift_cash;
create policy "meter_shift_cash_select" on public.meter_shift_cash
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_cash_insert" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_update" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_admin" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_staff" on public.meter_shift_cash;

revoke insert, update, delete on public.meter_shift_readings from authenticated;
revoke insert, update, delete on public.meter_shift_cash from authenticated;
grant select on public.meter_shift_readings to authenticated;
grant select on public.meter_shift_cash to authenticated;

-- ─── Audit ──────────────────────────────────────────────────────────────────

drop trigger if exists audit_meter_shift_readings_trigger on public.meter_shift_readings;
create trigger audit_meter_shift_readings_trigger
  after insert or update or delete on public.meter_shift_readings
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_meter_shift_cash_trigger on public.meter_shift_cash;
create trigger audit_meter_shift_cash_trigger
  after insert or update or delete on public.meter_shift_cash
  for each row execute function public.audit_trigger_fn();

-- get_meter_shift_readings is defined once later (with suggested openings).

-- ─── Sync cached credit/expense on meter_shift_cash from attributed ledger ───

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
    updated_at = timezone('utc'::text, now());
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows.';

create or replace function public.trg_sync_shift_cash_from_credit_entries()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.transaction_date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.transaction_date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.transaction_date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.transaction_date is distinct from new.transaction_date
       or old.amount is distinct from new.amount
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.transaction_date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists credit_entries_shift_cash_sync on public.credit_entries;
create trigger credit_entries_shift_cash_sync
  after insert or update or delete on public.credit_entries
  for each row execute function public.trg_sync_shift_cash_from_credit_entries();

create or replace function public.trg_sync_shift_cash_from_expenses()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.employee_id is not null and old.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        old.date, old.shift, old.employee_id
      );
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is not null and new.shift is not null then
      perform public.sync_meter_shift_cash_ledger_totals(
        new.date, new.shift, new.employee_id
      );
    end if;
    return new;
  end if;

  if (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
     and old.employee_id is not null
     and old.shift is not null
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      old.date, old.shift, old.employee_id
    );
  end if;

  if new.employee_id is not null and new.shift is not null
     and (
       old.employee_id is distinct from new.employee_id
       or old.shift is distinct from new.shift
       or old.date is distinct from new.date
       or old.amount is distinct from new.amount
     )
  then
    perform public.sync_meter_shift_cash_ledger_totals(
      new.date, new.shift, new.employee_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists expenses_shift_cash_sync on public.expenses;
create trigger expenses_shift_cash_sync
  after insert or update or delete on public.expenses
  for each row execute function public.trg_sync_shift_cash_from_expenses();

create or replace function public.add_shift_expense(
  p_date date,
  p_shift text,
  p_employee_id uuid,
  p_category text,
  p_amount numeric,
  p_description text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_shift text;
  v_id uuid;
  v_category text;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;
  if p_date > current_date then
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

  return jsonb_build_object(
    'id', v_id,
    'date', p_date,
    'shift', v_shift,
    'employee_id', p_employee_id,
    'amount', p_amount,
    'category', v_category
  );
end;
$$;

create or replace function public.delete_shift_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.credit_entries%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.credit_entries where id = p_entry_id;
  if not found then
    raise exception 'Credit entry not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register credit entries can be removed here';
  end if;

  perform public.require_meter_shift_writable(v_row.transaction_date, v_row.shift);

  if coalesce(v_row.amount_settled, 0) > 0 then
    raise exception 'Cannot delete a credit sale that already has payments';
  end if;
  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this credit sale';
  end if;

  delete from public.credit_entries where id = p_entry_id;
  perform public.sync_credit_customer_balances(v_row.credit_customer_id);

  return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

create or replace function public.delete_shift_expense(p_expense_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.expenses%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.expenses where id = p_expense_id;
  if not found then
    raise exception 'Expense not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register expenses can be removed here';
  end if;

  perform public.require_meter_shift_writable(v_row.date, v_row.shift);

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this expense';
  end if;

  delete from public.expenses where id = p_expense_id;

  return jsonb_build_object('deleted', true, 'id', p_expense_id);
end;
$$;

comment on function public.delete_shift_expense(uuid) is
  'Remove a shift-attributed expense; respects shift write lock; cache sync via trigger.';

create or replace function public.get_shift_staff_ledger(p_date date, p_shift text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_staff_access();
  if p_date is null then
    raise exception 'Date is required';
  end if;
  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'credit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'employee_id', e.employee_id,
          'customer_name', c.customer_name,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount', e.amount,
          'amount_settled', e.amount_settled,
          'created_by', e.created_by
        )
        order by c.customer_name, e.created_at
      )
      from public.credit_entries e
      join public.credit_customers c on c.id = e.credit_customer_id
      where e.transaction_date = p_date
        and e.shift = v_shift
        and e.employee_id is not null
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'employee_id', x.employee_id,
          'category', x.category,
          'description', x.description,
          'amount', x.amount,
          'created_by', x.created_by
        )
        order by x.created_at
      )
      from public.expenses x
      where x.date = p_date
        and x.shift = v_shift
        and x.employee_id is not null
    ), '[]'::jsonb)
  );
end;
$$;

-- ─── save_meter_shift_readings ──────────────────────────────────────────────

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
      updated_at = timezone('utc'::text, now());

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
      updated_at = timezone('utc'::text, now());

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
  'Upsert shift nozzle + cash/phone; credit/expense cached from ledger. Push meters into dsr_*.';


-- ─── delete_meter_shift_readings ────────────────────────────────────────────

create or replace function public.delete_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_n int;
  v_c int;
  v_credit int := 0;
  v_expense int := 0;
  v_settled int := 0;
  v_customer_id uuid;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();
  if not public.is_admin() then
    raise exception 'Only admin can delete shift readings';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select count(*)::int into v_settled
  from public.credit_entries e
  where e.transaction_date = p_date
    and e.shift = v_shift
    and e.employee_id is not null
    and coalesce(e.amount_settled, 0) > 0;
  if v_settled > 0 then
    raise exception
      'Cannot clear shift: % credit sale(s) already have payments. Remove settlements first.',
      v_settled;
  end if;

  for v_customer_id in
    select distinct e.credit_customer_id
    from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
  loop
    delete from public.credit_entries e
    where e.transaction_date = p_date
      and e.shift = v_shift
      and e.employee_id is not null
      and e.credit_customer_id = v_customer_id;
    get diagnostics v_n = row_count;
    v_credit := v_credit + v_n;
    perform public.sync_credit_customer_balances(v_customer_id);
  end loop;

  delete from public.expenses x
  where x.date = p_date
    and x.shift = v_shift
    and x.employee_id is not null;
  get diagnostics v_expense = row_count;

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'deleted_credit', v_credit,
    'deleted_expenses', v_expense,
    'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzles/cash and attributed credit/expenses; refresh dsr_* meters.';

grant execute on function public.delete_meter_shift_readings(date, text) to authenticated;

create or replace function public.get_meter_shift_prior_closings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_prior_date date;
  v_prior_shift text;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  if v_shift = 'afternoon' then
    v_prior_date := p_date;
    v_prior_shift := 'morning';
  else
    v_prior_date := p_date - 1;
    v_prior_shift := 'afternoon';
  end if;

  return jsonb_build_object(
    'prior_date', v_prior_date,
    'prior_shift', v_prior_shift,
    'from_shift', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product', r.product,
          'pump_no', r.pump_no,
          'nozzle_no', r.nozzle_no,
          'closing_meter', r.closing_meter
        )
        order by r.product, r.pump_no, r.nozzle_no
      )
      from public.meter_shift_readings r
      where r.reading_date = v_prior_date
        and r.shift = v_prior_shift
    ), '[]'::jsonb),
    'from_daily', jsonb_build_object(
      'petrol', (
        select jsonb_build_object(
          'closing_pump1_nozzle1', p.closing_pump1_nozzle1,
          'closing_pump1_nozzle2', p.closing_pump1_nozzle2,
          'closing_pump2_nozzle1', p.closing_pump2_nozzle1,
          'closing_pump2_nozzle2', p.closing_pump2_nozzle2
        )
        from public.dsr_petrol p
        where p.date < p_date
          and public.dsr_meter_row_is_complete(
            p.petrol_rate, p.dip_reading, p.stock, p.receipts
          )
        order by p.date desc
        limit 1
      ),
      'diesel', (
        select jsonb_build_object(
          'closing_pump1_nozzle1', d.closing_pump1_nozzle1,
          'closing_pump1_nozzle2', d.closing_pump1_nozzle2,
          'closing_pump2_nozzle1', d.closing_pump2_nozzle1,
          'closing_pump2_nozzle2', d.closing_pump2_nozzle2
        )
        from public.dsr_diesel d
        where d.date < p_date
          and public.dsr_meter_row_is_complete(
            d.diesel_rate, d.dip_reading, d.stock, d.receipts
          )
        order by d.date desc
        limit 1
      )
    )
  );
end;
$$;

comment on function public.get_meter_shift_prior_closings(date, text) is
  'Prior shift closings + last complete daily closings for opening prefill.';

grant execute on function public.get_meter_shift_prior_closings(date, text) to authenticated;

create or replace function public.meter_day_is_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.day_closing dc
    where dc.date = p_date
      and (
        coalesce(dc.certified, false)
        or dc.night_cash_collection_id is not null
      )
  );
$$;

comment on function public.meter_day_is_locked(date) is
  'True when day closing is certified or night cash collected — meter sync requires admin.';

grant execute on function public.meter_day_is_locked(date) to authenticated;

create or replace function public.meter_day_has_closing(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.day_closing dc where dc.date = p_date
  );
$$;

comment on function public.meter_day_has_closing(date) is
  'True when a day closing statement exists for the date (blocks supervisor shift edits).';

grant execute on function public.meter_day_has_closing(date) to authenticated;

create or replace function public.meter_station_today()
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (timezone('Asia/Kolkata', now()))::date;
$$;

comment on function public.meter_station_today() is
  'Station calendar date (IST) for meter lock rules.';

grant execute on function public.meter_station_today() to authenticated;

create or replace function public.meter_day_has_daily_entry(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dsr_petrol p
    where p.date = p_date
      and public.dsr_meter_row_is_complete(
        p.petrol_rate, p.dip_reading, p.stock, p.receipts
      )
  )
  or exists (
    select 1
    from public.dsr_diesel d
    where d.date = p_date
      and public.dsr_meter_row_is_complete(
        d.diesel_rate, d.dip_reading, d.stock, d.receipts
      )
  );
$$;

comment on function public.meter_day_has_daily_entry(date) is
  'True when a completed daily MS or HSD sheet exists (excludes incomplete meter rows).';

grant execute on function public.meter_day_has_daily_entry(date) to authenticated;

drop function if exists public.meter_shift_lock_info(date);

-- Per-shift lock: supervisors may re-save until day closing is saved;
-- certified / night-cash collected also locks. Sync / daily push only checks
-- day-closing lock (certified / night cash).

create or replace function public.meter_shift_has_readings(p_date date, p_shift text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.meter_shift_readings r
    where r.reading_date = p_date
      and r.shift = lower(btrim(coalesce(p_shift, '')))
  );
$$;

comment on function public.meter_shift_has_readings(date, text) is
  'True when the given date+shift already has nozzle rows.';

grant execute on function public.meter_shift_has_readings(date, text) to authenticated;

create or replace function public.meter_shift_lock_info(
  p_date date,
  p_shift text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day_locked boolean := false;
  v_closing_saved boolean := false;
  v_shift_saved boolean := false;
  v_shift text;
  v_today date := public.meter_station_today();
  v_reason text := null;
  v_readonly boolean := false;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  v_day_locked := public.meter_day_is_locked(p_date);
  v_closing_saved := public.meter_day_has_closing(p_date);

  if v_shift is not null then
    v_shift_saved := public.meter_shift_has_readings(p_date, v_shift);
  end if;

  if v_day_locked and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is certified or night cash is collected. Only an admin can change meters.';
  elsif v_closing_saved and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is saved for this date. Only an admin can change shifts.';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'today', v_today,
    'day_locked', v_day_locked,
    'day_closing_saved', v_closing_saved,
    'past_closed', p_date < v_today and public.meter_day_has_daily_entry(p_date),
    'shift_has_data', v_shift_saved,
    'has_daily_entry', public.meter_day_has_daily_entry(p_date),
    'supervisor_readonly', v_readonly,
    'admin_can_edit', public.is_admin(),
    'lock_reason', v_reason
  );
end;
$$;

comment on function public.meter_shift_lock_info(date, text) is
  'Shift register lock for supervisors: day closing saved, or day certified / night cash collected.';

grant execute on function public.meter_shift_lock_info(date, text) to authenticated;

-- Sync / daily push: only block certified / night-cash days (not past+daily).
create or replace function public.require_meter_day_writable(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return;
  end if;

  if public.meter_day_is_locked(p_date) then
    raise exception
      'Day % is locked (certified or night cash collected). Only an admin can change meters.',
      p_date;
  end if;
end;
$$;

comment on function public.require_meter_day_writable(date) is
  'Non-admins blocked when day closing is certified or night cash is collected.';

-- Shift save: supervisors may re-save until day closing exists; admins always can.
create or replace function public.require_meter_shift_writable(p_date date, p_shift text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_meter_day_writable(p_date);

  if public.is_admin() then
    return;
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  if public.meter_day_has_closing(p_date) then
    raise exception
      'Day closing is saved for %. Only an admin can change shift %.',
      p_date, v_shift;
  end if;
end;
$$;

comment on function public.require_meter_shift_writable(date, text) is
  'Supervisors can re-save a shift until day closing is saved; admins always can.';

grant execute on function public.require_meter_shift_writable(date, text) to authenticated;


-- ─── get_shift_aggregated_daily_meters ──────────────────────────────────────

create or replace function public.get_shift_aggregated_daily_meters(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product text;
  v_result jsonb := jsonb_build_object('date', p_date);
  v_o11 numeric; v_o12 numeric; v_o21 numeric; v_o22 numeric;
  v_c11 numeric; v_c12 numeric; v_c21 numeric; v_c22 numeric;
  v_test numeric;
  v_s1 numeric; v_s2 numeric;
  v_has_any boolean;
  v_has_morning boolean;
  v_has_afternoon boolean;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  foreach v_product in array array['petrol', 'diesel']
  loop
    select
      q.has_any,
      q.has_morning,
      q.has_afternoon,
      coalesce(q.o11_m, q.o11_a),
      coalesce(q.o12_m, q.o12_a),
      coalesce(q.o21_m, q.o21_a),
      coalesce(q.o22_m, q.o22_a),
      coalesce(q.c11_a, q.c11_m),
      coalesce(q.c12_a, q.c12_m),
      coalesce(q.c21_a, q.c21_m),
      coalesce(q.c22_a, q.c22_m),
      q.testing,
      q.s1,
      q.s2
    into
      v_has_any,
      v_has_morning,
      v_has_afternoon,
      v_o11, v_o12, v_o21, v_o22,
      v_c11, v_c12, v_c21, v_c22,
      v_test,
      v_s1, v_s2
    from (
      select
        count(*) > 0 as has_any,
        bool_or(r.shift = 'morning') as has_morning,
        bool_or(r.shift = 'afternoon') as has_afternoon,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as o11_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as o11_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as o12_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as o12_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as o21_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as o21_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as o22_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as o22_a,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as c11_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as c11_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as c12_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as c12_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as c21_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as c21_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as c22_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as c22_m,
        coalesce(sum(r.testing_litres), 0) as testing,
        coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 1), 0) as s1,
        coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 2), 0) as s2
      from public.meter_shift_readings r
      where r.reading_date = p_date
        and r.product = v_product
        and r.pump_no in (1, 2)
        and r.nozzle_no in (1, 2)
    ) q;

    if not coalesce(v_has_any, false) then
      v_result := v_result || jsonb_build_object(
        v_product,
        jsonb_build_object(
          'has_shifts', false,
          'has_morning', false,
          'has_afternoon', false
        )
      );
      continue;
    end if;

    v_c11 := coalesce(v_c11, v_o11);
    v_c12 := coalesce(v_c12, v_o12);
    v_c21 := coalesce(v_c21, v_o21);
    v_c22 := coalesce(v_c22, v_o22);
    v_s1 := coalesce(v_s1, 0);
    v_s2 := coalesce(v_s2, 0);
    v_test := coalesce(v_test, 0);

    v_result := v_result || jsonb_build_object(
      v_product,
      jsonb_build_object(
        'has_shifts', true,
        'has_morning', coalesce(v_has_morning, false),
        'has_afternoon', coalesce(v_has_afternoon, false),
        'opening_pump1_nozzle1', v_o11,
        'opening_pump1_nozzle2', v_o12,
        'opening_pump2_nozzle1', v_o21,
        'opening_pump2_nozzle2', v_o22,
        'closing_pump1_nozzle1', v_c11,
        'closing_pump1_nozzle2', v_c12,
        'closing_pump2_nozzle1', v_c21,
        'closing_pump2_nozzle2', v_c22,
        'sales_pump1', v_s1,
        'sales_pump2', v_s2,
        'total_sales', v_s1 + v_s2,
        'testing', v_test
      )
    );
  end loop;

  return v_result;
end;
$$;

comment on function public.get_shift_aggregated_daily_meters(date) is
  'Clean model: read-only shift rollup for meter form prefill. Never writes dsr_*.';

grant execute on function public.get_shift_aggregated_daily_meters(date) to authenticated;

-- sync_dsr_meters_from_shifts removed (no stub inserts).
-- Existing dsr_* meter columns refresh via apply_shift_aggregate_to_dsr on shift save/delete.

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

  v_block := v_agg->'petrol';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select p.id into v_id
    from public.dsr_petrol p
    where p.date = p_date
    order by p.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_petrol p set
        opening_pump1_nozzle1 = coalesce((v_block->>'opening_pump1_nozzle1')::numeric, p.opening_pump1_nozzle1),
        opening_pump1_nozzle2 = coalesce((v_block->>'opening_pump1_nozzle2')::numeric, p.opening_pump1_nozzle2),
        opening_pump2_nozzle1 = coalesce((v_block->>'opening_pump2_nozzle1')::numeric, p.opening_pump2_nozzle1),
        opening_pump2_nozzle2 = coalesce((v_block->>'opening_pump2_nozzle2')::numeric, p.opening_pump2_nozzle2),
        closing_pump1_nozzle1 = coalesce((v_block->>'closing_pump1_nozzle1')::numeric, p.closing_pump1_nozzle1),
        closing_pump1_nozzle2 = coalesce((v_block->>'closing_pump1_nozzle2')::numeric, p.closing_pump1_nozzle2),
        closing_pump2_nozzle1 = coalesce((v_block->>'closing_pump2_nozzle1')::numeric, p.closing_pump2_nozzle1),
        closing_pump2_nozzle2 = coalesce((v_block->>'closing_pump2_nozzle2')::numeric, p.closing_pump2_nozzle2),
        sales_pump1 = coalesce((v_block->>'sales_pump1')::numeric, 0),
        sales_pump2 = coalesce((v_block->>'sales_pump2')::numeric, 0),
        total_sales = coalesce((v_block->>'total_sales')::numeric, 0),
        testing = coalesce((v_block->>'testing')::numeric, 0)
      where p.id = v_id;
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
        opening_pump1_nozzle1 = coalesce((v_block->>'opening_pump1_nozzle1')::numeric, d.opening_pump1_nozzle1),
        opening_pump1_nozzle2 = coalesce((v_block->>'opening_pump1_nozzle2')::numeric, d.opening_pump1_nozzle2),
        opening_pump2_nozzle1 = coalesce((v_block->>'opening_pump2_nozzle1')::numeric, d.opening_pump2_nozzle1),
        opening_pump2_nozzle2 = coalesce((v_block->>'opening_pump2_nozzle2')::numeric, d.opening_pump2_nozzle2),
        closing_pump1_nozzle1 = coalesce((v_block->>'closing_pump1_nozzle1')::numeric, d.closing_pump1_nozzle1),
        closing_pump1_nozzle2 = coalesce((v_block->>'closing_pump1_nozzle2')::numeric, d.closing_pump1_nozzle2),
        closing_pump2_nozzle1 = coalesce((v_block->>'closing_pump2_nozzle1')::numeric, d.closing_pump2_nozzle1),
        closing_pump2_nozzle2 = coalesce((v_block->>'closing_pump2_nozzle2')::numeric, d.closing_pump2_nozzle2),
        sales_pump1 = coalesce((v_block->>'sales_pump1')::numeric, 0),
        sales_pump2 = coalesce((v_block->>'sales_pump2')::numeric, 0),
        total_sales = coalesce((v_block->>'total_sales')::numeric, 0),
        testing = coalesce((v_block->>'testing')::numeric, 0)
      where d.id = v_id;
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
  'Update meter columns on existing dsr_* rows from shift rollup. Never inserts stubs; leaves dip/stock/rate/remarks alone.';

grant execute on function public.apply_shift_aggregate_to_dsr(date) to authenticated;


-- ─── sync_shift_meters_from_dsr ─────────────────────────────────────────────
-- Push openings to morning and closings to afternoon only from finished sheets.

create or replace function public.sync_shift_meters_from_dsr(
  p_date date,
  p_shift text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_has_afternoon boolean;
  v_updated int := 0;
  v_n int;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select exists(
    select 1 from public.meter_shift_readings
    where reading_date = p_date and shift = 'afternoon'
  )
  into v_has_afternoon;

  -- Morning: align openings from complete daily only
  with daily as (
    (
      select 'petrol'::text as product,
        p.opening_pump1_nozzle1 as o11, p.opening_pump1_nozzle2 as o12,
        p.opening_pump2_nozzle1 as o21, p.opening_pump2_nozzle2 as o22
      from public.dsr_petrol p
      where p.date = p_date
        and public.dsr_meter_row_is_complete(
          p.petrol_rate, p.dip_reading, p.stock, p.receipts
        )
      order by p.created_at desc
      limit 1
    )
    union all
    (
      select 'diesel'::text,
        d.opening_pump1_nozzle1, d.opening_pump1_nozzle2,
        d.opening_pump2_nozzle1, d.opening_pump2_nozzle2
      from public.dsr_diesel d
      where d.date = p_date
        and public.dsr_meter_row_is_complete(
          d.diesel_rate, d.dip_reading, d.stock, d.receipts
        )
      order by d.created_at desc
      limit 1
    )
  ),
  nozzles as (
    select product, 1::smallint as pump_no, 1::smallint as nozzle_no, o11 as opening from daily
    union all select product, 1, 2, o12 from daily
    union all select product, 2, 1, o21 from daily
    union all select product, 2, 2, o22 from daily
  )
  update public.meter_shift_readings r set
    opening_meter = coalesce(n.opening, r.opening_meter),
    closing_meter = greatest(r.closing_meter, coalesce(n.opening, r.opening_meter)),
    updated_at = timezone('utc'::text, now())
  from nozzles n
  where r.reading_date = p_date
    and r.shift = 'morning'
    and r.product = n.product
    and r.pump_no = n.pump_no
    and r.nozzle_no = n.nozzle_no
    and (v_shift is null or v_shift = 'morning');

  get diagnostics v_n = row_count;
  v_updated := v_updated + coalesce(v_n, 0);

  if v_has_afternoon and (v_shift is null or v_shift = 'afternoon') then
    with daily as (
      (
        select 'petrol'::text as product,
          p.closing_pump1_nozzle1 as c11, p.closing_pump1_nozzle2 as c12,
          p.closing_pump2_nozzle1 as c21, p.closing_pump2_nozzle2 as c22
        from public.dsr_petrol p
        where p.date = p_date
          and public.dsr_meter_row_is_complete(
            p.petrol_rate, p.dip_reading, p.stock, p.receipts
          )
        order by p.created_at desc
        limit 1
      )
      union all
      (
        select 'diesel'::text,
          d.closing_pump1_nozzle1, d.closing_pump1_nozzle2,
          d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
        from public.dsr_diesel d
        where d.date = p_date
          and public.dsr_meter_row_is_complete(
            d.diesel_rate, d.dip_reading, d.stock, d.receipts
          )
        order by d.created_at desc
        limit 1
      )
    ),
    nozzles as (
      select product, 1::smallint as pump_no, 1::smallint as nozzle_no, c11 as closing from daily
      union all select product, 1, 2, c12 from daily
      union all select product, 2, 1, c21 from daily
      union all select product, 2, 2, c22 from daily
    )
    update public.meter_shift_readings r set
      closing_meter = greatest(coalesce(n.closing, r.closing_meter), r.opening_meter),
      updated_at = timezone('utc'::text, now())
    from nozzles n
    where r.reading_date = p_date
      and r.shift = 'afternoon'
      and r.product = n.product
      and r.pump_no = n.pump_no
      and r.nozzle_no = n.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  -- Afternoon opening = morning closing (handoff continuity)
  if v_shift is null or v_shift = 'afternoon' then
    update public.meter_shift_readings aft set
      opening_meter = m.closing_meter,
      closing_meter = greatest(aft.closing_meter, m.closing_meter),
      updated_at = timezone('utc'::text, now())
    from public.meter_shift_readings m
    where aft.reading_date = p_date
      and aft.shift = 'afternoon'
      and m.reading_date = p_date
      and m.shift = 'morning'
      and m.product = aft.product
      and m.pump_no = aft.pump_no
      and m.nozzle_no = aft.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'ok', true,
    'rows_touched', v_updated
  );
end;
$$;

comment on function public.sync_shift_meters_from_dsr(date, text) is
  'Push openings/closings from a finished meter sheet into shift rows; handoff afternoon open from morning close.';

-- ─── get_meter_shift_readings (with suggested openings) ─────────────────────

create or replace function public.get_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_petrol record;
  v_diesel record;
  v_petrol_complete boolean := false;
  v_diesel_complete boolean := false;
  v_prior jsonb;
  v_daily_meters jsonb;
  v_suggested jsonb := '{}'::jsonb;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select p.*
  into v_petrol
  from public.dsr_petrol p
  where p.date = p_date
  order by p.created_at desc
  limit 1;

  select d.*
  into v_diesel
  from public.dsr_diesel d
  where d.date = p_date
  order by d.created_at desc
  limit 1;

  if v_petrol.id is not null then
    v_petrol_complete := public.dsr_meter_row_is_complete(
      v_petrol.petrol_rate, v_petrol.dip_reading, v_petrol.stock, v_petrol.receipts
    );
  end if;
  if v_diesel.id is not null then
    v_diesel_complete := public.dsr_meter_row_is_complete(
      v_diesel.diesel_rate, v_diesel.dip_reading, v_diesel.stock, v_diesel.receipts
    );
  end if;

  v_prior := public.get_meter_shift_prior_closings(p_date, v_shift);

  v_daily_meters := jsonb_build_object(
    'petrol', case when v_petrol.id is not null then jsonb_build_object(
      'opening_pump1_nozzle1', v_petrol.opening_pump1_nozzle1,
      'opening_pump1_nozzle2', v_petrol.opening_pump1_nozzle2,
      'opening_pump2_nozzle1', v_petrol.opening_pump2_nozzle1,
      'opening_pump2_nozzle2', v_petrol.opening_pump2_nozzle2,
      'closing_pump1_nozzle1', v_petrol.closing_pump1_nozzle1,
      'closing_pump1_nozzle2', v_petrol.closing_pump1_nozzle2,
      'closing_pump2_nozzle1', v_petrol.closing_pump2_nozzle1,
      'closing_pump2_nozzle2', v_petrol.closing_pump2_nozzle2,
      'sales_pump1', v_petrol.sales_pump1,
      'sales_pump2', v_petrol.sales_pump2,
      'total_sales', v_petrol.total_sales,
      'is_complete', v_petrol_complete
    ) else null end,
    'diesel', case when v_diesel.id is not null then jsonb_build_object(
      'opening_pump1_nozzle1', v_diesel.opening_pump1_nozzle1,
      'opening_pump1_nozzle2', v_diesel.opening_pump1_nozzle2,
      'opening_pump2_nozzle1', v_diesel.opening_pump2_nozzle1,
      'opening_pump2_nozzle2', v_diesel.opening_pump2_nozzle2,
      'closing_pump1_nozzle1', v_diesel.closing_pump1_nozzle1,
      'closing_pump1_nozzle2', v_diesel.closing_pump1_nozzle2,
      'closing_pump2_nozzle1', v_diesel.closing_pump2_nozzle1,
      'closing_pump2_nozzle2', v_diesel.closing_pump2_nozzle2,
      'sales_pump1', v_diesel.sales_pump1,
      'sales_pump2', v_diesel.sales_pump2,
      'total_sales', v_diesel.total_sales,
      'is_complete', v_diesel_complete
    ) else null end
  );

  select coalesce(
    jsonb_object_agg(
      (elem->>'product') || ':' || (elem->>'pump_no') || ':' || (elem->>'nozzle_no'),
      elem->'closing_meter'
    ),
    '{}'::jsonb
  )
  into v_suggested
  from jsonb_array_elements(coalesce(v_prior->'from_shift', '[]'::jsonb)) as elem;

  if v_shift = 'morning' then
    -- Same-day daily openings only from a finished sheet (avoid partial-row poison)
    if v_petrol_complete then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_daily_meters->'petrol'->'opening_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_daily_meters->'petrol'->'opening_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_daily_meters->'petrol'->'opening_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_daily_meters->'petrol'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_diesel_complete then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'diesel:1:1', coalesce(v_suggested->'diesel:1:1', v_daily_meters->'diesel'->'opening_pump1_nozzle1'),
        'diesel:1:2', coalesce(v_suggested->'diesel:1:2', v_daily_meters->'diesel'->'opening_pump1_nozzle2'),
        'diesel:2:1', coalesce(v_suggested->'diesel:2:1', v_daily_meters->'diesel'->'opening_pump2_nozzle1'),
        'diesel:2:2', coalesce(v_suggested->'diesel:2:2', v_daily_meters->'diesel'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_prior->'from_daily'->'petrol' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_prior->'from_daily'->'petrol'->'closing_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_prior->'from_daily'->'petrol'->'closing_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_prior->'from_daily'->'petrol'->'closing_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_prior->'from_daily'->'petrol'->'closing_pump2_nozzle2')
      ));
    end if;
    if v_prior->'from_daily'->'diesel' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'diesel:1:1', coalesce(v_suggested->'diesel:1:1', v_prior->'from_daily'->'diesel'->'closing_pump1_nozzle1'),
        'diesel:1:2', coalesce(v_suggested->'diesel:1:2', v_prior->'from_daily'->'diesel'->'closing_pump1_nozzle2'),
        'diesel:2:1', coalesce(v_suggested->'diesel:2:1', v_prior->'from_daily'->'diesel'->'closing_pump2_nozzle1'),
        'diesel:2:2', coalesce(v_suggested->'diesel:2:2', v_prior->'from_daily'->'diesel'->'closing_pump2_nozzle2')
      ));
    end if;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'rates', jsonb_build_object(
      'petrol', v_petrol.petrol_rate,
      'diesel', v_diesel.diesel_rate
    ),
    'daily_totals', jsonb_build_object(
      'petrol', jsonb_build_object(
        'total_sales', coalesce(v_petrol.total_sales, 0),
        'testing', coalesce(v_petrol.testing, 0),
        'has_row', v_petrol.id is not null,
        'has_complete_row', v_petrol_complete
      ),
      'diesel', jsonb_build_object(
        'total_sales', coalesce(v_diesel.total_sales, 0),
        'testing', coalesce(v_diesel.testing, 0),
        'has_row', v_diesel.id is not null,
        'has_complete_row', v_diesel_complete
      )
    ),
    'daily_meters', coalesce(v_daily_meters, '{}'::jsonb),
    'suggested_openings', v_suggested,
    'prior', v_prior,
    'nozzles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'product', r.product,
          'pump_no', r.pump_no,
          'nozzle_no', r.nozzle_no,
          'employee_id', r.employee_id,
          'employee_name', e.name,
          'opening_meter', r.opening_meter,
          'closing_meter', r.closing_meter,
          'testing_litres', r.testing_litres,
          'litres_sold', greatest(r.closing_meter - r.opening_meter, 0),
          'net_litres', greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0),
          'remarks', r.remarks
        )
        order by r.product, r.pump_no, r.nozzle_no
      )
      from public.meter_shift_readings r
      left join public.employees e on e.id = r.employee_id
      where r.reading_date = p_date
        and r.shift = v_shift
    ), '[]'::jsonb),
    'cash', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'employee_id', c.employee_id,
          'employee_name', e.name,
          'cash_collected', c.cash_collected,
          'phone_pay', c.phone_pay,
          'credit_amount', c.credit_amount,
          'expense_amount', c.expense_amount,
          'total_collected',
            coalesce(c.cash_collected, 0) + coalesce(c.phone_pay, 0)
            + coalesce(c.credit_amount, 0) + coalesce(c.expense_amount, 0),
          'remarks', c.remarks
        )
        order by e.display_order nulls last, e.name
      )
      from public.meter_shift_cash c
      left join public.employees e on e.id = c.employee_id
      where c.reading_date = p_date
        and c.shift = v_shift
    ), '[]'::jsonb),
    'attendance_hints', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_id', a.employee_id,
          'employee_name', e.name,
          'status', a.status
        )
        order by e.display_order nulls last, e.name
      )
      from public.employee_attendance a
      join public.employees e on e.id = a.employee_id
      where a.date = p_date
        and a.shift = v_shift
        and a.status in ('present', 'half_day')
        and coalesce(e.is_active, true)
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_meter_shift_readings(date, text) is
  'Load shift nozzles, cash/phone/credit/expense, rates, daily meters (has_complete_row), suggested openings, attendance hints.';

grant execute on function public.get_meter_shift_readings(date, text) to authenticated;
grant execute on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) to authenticated;
grant execute on function public.add_shift_expense(date, text, uuid, text, numeric, text) to authenticated;
grant execute on function public.delete_shift_credit_entry(uuid) to authenticated;
grant execute on function public.delete_shift_expense(uuid) to authenticated;
grant execute on function public.get_shift_staff_ledger(date, text) to authenticated;

-- ─── get_meter_sales_breakdown ──────────────────────────────────────────────

create or replace function public.get_meter_sales_breakdown(
  p_start date,
  p_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();

  if p_start is null or p_end is null then
    raise exception 'Start and end dates are required';
  end if;
  if p_end < p_start then
    raise exception 'End date must be on or after start date';
  end if;

  return (
    with readings as (
      select
        r.reading_date,
        r.shift,
        r.product,
        r.pump_no,
        r.employee_id,
        greatest(r.closing_meter - r.opening_meter, 0) as litres,
        greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0) as net_litres
      from public.meter_shift_readings r
      where r.reading_date between p_start and p_end
    )
    select jsonb_build_object(
      'start', p_start,
      'end', p_end,
      'by_pump', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.shift, t.product, t.pump_no)
        from (
          select reading_date, shift, product, pump_no,
            sum(litres) as litres, sum(net_litres) as net_litres
          from readings
          group by reading_date, shift, product, pump_no
        ) t
      ), '[]'::jsonb),
      'by_shift', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.shift, t.product)
        from (
          select reading_date, shift, product,
            sum(litres) as litres, sum(net_litres) as net_litres,
            count(distinct employee_id) as staff_count
          from readings
          group by reading_date, shift, product
        ) t
      ), '[]'::jsonb),
      'by_salesman', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.employee_name, t.shift)
        from (
          select
            r.reading_date,
            r.shift,
            r.employee_id,
            e.name as employee_name,
            sum(case when r.product = 'petrol' then r.litres else 0 end) as petrol_litres,
            sum(case when r.product = 'diesel' then r.litres else 0 end) as diesel_litres,
            sum(case when r.product = 'petrol' then r.net_litres else 0 end) as petrol_net_litres,
            sum(case when r.product = 'diesel' then r.net_litres else 0 end) as diesel_net_litres,
            sum(r.litres) as total_litres,
            sum(r.net_litres) as net_litres,
            coalesce(max(c.cash_collected), 0) as cash_collected,
            coalesce(max(c.phone_pay), 0) as phone_pay,
            coalesce(max(c.credit_amount), 0) as credit_amount,
            coalesce(max(c.expense_amount), 0) as expense_amount,
            coalesce(max(c.cash_collected), 0) + coalesce(max(c.phone_pay), 0)
              + coalesce(max(c.credit_amount), 0) + coalesce(max(c.expense_amount), 0) as total_collected
          from readings r
          left join public.employees e on e.id = r.employee_id
          left join public.meter_shift_cash c
            on c.reading_date = r.reading_date
            and c.shift = r.shift
            and c.employee_id = r.employee_id
          group by r.reading_date, r.shift, r.employee_id, e.name
        ) t
      ), '[]'::jsonb),
      'daily_pump', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.date desc, t.product)
        from (
          (
            select distinct on (p.date)
              p.date, 'petrol'::text as product,
              p.sales_pump1, p.sales_pump2, p.total_sales, p.testing
            from public.dsr_petrol p
            where p.date between p_start and p_end
            order by p.date, p.created_at desc
          )
          union all
          (
            select distinct on (d.date)
              d.date, 'diesel'::text as product,
              d.sales_pump1, d.sales_pump2, d.total_sales, d.testing
            from public.dsr_diesel d
            where d.date between p_start and p_end
            order by d.date, d.created_at desc
          )
        ) t
      ), '[]'::jsonb)
    )
  );
end;
$$;

comment on function public.get_meter_sales_breakdown(date, date) is
  'Pump / shift / salesman aggregates (cash + phone + credit + expense + total) plus daily pump columns.';

