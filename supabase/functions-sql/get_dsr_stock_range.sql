-- Canonical definition of public.get_dsr_stock_range. Edit here, then:
--   node scripts/sql-functions.mjs emit get_dsr_stock_range
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
    select
      d.date,
      'petrol'::text as product,
      case
        when public.dsr_meter_row_is_complete(d.petrol_rate, d.dip_reading, d.stock, d.receipts)
          then d.stock
        else null
      end::numeric(14,2) as dip_stock,
      d.receipts,
      d.total_sales as sale_from_meter,
      d.testing,
      greatest(d.total_sales - d.testing, 0) as net_sale,
      d.remarks as remark,
      d.created_by,
      d.created_at
    from (
      select distinct on (p.date) p.*
      from public.dsr_petrol p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
    union all
    select
      d.date,
      'diesel'::text,
      case
        when public.dsr_meter_row_is_complete(d.diesel_rate, d.dip_reading, d.stock, d.receipts)
          then d.stock
        else null
      end::numeric(14,2),
      d.receipts,
      d.total_sales,
      d.testing,
      greatest(d.total_sales - d.testing, 0),
      d.remarks,
      d.created_by,
      d.created_at
    from (
      select distinct on (p.date) p.*
      from public.dsr_diesel p, bounds b
      where p.date >= b.lookback_start and p.date <= p_end
      order by p.date, p.created_at desc nulls last, p.id desc
    ) d
  ),
  with_opening as (
    select
      b.*,
      coalesce(
        (
          select p.dip_stock
          from base p
          where p.product = b.product
            and p.date < b.date
            and p.dip_stock is not null
          order by p.date desc
          limit 1
        ),
        0
      ) as opening_stock
    from base b
  )
  select
    w.date,
    w.product,
    w.opening_stock,
    w.receipts,
    (w.opening_stock + w.receipts) as total_stock,
    w.sale_from_meter,
    w.testing,
    w.net_sale,
    ((w.opening_stock + w.receipts) - w.net_sale) as closing_stock,
    w.dip_stock,
    case
      when w.dip_stock is null then null
      else (((w.opening_stock + w.receipts) - w.net_sale) - w.dip_stock)
    end as variation,
    w.remark,
    w.created_by,
    w.created_at
  from with_opening w
  where w.date >= p_start and w.date <= p_end;
end;
$$;

comment on function public.get_dsr_stock_range(date, date) is
  'DSR stock range; incomplete stubs return NULL dip_stock; opening uses last real dip.';

grant execute on function public.get_dsr_stock_range(date, date) to authenticated;
