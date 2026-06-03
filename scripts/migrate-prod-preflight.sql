-- Pre-migration checks for production (read-only).
\echo '=== Production preflight ==='

\echo ''
\echo '-- Applied migrations (count) --'
select count(*) as applied_migrations
from supabase_migrations.schema_migrations;

\echo ''
\echo '-- Latest applied migration --'
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 5;

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

select 'dsr_petrol' as source,
  case when to_regclass('public.dsr_petrol') is not null
    then (select count(*)::text from public.dsr_petrol)
    else 'not present yet'
  end as rows;

select 'dsr_diesel' as source,
  case when to_regclass('public.dsr_diesel') is not null
    then (select count(*)::text from public.dsr_diesel)
    else 'not present yet'
  end as rows;

select 'credit_customers' as source, count(*)::text as rows from public.credit_customers;
select 'day_closing' as source, count(*)::text as rows from public.day_closing;
select 'users' as source, count(*)::text as rows from public.users;
