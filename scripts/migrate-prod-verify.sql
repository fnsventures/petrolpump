-- Post-migration verification for production (read-only).
\echo '=== Production post-migration verification ==='

\echo ''
\echo '-- dsr must be a view --'
select case
  when exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr' and c.relkind = 'v'
  ) then 'OK: public.dsr is a view'
  else 'FAIL: public.dsr is not a view'
end as dsr_view_check;

\echo ''
\echo '-- dsr_stock must be a view --'
select case
  when exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr_stock' and c.relkind = 'v'
  ) then 'OK: public.dsr_stock is a view'
  else 'FAIL: public.dsr_stock is not a view'
end as dsr_stock_view_check;

\echo ''
\echo '-- legacy dsr table must not exist --'
select case
  when not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr' and c.relkind = 'r'
  ) then 'OK: no legacy dsr table'
  else 'FAIL: legacy dsr table still exists'
end as legacy_dsr_check;

\echo ''
\echo '-- DSR row counts --'
select 'dsr_petrol' as table_name, count(*) as rows from public.dsr_petrol
union all
select 'dsr_diesel', count(*) from public.dsr_diesel
union all
select 'dsr (view)', count(*) from public.dsr;

\echo ''
\echo '-- Latest DSR dates (view) --'
select date, product, total_sales
from public.dsr
order by date desc, product
limit 6;

\echo ''
\echo '-- New schema objects present --'
select relname, relkind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and relname in (
    'dsr_petrol', 'dsr_diesel', 'invoices', 'invoice_items',
    'products', 'pump_settings'
  )
order by relname;

\echo ''
\echo '-- Applied migrations (count) --'
select count(*) as applied_migrations
from supabase_migrations.schema_migrations;

\echo ''
\echo '-- Latest applied migration --'
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 3;
