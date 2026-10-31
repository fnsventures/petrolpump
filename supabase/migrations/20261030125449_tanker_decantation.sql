-- Tanker decantation register: one row per compartment / product unloaded into a tank.
--
-- The operator records the tank dip (cm) and the stock it converts to (L) just before and just
-- after unloading, the invoice quantity, density and temperature, and optionally links the
-- purchase invoice in the vault. Sales are stopped while decanting, so the stock change is what
-- the tanker delivered:
--
--   received_litres          = stock_after - stock_before
--   delivery_variance_litres = received_litres - invoice_qty_litres   (negative = short delivery)
--
-- get_stock_variance (20261030125450) uses the day's decanted invoice quantity as the receipt
-- figure when a decantation exists, and reports the short delivery next to the dip variance.
--
-- Supervisors and admins add and edit rows; only admins delete. A supervisor cannot write a
-- row for a future date or for a day whose meters are locked (certified or night cash
-- collected), the same rule as the daily meter sheet.

create table if not exists public.tanker_decantations (
  id uuid primary key default gen_random_uuid(),
  decant_date date not null,
  product text not null check (product in ('petrol', 'diesel')),
  invoice_no text check (invoice_no is null or char_length(btrim(invoice_no)) between 1 and 64),
  invoice_document_id uuid references public.invoice_documents (id) on delete set null,
  truck_no text check (truck_no is null or char_length(btrim(truck_no)) between 1 and 32),
  invoice_qty_litres numeric(14, 2) not null check (invoice_qty_litres > 0),
  dip_before_cm numeric(8, 2) check (dip_before_cm is null or dip_before_cm >= 0),
  stock_before_litres numeric(14, 2) not null check (stock_before_litres >= 0),
  dip_after_cm numeric(8, 2) check (dip_after_cm is null or dip_after_cm >= 0),
  stock_after_litres numeric(14, 2) not null check (stock_after_litres >= 0),
  density_kg_m3 numeric(8, 2) check (density_kg_m3 is null or density_kg_m3 between 600 and 1000),
  invoice_density_kg_m3 numeric(8, 2)
    check (invoice_density_kg_m3 is null or invoice_density_kg_m3 between 600 and 1000),
  temperature_c numeric(5, 2) check (temperature_c is null or temperature_c between -10 and 70),
  received_litres numeric(14, 2) generated always as (stock_after_litres - stock_before_litres) stored,
  delivery_variance_litres numeric(14, 2)
    generated always as ((stock_after_litres - stock_before_litres) - invoice_qty_litres) stored,
  remarks text check (remarks is null or char_length(remarks) <= 500),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint tanker_decantations_after_gte_before check (stock_after_litres >= stock_before_litres)
);

create index if not exists tanker_decantations_date_idx
  on public.tanker_decantations (decant_date desc, product);
create index if not exists tanker_decantations_invoice_document_idx
  on public.tanker_decantations (invoice_document_id)
  where invoice_document_id is not null;

comment on table public.tanker_decantations is
  'Tanker unloading: dip before/after, invoice qty, density, temperature. delivery_variance_litres < 0 is a short delivery. Feeds get_stock_variance receipts.';
comment on column public.tanker_decantations.stock_before_litres is
  'Tank stock (L) from the dip chart just before unloading.';
comment on column public.tanker_decantations.stock_after_litres is
  'Tank stock (L) from the dip chart after unloading and settling.';
comment on column public.tanker_decantations.delivery_variance_litres is
  '(stock_after - stock_before) - invoice_qty. Negative = short delivery.';
comment on column public.tanker_decantations.density_kg_m3 is
  'Observed density at the station (kg/m³).';
comment on column public.tanker_decantations.invoice_density_kg_m3 is
  'Density printed on the invoice / challan (kg/m³).';

create or replace function public.tanker_decantations_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := timezone('utc'::text, now());
  new.invoice_no := nullif(btrim(coalesce(new.invoice_no, '')), '');
  new.truck_no := nullif(upper(btrim(coalesce(new.truck_no, ''))), '');
  new.remarks := nullif(btrim(coalesce(new.remarks, '')), '');

  if new.decant_date > public.meter_station_today() then
    raise exception 'Decantation date cannot be in the future.';
  end if;

  -- Same lock as the daily meter sheet: once the day is certified or its night cash collected,
  -- only an admin may change the stock that day's variance is computed from.
  if not coalesce(public.is_admin(), true) then
    foreach v_date in array array[new.decant_date, case when tg_op = 'UPDATE' then old.decant_date end] loop
      if v_date is not null and public.meter_day_is_locked(v_date) then
        raise exception 'Meters for % are locked (day certified or night cash collected). Ask an admin.', v_date;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists tanker_decantations_guard on public.tanker_decantations;
create trigger tanker_decantations_guard
  before insert or update on public.tanker_decantations
  for each row execute function public.tanker_decantations_guard();

revoke all on function public.tanker_decantations_guard() from public, anon;

drop trigger if exists audit_tanker_decantations_trigger on public.tanker_decantations;
create trigger audit_tanker_decantations_trigger
  after insert or update or delete on public.tanker_decantations
  for each row execute function public.audit_trigger_fn();

alter table public.tanker_decantations enable row level security;

revoke all on table public.tanker_decantations from anon, authenticated;
grant select, insert, update, delete on table public.tanker_decantations to authenticated;

drop policy if exists "tanker_decantations_select" on public.tanker_decantations;
create policy "tanker_decantations_select" on public.tanker_decantations
  for select to authenticated
  using ((select public.is_supervisor_or_admin()));

drop policy if exists "tanker_decantations_insert_own" on public.tanker_decantations;
create policy "tanker_decantations_insert_own" on public.tanker_decantations
  for insert to authenticated
  with check ((select public.is_supervisor_or_admin()) and created_by = (select auth.uid()));

drop policy if exists "tanker_decantations_update_staff" on public.tanker_decantations;
create policy "tanker_decantations_update_staff" on public.tanker_decantations
  for update to authenticated
  using ((select public.is_supervisor_or_admin()))
  with check ((select public.is_supervisor_or_admin()));

drop policy if exists "tanker_decantations_delete_admin" on public.tanker_decantations;
create policy "tanker_decantations_delete_admin" on public.tanker_decantations
  for delete to authenticated
  using ((select public.is_admin()));
