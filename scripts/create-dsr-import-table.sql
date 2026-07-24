-- Temporary table matching legacy prod public.dsr (one row per date + product).
drop table if exists public._dsr_import;

create table public._dsr_import (
  id uuid primary key,
  date date not null,
  product text not null,
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  remarks text,
  created_by uuid,
  created_at timestamptz,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  net_sale numeric(14,2),
  receipts numeric(14,2) not null default 0,
  buying_price_per_litre numeric(10,2)
);
