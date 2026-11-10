-- Canonical definition of public.salary_month_payable. Edit here, then:
--   node scripts/sql-functions.mjs emit salary_month_payable
create or replace function public.salary_month_payable(p_employee_id uuid, p_salary_month date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_salary_month)::date;
  v_month_end date := (date_trunc('month', p_salary_month) + interval '1 month' - interval '1 day')::date;
  v_cfg jsonb;
  v_lop_on boolean;
  v_od_on boolean;
  v_paid_leave int;
  v_fixed_days int;
  v_divisor int;
  v_gross numeric;
  v_pf_fixed numeric;
  v_per_day numeric;
  v_leave int;
  v_half int;
  v_over_duty int;
  v_lop numeric;
  v_od numeric;
  v_before_pf numeric;
  v_pf numeric;
begin
  select
    round(greatest(coalesce(e.monthly_salary, 0), 0), 2),
    round(greatest(coalesce(e.pf_contribution, 0), 0), 2)
  into v_gross, v_pf_fixed
  from public.employees e
  where e.id = p_employee_id;
  if not found then
    raise exception 'Staff member not found';
  end if;

  select coalesce(s.config->'payroll', '{}'::jsonb) into v_cfg
  from public.pump_settings s
  where s.id = 1;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);

  -- A missing key uses the default (on); an explicit non-true value turns the rule off.
  v_lop_on := case when v_cfg ? 'lossOfPayEnabled' then v_cfg->'lossOfPayEnabled' = 'true'::jsonb else true end;
  v_od_on := case when v_cfg ? 'overDutyEnabled' then v_cfg->'overDutyEnabled' = 'true'::jsonb else true end;
  v_paid_leave := case
    when jsonb_typeof(v_cfg->'paidLeaveDaysPerMonth') = 'number'
      then least(31, greatest(0, floor((v_cfg->>'paidLeaveDaysPerMonth')::numeric)))::int
    else 2
  end;
  v_fixed_days := case
    when jsonb_typeof(v_cfg->'fixedDaysInMonth') = 'number'
      then least(31, greatest(1, floor((v_cfg->>'fixedDaysInMonth')::numeric)))::int
    else 30
  end;
  v_divisor := case
    when v_cfg->>'dayRateBasis' = 'fixed' then v_fixed_days
    else extract(day from v_month_end)::int
  end;
  v_per_day := v_gross / v_divisor;

  select
    count(*) filter (where a.status in ('leave', 'absent')),
    count(*) filter (where a.status = 'half_day'),
    count(*) filter (where a.status = 'present' and a.over_duty)
  into v_leave, v_half, v_over_duty
  from public.employee_attendance a
  where a.employee_id = p_employee_id
    and a.date between v_month and v_month_end;

  v_lop := case
    when v_lop_on then round((greatest(0, v_leave - v_paid_leave) + v_half * 0.5) * v_per_day, 2)
    else 0
  end;
  if v_lop > 0 and exists (
    select 1 from public.salary_lop_exclusions x
    where x.employee_id = p_employee_id and x.salary_month = v_month
  ) then
    v_lop := 0;
  end if;
  v_od := case when v_od_on then round(v_over_duty * v_per_day, 2) else 0 end;

  v_before_pf := round(greatest(0, round(v_gross + v_od, 2) - v_lop), 2);
  v_pf := case when v_gross > 0 then least(v_pf_fixed, v_gross) else 0 end;
  v_pf := case when v_before_pf > 0 then least(v_pf, v_before_pf) else 0 end;
  return round(greatest(0, v_before_pf - v_pf), 2);
end;
$$;

comment on function public.salary_month_payable(uuid, date) is
  'Internal: net take-home for an employee and salary month (salary + over duty − loss of pay − PF). Mirrors js/payrollRules.js.';

revoke all on function public.salary_month_payable(uuid, date) from public, anon, authenticated;
