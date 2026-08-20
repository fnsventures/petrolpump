-- Improve shift → daily sync so MS/HSD stubs get prior-day openings for
-- nozzles not covered by the shift (instead of zeros), and never overwrite
-- a completed daily sheet's meters for non-admins.

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
  v_ex_o11 numeric; v_ex_o12 numeric; v_ex_o21 numeric; v_ex_o22 numeric;
  v_ex_c11 numeric; v_ex_c12 numeric; v_ex_c21 numeric; v_ex_c22 numeric;
  v_pr_c11 numeric; v_pr_c12 numeric; v_pr_c21 numeric; v_pr_c22 numeric;
  v_test numeric;
  v_s1 numeric; v_s2 numeric; v_total numeric;
  v_existing_id uuid;
  v_existing_testing numeric;
  v_existing_rate numeric;
  v_existing_dip numeric;
  v_existing_stock numeric;
  v_existing_receipts numeric;
  v_touched text[] := array[]::text[];
  v_skipped text[] := array[]::text[];
  v_has_any boolean;
  v_found boolean;
  v_complete boolean;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  foreach v_product in array array['petrol', 'diesel']
  loop
    v_existing_id := null;
    v_existing_testing := null;
    v_existing_rate := null;
    v_existing_dip := null;
    v_existing_stock := null;
    v_existing_receipts := null;
    v_ex_o11 := null; v_ex_o12 := null; v_ex_o21 := null; v_ex_o22 := null;
    v_ex_c11 := null; v_ex_c12 := null; v_ex_c21 := null; v_ex_c22 := null;
    v_pr_c11 := null; v_pr_c12 := null; v_pr_c21 := null; v_pr_c22 := null;
    v_o11 := null; v_o12 := null; v_o21 := null; v_o22 := null;
    v_c11 := null; v_c12 := null; v_c21 := null; v_c22 := null;
    v_test := 0;
    v_has_any := false;
    v_found := false;
    v_complete := false;

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
      q.testing,
      q.s1,
      q.s2
    into
      v_has_any,
      v_o11, v_o12, v_o21, v_o22,
      v_c11, v_c12, v_c21, v_c22,
      v_test,
      v_s1, v_s2
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
      continue;
    end if;

    if v_product = 'petrol' then
      select
        id,
        opening_pump1_nozzle1, opening_pump1_nozzle2,
        opening_pump2_nozzle1, opening_pump2_nozzle2,
        closing_pump1_nozzle1, closing_pump1_nozzle2,
        closing_pump2_nozzle1, closing_pump2_nozzle2,
        testing, petrol_rate, dip_reading, stock, receipts
      into
        v_existing_id,
        v_ex_o11, v_ex_o12, v_ex_o21, v_ex_o22,
        v_ex_c11, v_ex_c12, v_ex_c21, v_ex_c22,
        v_existing_testing, v_existing_rate, v_existing_dip, v_existing_stock, v_existing_receipts
      from public.dsr_petrol
      where date = p_date
      limit 1;
      v_found := found;

      select
        closing_pump1_nozzle1, closing_pump1_nozzle2,
        closing_pump2_nozzle1, closing_pump2_nozzle2
      into v_pr_c11, v_pr_c12, v_pr_c21, v_pr_c22
      from public.dsr_petrol
      where date < p_date
      order by date desc
      limit 1;
    else
      select
        id,
        opening_pump1_nozzle1, opening_pump1_nozzle2,
        opening_pump2_nozzle1, opening_pump2_nozzle2,
        closing_pump1_nozzle1, closing_pump1_nozzle2,
        closing_pump2_nozzle1, closing_pump2_nozzle2,
        testing, diesel_rate, dip_reading, stock, receipts
      into
        v_existing_id,
        v_ex_o11, v_ex_o12, v_ex_o21, v_ex_o22,
        v_ex_c11, v_ex_c12, v_ex_c21, v_ex_c22,
        v_existing_testing, v_existing_rate, v_existing_dip, v_existing_stock, v_existing_receipts
      from public.dsr_diesel
      where date = p_date
      limit 1;
      v_found := found;

      select
        closing_pump1_nozzle1, closing_pump1_nozzle2,
        closing_pump2_nozzle1, closing_pump2_nozzle2
      into v_pr_c11, v_pr_c12, v_pr_c21, v_pr_c22
      from public.dsr_diesel
      where date < p_date
      order by date desc
      limit 1;
    end if;

    -- Do not clobber a finished daily sheet (rate/dip/stock/receipts) unless admin.
    if v_found and public.dsr_meter_row_is_complete(
      v_existing_rate, v_existing_dip, v_existing_stock, v_existing_receipts
    ) and not public.is_admin() then
      v_skipped := array_append(v_skipped, v_product);
      continue;
    end if;

    -- Prefer shift → existing (non-zero) → prior-day closing → 0
    v_o11 := coalesce(v_o11, nullif(v_ex_o11, 0), v_pr_c11, 0);
    v_o12 := coalesce(v_o12, nullif(v_ex_o12, 0), v_pr_c12, 0);
    v_o21 := coalesce(v_o21, nullif(v_ex_o21, 0), v_pr_c21, 0);
    v_o22 := coalesce(v_o22, nullif(v_ex_o22, 0), v_pr_c22, 0);
    -- Closing: shift → existing non-zero → opening (no sale on unused nozzle)
    v_c11 := coalesce(v_c11, nullif(v_ex_c11, 0), v_o11);
    v_c12 := coalesce(v_c12, nullif(v_ex_c12, 0), v_o12);
    v_c21 := coalesce(v_c21, nullif(v_ex_c21, 0), v_o21);
    v_c22 := coalesce(v_c22, nullif(v_ex_c22, 0), v_o22);

    v_s1 := coalesce(v_s1, 0);
    v_s2 := coalesce(v_s2, 0);
    v_total := v_s1 + v_s2;
    v_test := greatest(coalesce(v_existing_testing, 0), coalesce(v_test, 0));

    if v_product = 'petrol' then
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
    'synced_products', to_jsonb(v_touched),
    'skipped_complete', to_jsonb(v_skipped)
  );
end;
$$;

comment on function public.sync_dsr_meters_from_shifts(date) is
  'Roll shift meters into daily MS/HSD; backfill unused nozzles from prior day; skip completed sheets for non-admins.';

grant execute on function public.sync_dsr_meters_from_shifts(date) to authenticated;
