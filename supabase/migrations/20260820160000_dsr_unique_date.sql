-- Enforce one MS/HSD meter row per date (docs already assume this).
-- Deduplicate first (keep latest; merge sparse admin/receipt fields), then unique(date).
-- Harden day closing + stock readers with DISTINCT ON as defense in depth.

-- ─── 1) Deduplicate dsr_petrol ───────────────────────────────────────────────

do $$
declare
  v_affected date[];
begin
  select coalesce(array_agg(date order by date), array[]::date[])
  into v_affected
  from (
    select date from public.dsr_petrol group by date having count(*) > 1
  ) d;

  if cardinality(v_affected) > 0 then
    with merged as (
      select
        d.date,
        (array_agg(d.id order by d.created_at desc nulls last, d.id desc))[1] as keep_id,
        (array_agg(d.petrol_rate order by d.created_at desc nulls last)
          filter (where d.petrol_rate is not null))[1] as petrol_rate,
        (array_agg(d.diesel_rate order by d.created_at desc nulls last)
          filter (where d.diesel_rate is not null))[1] as diesel_rate,
        (array_agg(d.buying_price_per_litre order by d.created_at desc nulls last)
          filter (where d.buying_price_per_litre is not null))[1] as buying_price_per_litre,
        (array_agg(d.supplier_invoice_no order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.supplier_invoice_no), '') is not null))[1] as supplier_invoice_no,
        (array_agg(d.supplier_gstin order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.supplier_gstin), '') is not null))[1] as supplier_gstin,
        (array_agg(d.invoice_document_id order by d.created_at desc nulls last)
          filter (where d.invoice_document_id is not null))[1] as invoice_document_id,
        (array_agg(d.remarks order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.remarks), '') is not null))[1] as remarks,
        max(d.receipts) as receipts,
        max(d.testing) as testing,
        max(d.dip_reading) as dip_reading,
        max(d.stock) as stock
      from public.dsr_petrol d
      where d.date = any (v_affected)
      group by d.date
    )
    update public.dsr_petrol k set
      petrol_rate = coalesce(k.petrol_rate, m.petrol_rate),
      diesel_rate = coalesce(k.diesel_rate, m.diesel_rate),
      buying_price_per_litre = coalesce(k.buying_price_per_litre, m.buying_price_per_litre),
      supplier_invoice_no = coalesce(nullif(btrim(k.supplier_invoice_no), ''), m.supplier_invoice_no),
      supplier_gstin = coalesce(nullif(btrim(k.supplier_gstin), ''), m.supplier_gstin),
      invoice_document_id = coalesce(k.invoice_document_id, m.invoice_document_id),
      remarks = coalesce(nullif(btrim(k.remarks), ''), m.remarks),
      receipts = case when coalesce(k.receipts, 0) = 0 then coalesce(m.receipts, 0) else k.receipts end,
      testing = case when coalesce(k.testing, 0) = 0 then coalesce(m.testing, 0) else k.testing end,
      dip_reading = case when coalesce(k.dip_reading, 0) = 0 then coalesce(m.dip_reading, 0) else k.dip_reading end,
      stock = case when coalesce(k.stock, 0) = 0 then coalesce(m.stock, 0) else k.stock end
    from merged m
    where k.id = m.keep_id;

    delete from public.dsr_petrol d
    using (
      select id,
        row_number() over (partition by date order by created_at desc nulls last, id desc) as rn
      from public.dsr_petrol
      where date = any (v_affected)
    ) r
    where d.id = r.id and r.rn > 1;
  end if;
end;
$$;

-- ─── 2) Deduplicate dsr_diesel ───────────────────────────────────────────────

do $$
declare
  v_affected date[];
