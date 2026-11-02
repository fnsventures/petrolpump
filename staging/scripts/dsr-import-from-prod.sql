-- Split legacy prod dsr rows into staging dsr_petrol / dsr_diesel tables.
insert into public.dsr_petrol (
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
)
select
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
from public._dsr_import
where lower(trim(product)) = 'petrol'
on conflict (id) do update set
  date = excluded.date,
  opening_pump1_nozzle1 = excluded.opening_pump1_nozzle1,
  opening_pump1_nozzle2 = excluded.opening_pump1_nozzle2,
  opening_pump2_nozzle1 = excluded.opening_pump2_nozzle1,
  opening_pump2_nozzle2 = excluded.opening_pump2_nozzle2,
  closing_pump1_nozzle1 = excluded.closing_pump1_nozzle1,
  closing_pump1_nozzle2 = excluded.closing_pump1_nozzle2,
  closing_pump2_nozzle1 = excluded.closing_pump2_nozzle1,
  closing_pump2_nozzle2 = excluded.closing_pump2_nozzle2,
  sales_pump1 = excluded.sales_pump1,
  sales_pump2 = excluded.sales_pump2,
  total_sales = excluded.total_sales,
  testing = excluded.testing,
  dip_reading = excluded.dip_reading,
  stock = excluded.stock,
  receipts = excluded.receipts,
  petrol_rate = excluded.petrol_rate,
  diesel_rate = excluded.diesel_rate,
  buying_price_per_litre = excluded.buying_price_per_litre,
  remarks = excluded.remarks,
  created_by = excluded.created_by,
  created_at = excluded.created_at;

insert into public.dsr_diesel (
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
)
select
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
from public._dsr_import
where lower(trim(product)) = 'diesel'
on conflict (id) do update set
  date = excluded.date,
  opening_pump1_nozzle1 = excluded.opening_pump1_nozzle1,
  opening_pump1_nozzle2 = excluded.opening_pump1_nozzle2,
  opening_pump2_nozzle1 = excluded.opening_pump2_nozzle1,
  opening_pump2_nozzle2 = excluded.opening_pump2_nozzle2,
  closing_pump1_nozzle1 = excluded.closing_pump1_nozzle1,
  closing_pump1_nozzle2 = excluded.closing_pump1_nozzle2,
  closing_pump2_nozzle1 = excluded.closing_pump2_nozzle1,
  closing_pump2_nozzle2 = excluded.closing_pump2_nozzle2,
  sales_pump1 = excluded.sales_pump1,
  sales_pump2 = excluded.sales_pump2,
  total_sales = excluded.total_sales,
  testing = excluded.testing,
  dip_reading = excluded.dip_reading,
  stock = excluded.stock,
  receipts = excluded.receipts,
  petrol_rate = excluded.petrol_rate,
  diesel_rate = excluded.diesel_rate,
  buying_price_per_litre = excluded.buying_price_per_litre,
  remarks = excluded.remarks,
  created_by = excluded.created_by,
  created_at = excluded.created_at;

drop table if exists public._dsr_import;
