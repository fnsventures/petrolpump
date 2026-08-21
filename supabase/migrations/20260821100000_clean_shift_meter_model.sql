-- ============================================================================
-- CLEAN SHIFT ↔ METER MODEL
-- ============================================================================
-- Consolidates the iterative Aug-21 patches into one migration.
--
-- Ownership:
--   meter_shift_readings / meter_shift_cash  → shift register only
--   dsr_petrol / dsr_diesel                   → finished meter sheet only
--   get_shift_aggregated_daily_meters        → read-only MS/HSD form prefill
--   sync_dsr_meters_from_shifts              → compat no-op (no dsr_* writes)
--
-- Also:
--   - dsr_stock skips incomplete stubs (NULL dip_stock)
--   - prior openings use last complete daily, not stubs
--   - daily → shift push only from complete sheets
--   - purge leftover shift stubs (stock/dip shown as 0)

-- ---------------------------------------------------------------------------
-- 1) Stock view: incomplete stubs must not publish dip_stock = 0
-- ---------------------------------------------------------------------------
drop view if exists public.dsr_stock;

create view public.dsr_stock
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
  'Stock reconciliation. Incomplete meter stubs expose NULL dip_stock so opening lookback skips them.';

grant select on public.dsr_stock to authenticated;

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
  'DSR stock range; incomplete stubs return NULL dip_stock; opening uses last real dip.';

grant execute on function public.get_dsr_stock_range(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Read-only day rollup for meter form (entered nozzles/shifts only)
-- ---------------------------------------------------------------------------
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

    -- No prior-day inventing: null nozzles stay null. Closing mirrors opening if unset.
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
  'Read-only shift rollup for meter form prefill. Entered nozzles only; never writes dsr_*.';

grant execute on function public.get_shift_aggregated_daily_meters(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Legacy sync name: no DSR writes (meter sheet owns dsr_*)
-- ---------------------------------------------------------------------------
create or replace function public.sync_dsr_meters_from_shifts(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift_products text[] := array[]::text[];
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  select coalesce(array_agg(distinct r.product order by r.product), array[]::text[])
  into v_shift_products
  from public.meter_shift_readings r
  where r.reading_date = p_date
    and r.product in ('petrol', 'diesel');

  return jsonb_build_object(
    'date', p_date,
    'synced_products', '[]'::jsonb,
    'shift_products', to_jsonb(v_shift_products),
    'skipped_complete', '[]'::jsonb
  );
end;
$$;

comment on function public.sync_dsr_meters_from_shifts(date) is
  'Compat no-op: does not write dsr_*. Meter sheet owns daily meters.';

grant execute on function public.sync_dsr_meters_from_shifts(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Delete shift: do not rewrite daily meters
-- ---------------------------------------------------------------------------
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

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzle/cash for date+shift. Does not modify dsr_*.';

grant execute on function public.delete_meter_shift_readings(date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Prior openings: complete daily only; morning falls back to last complete
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6) Daily → shift: only push from finished meter sheets
-- ---------------------------------------------------------------------------
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

grant execute on function public.sync_shift_meters_from_dsr(date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Purge unfinished stubs left by earlier sync migrations
-- ---------------------------------------------------------------------------
delete from public.dsr_petrol p
where not public.dsr_meter_row_is_complete(p.petrol_rate, p.dip_reading, p.stock, p.receipts);

delete from public.dsr_diesel d
where not public.dsr_meter_row_is_complete(d.diesel_rate, d.dip_reading, d.stock, d.receipts);
