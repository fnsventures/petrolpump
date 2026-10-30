-- Short / excess per attendant and shift, computed on the server so the staff and salary
-- pages (and any report) show the same figure as the shift register.
--
--   expected       = net litres (closing - opening - testing, per nozzle) x that day's rate
--   handed_over    = cash + UPI (phone_pay) + shift credit + shift expenses
--   short_excess   = handed_over - expected          (negative = short, positive = excess)
--
-- This is the shift register's own figure (js/meterShiftReading.js computeStaffSummary) with
-- the sign flipped to "cash minus expected". There is no card column: card payments are
-- recorded as UPI. Rates come from that day's dsr_petrol / dsr_diesel row; with no rate the
-- expected and short_excess are null rather than a misleading 0.
--
-- Read-only. Turning a short into a salary deduction stays a separate, admin-confirmed
-- record_salary_payment call.

create or replace function public.get_attendant_short_excess(
  p_start date,
  p_end date,
  p_employee_id uuid default null
)
returns table (
  reading_date date,
  shift text,
  employee_id uuid,
  employee_name text,
  petrol_litres numeric,
  diesel_litres numeric,
  petrol_rate numeric,
  diesel_rate numeric,
  expected numeric,
  cash numeric,
  phone_pay numeric,
  credit numeric,
  expense numeric,
  handed_over numeric,
  short_excess numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  if p_start is null or p_end is null then
    raise exception 'From and To dates are required.';
  end if;
  if p_start > p_end then
    raise exception 'From must be on or before To.';
  end if;
  if p_end - p_start > 400 then
    raise exception 'Choose a range of 400 days or less.';
  end if;

  return query
  with meters as (
    select r.reading_date, r.shift, r.employee_id,
           sum(greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0))
             filter (where r.product = 'petrol') as petrol_l,
           sum(greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0))
             filter (where r.product = 'diesel') as diesel_l
    from public.meter_shift_readings r
    where r.reading_date between p_start and p_end
      and (p_employee_id is null or r.employee_id = p_employee_id)
    group by r.reading_date, r.shift, r.employee_id
  ),
  cash as (
    select c.reading_date, c.shift, c.employee_id,
           c.cash_collected, c.phone_pay, c.credit_amount, c.expense_amount
    from public.meter_shift_cash c
    where c.reading_date between p_start and p_end
      and (p_employee_id is null or c.employee_id = p_employee_id)
  ),
  joined as (
    select coalesce(m.reading_date, c.reading_date) as reading_date,
           coalesce(m.shift, c.shift) as shift,
           coalesce(m.employee_id, c.employee_id) as employee_id,
           coalesce(m.petrol_l, 0) as petrol_l,
           coalesce(m.diesel_l, 0) as diesel_l,
           coalesce(c.cash_collected, 0) as cash,
           coalesce(c.phone_pay, 0) as phone_pay,
           coalesce(c.credit_amount, 0) as credit,
           coalesce(c.expense_amount, 0) as expense
    from meters m
    full join cash c
      on c.reading_date = m.reading_date and c.shift = m.shift and c.employee_id = m.employee_id
  ),
  rates as (
    select dd.date,
           (select p.petrol_rate from public.dsr_petrol p where p.date = dd.date
            order by p.created_at desc nulls last, p.id desc limit 1) as petrol_rate,
           (select d.diesel_rate from public.dsr_diesel d where d.date = dd.date
            order by d.created_at desc nulls last, d.id desc limit 1) as diesel_rate
    from (select distinct j.reading_date as date from joined j) dd
  ),
  priced as (
    select j.*, r.petrol_rate, r.diesel_rate,
           case
             when (j.petrol_l > 0 and r.petrol_rate is null) or (j.diesel_l > 0 and r.diesel_rate is null)
               then null
             else round(j.petrol_l * coalesce(r.petrol_rate, 0) + j.diesel_l * coalesce(r.diesel_rate, 0), 2)
           end as expected
    from joined j
    left join rates r on r.date = j.reading_date
  )
  select p.reading_date, p.shift, p.employee_id, e.name,
         p.petrol_l, p.diesel_l, p.petrol_rate, p.diesel_rate,
         p.expected, p.cash, p.phone_pay, p.credit, p.expense,
         (p.cash + p.phone_pay + p.credit + p.expense) as handed_over,
         (p.cash + p.phone_pay + p.credit + p.expense) - p.expected as short_excess
  from priced p
  left join public.employees e on e.id = p.employee_id
  order by p.reading_date desc, p.shift, e.name;
end;
$$;

comment on function public.get_attendant_short_excess(date, date, uuid) is
  'Per shift and attendant: expected = net shift litres x day rate; handed_over = cash + UPI + shift credit + shift expenses; short_excess = handed_over - expected (negative = short). Null expected when a rate is missing.';

grant execute on function public.get_attendant_short_excess(date, date, uuid) to authenticated;
