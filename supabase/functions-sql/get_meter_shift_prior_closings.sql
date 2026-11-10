-- Canonical definition of public.get_meter_shift_prior_closings. Edit here, then:
--   node scripts/sql-functions.mjs emit get_meter_shift_prior_closings
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
