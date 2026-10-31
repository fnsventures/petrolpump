-- Centralized pump/station configuration (replaces scattered localStorage + hardcoded values)

create table if not exists public.pump_settings (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.pump_settings is 'Single-row JSON config for station branding, alerts, shifts, pump layout, billing defaults.';

insert into public.pump_settings (id, config)
values (
  1,
  '{
    "station": {
      "displayName": "Bishnupriya Fuels",
      "legalName": "BISHNU PRIYA FUELS",
      "brandShort": "Bishnu Priya",
      "brandAccent": "Fuels",
      "tagline": "Authorized Dealer — Bharat Petroleum Corporation Ltd.",
      "address": "Plot No. 1541, Khata No. 445/94, Mouza Padmanavpur, Taluka Balichandrapur",
      "email": "cmbfillingstation@gmail.com",
      "mobile": "+91 96689 13299",
      "gstin": "21BBNPR7397L3ZR",
      "license": "P/EC/OR/14/2557 (P459205)",
      "supportEmail": "official@fnsventures.in",
      "supportWhatsapp": "+91 96689 13299"
    },
    "billing": {
      "invoicePrefix": "CRI/",
      "defaultPartyName": "Cash A/c",
      "defaultFuelGstPct": 18,
      "receiptHistoryStart": "2000-01-01"
    },
    "pumps": {
      "petrol": { "pumps": 2, "nozzlesPerPump": 2, "tankLabel": "MS (Petrol)", "tankCapacity": "15KL" },
      "diesel": { "pumps": 2, "nozzlesPerPump": 2, "tankLabel": "HSD", "tankCapacity": "20KL" }
    },
    "reports": {
      "tanks": [
        { "key": "hsd1", "label": "HSD 1", "product": "diesel", "capacity": "20 Kl" },
        { "key": "hsd2", "label": "HSD 2", "product": "diesel", "capacity": "20 Kl" },
        { "key": "ms", "label": "MS", "product": "petrol", "capacity": "15 Kl" }
      ],
      "fuelGstPct": 18,
      "petrolPurchaseVatPct": 28,
      "dieselPurchaseVatPct": 24,
      "purchaseTaxInclusive": false,
      "fuelSupplierLabel": "BPCL / Fuel supplier"
    },
    "alerts": {
      "lowStockPetrol": 5000,
      "lowStockDiesel": 5000,
      "highCredit": 0,
      "highVariation": 0,
      "dayClosingReminder": true
    },
    "shifts": {
      "morning": { "name": "Morning shift", "start": "06:00", "end": "14:00" },
      "afternoon": { "name": "Afternoon shift", "start": "14:00", "end": "22:00" }
    }
  }'::jsonb
)
on conflict (id) do nothing;

alter table public.pump_settings enable row level security;

create policy pump_settings_select_authenticated
  on public.pump_settings for select to authenticated
  using (true);

create policy pump_settings_upsert_admin
  on public.pump_settings for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.pump_settings to authenticated;
grant insert, update on public.pump_settings to authenticated;
