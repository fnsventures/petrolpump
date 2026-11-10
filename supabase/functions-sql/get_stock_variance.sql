-- Canonical definition of public.get_stock_variance. Edit here, then:
--   node scripts/sql-functions.mjs emit get_stock_variance
create or replace function public.get_stock_variance(p_start date, p_end date)
returns table (
  date date,
  product text,
  opening_dip numeric,
  receipts numeric,
  dsr_receipts numeric,
  decanted_invoice_litres numeric,
  delivery_variance_litres numeric,
  meter_sales numeric,
  book_stock numeric,
  closing_dip numeric,
  variance_litres numeric,
  variance_pct numeric,
  rate numeric,
  variance_value numeric,
  tolerance_pct numeric,
  over_tolerance boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tolerance numeric;
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

  v_tolerance := public.stock_variance_tolerance_pct();

  return query
  with stock as (
    select s.date, s.product, s.opening_stock, s.receipts, s.net_sale, s.dip_stock
    from public.get_dsr_stock_range(p_start, p_end) s
  ),
  decant as (
    select t.decant_date, t.product,
           sum(t.invoice_qty_litres) as invoice_litres,
           sum(t.delivery_variance_litres) as delivery_variance
    from public.tanker_decantations t
    where t.decant_date between p_start and p_end
    group by t.decant_date, t.product
  ),
  rates as (
    select x.date, 'petrol'::text as product, x.petrol_rate as rate
    from (select distinct on (p.date) p.date, p.petrol_rate
          from public.dsr_petrol p where p.date between p_start and p_end
          order by p.date, p.created_at desc nulls last, p.id desc) x
    union all
    select x.date, 'diesel'::text, x.diesel_rate
    from (select distinct on (d.date) d.date, d.diesel_rate
          from public.dsr_diesel d where d.date between p_start and p_end
          order by d.date, d.created_at desc nulls last, d.id desc) x
  ),
  calc as (
    select
      s.date,
      s.product,
      s.opening_stock as opening_dip,
      coalesce(dc.invoice_litres, s.receipts) as receipts,
      s.receipts as dsr_receipts,
      dc.invoice_litres as decanted_invoice_litres,
      dc.delivery_variance as delivery_variance_litres,
      s.net_sale as meter_sales,
      (s.opening_stock + coalesce(dc.invoice_litres, s.receipts) - s.net_sale) as book_stock,
      s.dip_stock as closing_dip,
      r.rate
    from stock s
    left join decant dc on dc.decant_date = s.date and dc.product = s.product
    left join rates r on r.date = s.date and r.product = s.product
  )
  select
    c.date,
    c.product,
    c.opening_dip,
    c.receipts,
    c.dsr_receipts,
    c.decanted_invoice_litres,
    c.delivery_variance_litres,
    c.meter_sales,
    c.book_stock,
    c.closing_dip,
    (c.closing_dip - c.book_stock) as variance_litres,
    case when c.closing_dip is not null and c.meter_sales > 0
      then round((c.closing_dip - c.book_stock) / c.meter_sales * 100, 3) end as variance_pct,
    c.rate,
    case when c.closing_dip is not null and c.rate is not null
      then round((c.closing_dip - c.book_stock) * c.rate, 2) end as variance_value,
    v_tolerance as tolerance_pct,
    coalesce(
      c.closing_dip is not null
        and c.meter_sales > 0
        and abs((c.closing_dip - c.book_stock) / c.meter_sales * 100) > v_tolerance,
      false
    ) as over_tolerance
  from calc c
  order by c.date desc, c.product;
end;
$$;

comment on function public.get_stock_variance(date, date) is
  'Per product and day: book = opening dip + receipts (decanted invoice qty, else DSR receipts) - net meter sale; variance = closing dip - book (negative = loss); % of meter sale; ₹ at selling rate; over_tolerance vs stock_variance_tolerance_pct().';

grant execute on function public.get_stock_variance(date, date) to authenticated;
