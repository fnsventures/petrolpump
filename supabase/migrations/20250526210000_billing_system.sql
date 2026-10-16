-- ============================================================================
-- BILLING SYSTEM: Products, Invoices, Invoice Items
-- Generalized billing for lube sales, accessories, and any product sales
-- with GST (CGST/SGST/IGST) support and auto-incrementing invoice numbers.
-- ============================================================================

-- PRODUCTS master table
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
  for select to authenticated using (true);

drop policy if exists "products_insert_admin" on public.products;
create policy "products_insert_admin" on public.products
  for insert to authenticated with check (public.is_admin());

drop policy if exists "products_update_admin" on public.products;
create policy "products_update_admin" on public.products
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "products_delete_admin" on public.products;
create policy "products_delete_admin" on public.products
  for delete to authenticated using (public.is_admin());


-- Invoice number sequence: generates CRI/YYYY/NNNN format
create sequence if not exists public.invoice_number_seq start with 1 increment by 1;

-- INVOICES table
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

comment on table public.invoices is 'Sales invoices / cash memos for products (lubricants, accessories, etc).';

alter table public.invoices enable row level security;

drop policy if exists "invoices_select_authenticated" on public.invoices;
create policy "invoices_select_authenticated" on public.invoices
  for select to authenticated using (true);

drop policy if exists "invoices_insert_own" on public.invoices;
create policy "invoices_insert_own" on public.invoices
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "invoices_update_by_role" on public.invoices;
create policy "invoices_update_by_role" on public.invoices
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "invoices_delete_admin" on public.invoices;
create policy "invoices_delete_admin" on public.invoices
  for delete to authenticated using (public.is_admin());


-- INVOICE ITEMS (line items for each invoice)
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
  for select to authenticated using (true);

drop policy if exists "invoice_items_insert_own" on public.invoice_items;
create policy "invoice_items_insert_own" on public.invoice_items
  for insert to authenticated with check (true);

drop policy if exists "invoice_items_update_by_role" on public.invoice_items;
create policy "invoice_items_update_by_role" on public.invoice_items
  for update to authenticated using (true) with check (true);

drop policy if exists "invoice_items_delete_authenticated" on public.invoice_items;
create policy "invoice_items_delete_authenticated" on public.invoice_items
  for delete to authenticated using (true);


-- RPC: Generate next invoice number (CRI/YYYY/NNNN)
create or replace function public.generate_invoice_number()
returns text
language plpgsql
security definer
as $$
declare
  v_year text;
  v_seq integer;
  v_number text;
begin
  v_year := to_char(current_date, 'YYYY');
  v_seq := nextval('public.invoice_number_seq');
  v_number := 'CRI/' || lpad(v_seq::text, 4, '0');
  return v_number;
end;
$$;

comment on function public.generate_invoice_number() is 'Generate next sequential invoice number in CRI/NNNN format.';


-- RPC: Save a complete invoice with items in a single transaction
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


-- Add billing to page access check
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
  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'analysis' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    else false
  end;
  return jsonb_build_object('allowed', v_allowed, 'role', v_role, 'page', p_page);
end;
$$;


-- Audit trigger for invoices
drop trigger if exists audit_invoices_trigger on public.invoices;
create trigger audit_invoices_trigger
  after insert or update or delete on public.invoices
  for each row execute function public.audit_trigger_fn();
