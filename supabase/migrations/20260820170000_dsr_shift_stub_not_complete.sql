-- Shift sync may INSERT daily MS/HSD stubs (meters only, no rate/dip/receipts).
-- Those must NOT count as "already saved" for supervisor lock / past-day shift lock.
-- Supervisors may complete (UPDATE) such stubs even if created_by is another user.

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
    or coalesce(p_dip_reading, 0) <> 0
    or coalesce(p_stock, 0) <> 0
    or coalesce(p_receipts, 0) <> 0;
$$;

comment on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) is
  'True when daily meter sheet was finished (rate/dip/stock/receipts), not a shift-sync stub.';

grant execute on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) to authenticated;

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
  'True when a completed daily MS or HSD sheet exists (excludes shift-sync stubs).';

-- Supervisors can update incomplete stubs (shift-created) to finish the day.
drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (
    public.is_admin()
    or created_by = auth.uid()
    or (
      public.is_supervisor_or_admin()
      and not public.dsr_meter_row_is_complete(
        petrol_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (public.is_supervisor_or_admin());

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (
    public.is_admin()
    or created_by = auth.uid()
    or (
      public.is_supervisor_or_admin()
      and not public.dsr_meter_row_is_complete(
        diesel_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (public.is_supervisor_or_admin());