begin
  select coalesce(array_agg(date order by date), array[]::date[])
  into v_affected
  from (
    select date from public.dsr_diesel group by date having count(*) > 1
  ) d;

  if cardinality(v_affected) > 0 then
    with merged as (
      select
        d.date,
        (array_agg(d.id order by d.created_at desc nulls last, d.id desc))[1] as keep_id,
        (array_agg(d.petrol_rate order by d.created_at desc nulls last)
          filter (where d.petrol_rate is not null))[1] as petrol_rate,
        (array_agg(d.diesel_rate order by d.created_at desc nulls last)
          filter (where d.diesel_rate is not null))[1] as diesel_rate,
        (array_agg(d.buying_price_per_litre order by d.created_at desc nulls last)
          filter (where d.buying_price_per_litre is not null))[1] as buying_price_per_litre,
        (array_agg(d.supplier_invoice_no order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.supplier_invoice_no), '') is not null))[1] as supplier_invoice_no,
        (array_agg(d.supplier_gstin order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.supplier_gstin), '') is not null))[1] as supplier_gstin,
        (array_agg(d.invoice_document_id order by d.created_at desc nulls last)
          filter (where d.invoice_document_id is not null))[1] as invoice_document_id,
        (array_agg(d.remarks order by d.created_at desc nulls last)
          filter (where nullif(btrim(d.remarks), '') is not null))[1] as remarks,
        max(d.receipts) as receipts,
        max(d.testing) as testing,
        max(d.dip_reading) as dip_reading,
        max(d.stock) as stock
      from public.dsr_diesel d
      where d.date = any (v_affected)
      group by d.date
    )
    update public.dsr_diesel k set
      petrol_rate = coalesce(k.petrol_rate, m.petrol_rate),
      diesel_rate = coalesce(k.diesel_rate, m.diesel_rate),
      buying_price_per_litre = coalesce(k.buying_price_per_litre, m.buying_price_per_litre),
      supplier_invoice_no = coalesce(nullif(btrim(k.supplier_invoice_no), ''), m.supplier_invoice_no),
      supplier_gstin = coalesce(nullif(btrim(k.supplier_gstin), ''), m.supplier_gstin),
      invoice_document_id = coalesce(k.invoice_document_id, m.invoice_document_id),
      remarks = coalesce(nullif(btrim(k.remarks), ''), m.remarks),
      receipts = case when coalesce(k.receipts, 0) = 0 then coalesce(m.receipts, 0) else k.receipts end,
      testing = case when coalesce(k.testing, 0) = 0 then coalesce(m.testing, 0) else k.testing end,
      dip_reading = case when coalesce(k.dip_reading, 0) = 0 then coalesce(m.dip_reading, 0) else k.dip_reading end,
      stock = case when coalesce(k.stock, 0) = 0 then coalesce(m.stock, 0) else k.stock end
    from merged m
    where k.id = m.keep_id;

    delete from public.dsr_diesel d
    using (
      select id,
        row_number() over (partition by date order by created_at desc nulls last, id desc) as rn
      from public.dsr_diesel
      where date = any (v_affected)
    ) r
    where d.id = r.id and r.rn > 1;
  end if;
end;
$$;

-- ─── 3) Unique (date) — replaces non-unique date indexes ───────────────────

drop index if exists public.dsr_petrol_date_idx;
drop index if exists public.dsr_diesel_date_idx;

alter table public.dsr_petrol
  drop constraint if exists dsr_petrol_date_unique;
alter table public.dsr_petrol
  add constraint dsr_petrol_date_unique unique (date);

alter table public.dsr_diesel
  drop constraint if exists dsr_diesel_date_unique;
alter table public.dsr_diesel
  add constraint dsr_diesel_date_unique unique (date);

comment on constraint dsr_petrol_date_unique on public.dsr_petrol is
  'One MS meter row per business date (prevents day-closing / stock double-count).';
comment on constraint dsr_diesel_date_unique on public.dsr_diesel is
  'One HSD meter row per business date (prevents day-closing / stock double-count).';

-- ─── 4) Harden views: DISTINCT ON (date) ───────────────────────────────────

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
    remarks, created_by, created_at
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
    remarks, created_by, created_at
  from (
    select distinct on (date) *
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d;

comment on view public.dsr is
  'Backward-compatible union view (one row per product per date). SELECT only; writes go to dsr_petrol / dsr_diesel.';

create or replace view public.dsr_stock
with (security_invoker = true) as
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
  from (
    select distinct on (date) *
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
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
  from (
    select distinct on (date) *
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d
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

comment on view public.dsr_stock is
  'Computed stock reconciliation (one row per product per date). Derived from dsr_petrol/dsr_diesel.';

-- ─── 5) Day closing: one row per product even if duplicates sneak back ─────

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

  -- Total sale: gross litres × rate; DISTINCT ON product guards against duplicate dates
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
  'Shared day-closing totals. Total sale uses gross DSR litres (incl. testing), one row per product.';

-- ─── 6) Stock range RPC: DISTINCT ON date per product ──────────────────────

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
    from (
      select distinct on (p.date) p.*
      from public.dsr_petrol p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
    union all
    select d.date, 'diesel'::text, d.stock, d.receipts, d.total_sales, d.testing,
      greatest(d.total_sales - d.testing, 0), d.remarks, d.created_by, d.created_at
    from (
      select distinct on (p.date) p.*
      from public.dsr_diesel p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
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
  'DSR stock reconciliation for a date range; one row per product per date; LAG scoped to range + 1 prior day.';
