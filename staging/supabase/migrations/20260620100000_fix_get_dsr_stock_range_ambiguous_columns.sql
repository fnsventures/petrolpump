-- Fix PL/pgSQL ambiguity: RETURNS TABLE column names (date, product, dip_stock, …)
-- shadow unqualified SQL references inside RETURN QUERY.

create or replace function public.get_dsr_stock_range(p_start date, p_end date)
returns table (
  date date,
  product text,
  opening_stock numeric,
  receipts numeric,
  total_stock numeric,
  sale_from_meter numeric,
  testing numeric,
  net_sale numeric,
  closing_stock numeric,
  dip_stock numeric,
  variation numeric,
  remark text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  return query
  with bounds as (
    select (p_start - interval '1 day')::date as lookback_start
  ),
  base as (
    select d.date, 'petrol'::text as product, d.stock as dip_stock, d.receipts,
      d.total_sales as sale_from_meter, d.testing,
      greatest(d.total_sales - d.testing, 0) as net_sale,
      d.remarks as remark, d.created_by, d.created_at
    from public.dsr_petrol d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
    union all
    select d.date, 'diesel'::text, d.stock, d.receipts, d.total_sales, d.testing,
      greatest(d.total_sales - d.testing, 0), d.remarks, d.created_by, d.created_at
    from public.dsr_diesel d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
  ),
  with_opening as (
    select b.*,
      coalesce(lag(b.dip_stock) over (partition by b.product order by b.date), 0) as opening_stock
    from base b
  )
  select w.date, w.product, w.opening_stock, w.receipts,
    (w.opening_stock + w.receipts) as total_stock, w.sale_from_meter, w.testing, w.net_sale,
    ((w.opening_stock + w.receipts) - w.net_sale) as closing_stock, w.dip_stock,
    (((w.opening_stock + w.receipts) - w.net_sale) - w.dip_stock) as variation,
    w.remark, w.created_by, w.created_at
  from with_opening w
  where w.date >= p_start and w.date <= p_end;
end;
$$;
