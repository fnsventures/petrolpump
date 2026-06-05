-- Pre-migration checks for production (read-only).
\echo '=== Production preflight ==='

select exists (
  select 1 from information_schema.tables
  where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
) as has_migration_history \gset

\echo ''
\echo '-- Applied migrations (count) --'
\if :has_migration_history
select count(*) as applied_migrations
from supabase_migrations.schema_migrations;
\else
select '0 (no migration history — first db push will create it)' as applied_migrations;
\endif

\echo ''
\echo '-- Latest applied migration --'
\if :has_migration_history
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 5;
\else
select '(no migration history yet)' as note;
\endif

\echo ''
\echo '-- public.dsr kind (r=legacy table, v=new view) --'
select c.relname, c.relkind,
  case c.relkind
    when 'r' then 'legacy table — split migration still needed'
    when 'v' then 'view — DSR split likely done'
    else c.relkind::text
  end as meaning
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'dsr';

\echo ''
\echo '-- public.dsr_stock kind --'
select c.relname, c.relkind,
  case c.relkind
    when 'r' then 'legacy table — stock view migration still needed'
    when 'v' then 'view — stock migration likely done'
    else c.relkind::text
  end as meaning
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'dsr_stock';

\echo ''
\echo '-- Row counts (safe if tables not created yet) --'
select 'dsr (table or view)' as source, count(*)::text as rows from public.dsr;

select to_regclass('public.dsr_petrol') is not null as has_dsr_petrol \gset
\if :has_dsr_petrol
select 'dsr_petrol' as source, count(*)::text as rows from public.dsr_petrol;
\else
select 'dsr_petrol' as source, 'not present yet' as rows;
\endif

select to_regclass('public.dsr_diesel') is not null as has_dsr_diesel \gset
\if :has_dsr_diesel
select 'dsr_diesel' as source, count(*)::text as rows from public.dsr_diesel;
\else
select 'dsr_diesel' as source, 'not present yet' as rows;
\endif

select 'credit_customers' as source, count(*)::text as rows from public.credit_customers;
select 'day_closing' as source, count(*)::text as rows from public.day_closing;
select 'users' as source, count(*)::text as rows from public.users;
