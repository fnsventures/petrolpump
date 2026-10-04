-- Add receipts and buying_price_per_litre to dsr for profit calculation.
-- When receipts > 0, admin sets buying_price_per_litre; it applies until the next receipt.
-- Safe when dsr is already a view (schema.sql bootstrap): alter underlying product tables instead.
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr' and c.relkind = 'r'
  ) then
    alter table public.dsr
      add column if not exists receipts numeric(14,2) not null default 0,
      add column if not exists buying_price_per_litre numeric(10,2);
    comment on column public.dsr.receipts is 'Fuel received (L) on this date. When > 0, admin can set buying_price_per_litre for profit until next receipt.';
    comment on column public.dsr.buying_price_per_litre is 'Admin-only: cost per litre for fuel received; used for profit from this date until next DSR with receipts > 0.';
  else
    alter table if exists public.dsr_petrol
      add column if not exists receipts numeric(14,2) not null default 0,
      add column if not exists buying_price_per_litre numeric(10,2);
    alter table if exists public.dsr_diesel
      add column if not exists receipts numeric(14,2) not null default 0,
      add column if not exists buying_price_per_litre numeric(10,2);
    comment on column public.dsr_petrol.receipts is 'Fuel received (L) on this date. When > 0, admin can set buying_price_per_litre for profit until next receipt.';
    comment on column public.dsr_petrol.buying_price_per_litre is 'Admin-only: cost per litre for fuel received; used for profit from this date until next DSR with receipts > 0.';
    comment on column public.dsr_diesel.receipts is 'Fuel received (L) on this date. When > 0, admin can set buying_price_per_litre for profit until next receipt.';
    comment on column public.dsr_diesel.buying_price_per_litre is 'Admin-only: cost per litre for fuel received; used for profit from this date until next DSR with receipts > 0.';
  end if;
end $$;
