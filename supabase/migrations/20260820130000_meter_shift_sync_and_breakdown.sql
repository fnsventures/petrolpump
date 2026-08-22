-- Bidirectional meter sync (shift ↔ daily) + sales breakdown for pump / shift / staff.
-- Additive on top of 20260820120000_meter_shift_readings.

-- ─── sync_dsr_meters_from_shifts ────────────────────────────────────────────
-- Roll up morning+afternoon nozzle meters into daily dsr_* open/close/sales/testing.
-- Does not touch dip, stock, receipts, rates, or buying price on existing rows.
-- Nozzles with no shift rows keep existing daily values (never zeroed by omission).

create or replace function public.sync_dsr_meters_from_shifts(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_product text;
  v_o11 numeric; v_o12 numeric; v_o21 numeric; v_o22 numeric;
  v_c11 numeric; v_c12 numeric; v_c21 numeric; v_c22 numeric;
  v_test numeric;
  v_s1 numeric; v_s2 numeric; v_total numeric;
  v_existing_id uuid;
  v_touched text[] := array[]::text[];
  v_has_any boolean;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  foreach v_product in array array['petrol', 'diesel']
  loop
    -- Must clear: SELECT INTO leaves prior value when zero rows match.
    v_existing_id := null;
    v_o11 := null; v_o12 := null; v_o21 := null; v_o22 := null;
    v_c11 := null; v_c12 := null; v_c21 := null; v_c22 := null;
    v_test := 0;
    v_has_any := false;

    select
      q.has_any,
      coalesce(q.o11_m, q.o11_a),
      coalesce(q.o12_m, q.o12_a),
      coalesce(q.o21_m, q.o21_a),
      coalesce(q.o22_m, q.o22_a),
      coalesce(q.c11_a, q.c11_m),
      coalesce(q.c12_a, q.c12_m),
      coalesce(q.c21_a, q.c21_m),
      coalesce(q.c22_a, q.c22_m),
      q.testing
    into
      v_has_any,
      v_o11, v_o12, v_o21, v_o22,
      v_c11, v_c12, v_c21, v_c22,
      v_test
    from (
      select
        count(*) > 0 as has_any,
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
        coalesce(sum(r.testing_litres), 0) as testing
      from public.meter_shift_readings r
      where r.reading_date = p_date
        and r.product = v_product
    ) q;

    if not coalesce(v_has_any, false) then
      continue;
    end if;

    -- Closing falls back to opening when that nozzle was never closed
    v_c11 := coalesce(v_c11, v_o11);
    v_c12 := coalesce(v_c12, v_o12);
    v_c21 := coalesce(v_c21, v_o21);
    v_c22 := coalesce(v_c22, v_o22);

    if v_product = 'petrol' then
      select id,
        coalesce(v_o11, opening_pump1_nozzle1),
        coalesce(v_o12, opening_pump1_nozzle2),
        coalesce(v_o21, opening_pump2_nozzle1),
        coalesce(v_o22, opening_pump2_nozzle2),
        coalesce(v_c11, closing_pump1_nozzle1),
        coalesce(v_c12, closing_pump1_nozzle2),
        coalesce(v_c21, closing_pump2_nozzle1),
        coalesce(v_c22, closing_pump2_nozzle2)
      into
        v_existing_id,
        v_o11, v_o12, v_o21, v_o22,
        v_c11, v_c12, v_c21, v_c22
      from public.dsr_petrol
      where date = p_date
      order by created_at desc
      limit 1;

      v_o11 := coalesce(v_o11, 0); v_o12 := coalesce(v_o12, 0);
      v_o21 := coalesce(v_o21, 0); v_o22 := coalesce(v_o22, 0);
      v_c11 := coalesce(v_c11, v_o11); v_c12 := coalesce(v_c12, v_o12);
      v_c21 := coalesce(v_c21, v_o21); v_c22 := coalesce(v_c22, v_o22);

      v_s1 := greatest(v_c11 - v_o11, 0) + greatest(v_c12 - v_o12, 0);
      v_s2 := greatest(v_c21 - v_o21, 0) + greatest(v_c22 - v_o22, 0);
      v_total := v_s1 + v_s2;

      if v_existing_id is not null then
        update public.dsr_petrol set
          opening_pump1_nozzle1 = v_o11,
          opening_pump1_nozzle2 = v_o12,
          opening_pump2_nozzle1 = v_o21,
          opening_pump2_nozzle2 = v_o22,
          closing_pump1_nozzle1 = v_c11,
          closing_pump1_nozzle2 = v_c12,
          closing_pump2_nozzle1 = v_c21,
          closing_pump2_nozzle2 = v_c22,
          sales_pump1 = v_s1,
          sales_pump2 = v_s2,
          total_sales = v_total,
          testing = v_test
        where id = v_existing_id;
      else
        insert into public.dsr_petrol (
          date,
          opening_pump1_nozzle1, opening_pump1_nozzle2,
          opening_pump2_nozzle1, opening_pump2_nozzle2,
          closing_pump1_nozzle1, closing_pump1_nozzle2,
          closing_pump2_nozzle1, closing_pump2_nozzle2,
          sales_pump1, sales_pump2, total_sales, testing,
          dip_reading, stock, receipts, created_by
        ) values (
          p_date,
          v_o11, v_o12, v_o21, v_o22,
          v_c11, v_c12, v_c21, v_c22,
          v_s1, v_s2, v_total, v_test,
          0, 0, 0, v_uid
        );
      end if;
    else
      select id,
        coalesce(v_o11, opening_pump1_nozzle1),
        coalesce(v_o12, opening_pump1_nozzle2),
        coalesce(v_o21, opening_pump2_nozzle1),
        coalesce(v_o22, opening_pump2_nozzle2),
        coalesce(v_c11, closing_pump1_nozzle1),
        coalesce(v_c12, closing_pump1_nozzle2),
        coalesce(v_c21, closing_pump2_nozzle1),
        coalesce(v_c22, closing_pump2_nozzle2)
      into
        v_existing_id,
        v_o11, v_o12, v_o21, v_o22,
        v_c11, v_c12, v_c21, v_c22
      from public.dsr_diesel
      where date = p_date
      order by created_at desc
      limit 1;

      v_o11 := coalesce(v_o11, 0); v_o12 := coalesce(v_o12, 0);
      v_o21 := coalesce(v_o21, 0); v_o22 := coalesce(v_o22, 0);
      v_c11 := coalesce(v_c11, v_o11); v_c12 := coalesce(v_c12, v_o12);
      v_c21 := coalesce(v_c21, v_o21); v_c22 := coalesce(v_c22, v_o22);

      v_s1 := greatest(v_c11 - v_o11, 0) + greatest(v_c12 - v_o12, 0);
      v_s2 := greatest(v_c21 - v_o21, 0) + greatest(v_c22 - v_o22, 0);
      v_total := v_s1 + v_s2;

      if v_existing_id is not null then
        update public.dsr_diesel set
          opening_pump1_nozzle1 = v_o11,
          opening_pump1_nozzle2 = v_o12,
          opening_pump2_nozzle1 = v_o21,
          opening_pump2_nozzle2 = v_o22,
          closing_pump1_nozzle1 = v_c11,
          closing_pump1_nozzle2 = v_c12,
          closing_pump2_nozzle1 = v_c21,
          closing_pump2_nozzle2 = v_c22,
          sales_pump1 = v_s1,
          sales_pump2 = v_s2,
          total_sales = v_total,
          testing = v_test
        where id = v_existing_id;
      else
        insert into public.dsr_diesel (
          date,
          opening_pump1_nozzle1, opening_pump1_nozzle2,
          opening_pump2_nozzle1, opening_pump2_nozzle2,
          closing_pump1_nozzle1, closing_pump1_nozzle2,
          closing_pump2_nozzle1, closing_pump2_nozzle2,
          sales_pump1, sales_pump2, total_sales, testing,
          dip_reading, stock, receipts, created_by
        ) values (
          p_date,
          v_o11, v_o12, v_o21, v_o22,
          v_c11, v_c12, v_c21, v_c22,
          v_s1, v_s2, v_total, v_test,
          0, 0, 0, v_uid
        );
      end if;
    end if;

    v_touched := array_append(v_touched, v_product);
  end loop;

  return jsonb_build_object(
    'date', p_date,
    'synced_products', to_jsonb(v_touched)
  );
end;
$$;

comment on function public.sync_dsr_meters_from_shifts(date) is
  'Roll shift nozzle meters into daily dsr_* open/close/sales/testing (preserves dip/receipts/rates; keeps daily meters for nozzles without shift rows).';

grant execute on function public.sync_dsr_meters_from_shifts(date) to authenticated;

-- ─── sync_shift_meters_from_dsr ─────────────────────────────────────────────
-- Push daily open/close into existing shift rows for continuity.
-- Updates respect closing_meter >= opening_meter.

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

  -- Unpivot latest daily meters once, then apply in bulk
  with daily as (
    (
      select 'petrol'::text as product,
        p.opening_pump1_nozzle1 as o11, p.opening_pump1_nozzle2 as o12,
        p.opening_pump2_nozzle1 as o21, p.opening_pump2_nozzle2 as o22,
        p.closing_pump1_nozzle1 as c11, p.closing_pump1_nozzle2 as c12,
        p.closing_pump2_nozzle1 as c21, p.closing_pump2_nozzle2 as c22
      from public.dsr_petrol p
      where p.date = p_date
      order by p.created_at desc
      limit 1
    )
    union all
    (
      select 'diesel'::text,
        d.opening_pump1_nozzle1, d.opening_pump1_nozzle2,
        d.opening_pump2_nozzle1, d.opening_pump2_nozzle2,
        d.closing_pump1_nozzle1, d.closing_pump1_nozzle2,
        d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
      from public.dsr_diesel d
      where d.date = p_date
      order by d.created_at desc
      limit 1
    )
  ),
  nozzles as (
    select product, 1::smallint as pump_no, 1::smallint as nozzle_no, o11 as opening, c11 as closing from daily
    union all select product, 1, 2, o12, c12 from daily
    union all select product, 2, 1, o21, c21 from daily
    union all select product, 2, 2, o22, c22 from daily
  )
  update public.meter_shift_readings r set
    opening_meter = coalesce(n.opening, r.opening_meter),
    closing_meter = case
      when not v_has_afternoon then
        greatest(coalesce(n.closing, r.closing_meter), coalesce(n.opening, r.opening_meter))
      else
        greatest(r.closing_meter, coalesce(n.opening, r.opening_meter))
    end,
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
  'Push daily DSR open/close into existing shift rows; keeps afternoon open aligned with morning close.';

grant execute on function public.sync_shift_meters_from_dsr(date, text) to authenticated;

-- ─── Enhance get_meter_shift_readings with suggested openings + daily meters ─

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
      'total_sales', v_petrol.total_sales
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
      'total_sales', v_diesel.total_sales
    ) else null end
  );

  -- Suggested openings: prior shift closings first
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
    -- Same-day daily openings, then prior-day daily closings (fill gaps only)
    if v_daily_meters->'petrol' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_daily_meters->'petrol'->'opening_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_daily_meters->'petrol'->'opening_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_daily_meters->'petrol'->'opening_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_daily_meters->'petrol'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_daily_meters->'diesel' is not null then
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
  -- Afternoon: only prior/morning closings (already in v_suggested). Do NOT
  -- fall back to same-day daily openings — those are start-of-day meters.

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
        'has_row', v_petrol.id is not null
      ),
      'diesel', jsonb_build_object(
        'total_sales', coalesce(v_diesel.total_sales, 0),
        'testing', coalesce(v_diesel.testing, 0),
        'has_row', v_diesel.id is not null
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
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.product, t.pump_no)
        from (
          select reading_date, product, pump_no,
            sum(litres) as litres, sum(net_litres) as net_litres
          from readings
          group by reading_date, product, pump_no
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
            sum(r.litres) as total_litres,
            sum(r.net_litres) as net_litres,
            coalesce(max(c.cash_collected), 0) as cash_collected
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
  'Pump / shift / salesman sales aggregates plus daily pump columns for a date range.';

grant execute on function public.get_meter_sales_breakdown(date, date) to authenticated;
