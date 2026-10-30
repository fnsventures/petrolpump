-- Dip vs book stock variance, per tank (product) and day.
--
--   receipts       = invoice qty from tanker_decantations that day, else dsr_*.receipts
--   book_stock     = opening_dip + receipts - meter_sales        (meter_sales = net of testing)
--   variance_l     = closing_dip - book_stock                    (negative = loss, positive = gain)
--   variance_pct   = variance_l / meter_sales * 100
--   variance_value = variance_l * that day's selling rate
--
-- Note the sign: dsr_stock.variation is book - dip (positive = loss). This RPC follows the
-- owner's view, dip - book, so a loss reads as a negative number of litres and rupees.
--
-- opening_dip is the last finished dip before the day, exactly as get_dsr_stock_range finds it.
-- A day without a finished meter sheet has null closing_dip and null variance.
--
-- Tolerance: pump_settings.config.alerts.stockVarianceTolerancePct (default 0.5). A day is
-- over_tolerance when |variance_pct| exceeds it.

create or replace function public.stock_variance_tolerance_pct()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
       when s.config #>> '{alerts,stockVarianceTolerancePct}' ~ '^[0-9]+(\.[0-9]+)?$'
         then (s.config #>> '{alerts,stockVarianceTolerancePct}')::numeric
     end
     from public.pump_settings s where s.id = 1),
    0.5
  );
$$;

comment on function public.stock_variance_tolerance_pct() is
  'Stock variance tolerance (% of meter sales) from pump_settings.config.alerts.stockVarianceTolerancePct; 0.5 when unset.';

grant execute on function public.stock_variance_tolerance_pct() to authenticated;

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
