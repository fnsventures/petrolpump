-- Evaluate auth.uid(), auth.jwt(), is_admin() and is_supervisor_or_admin()
-- once per statement instead of once per row in RLS policies. Wrapping a call
-- as (select fn()) lets Postgres run it as an initPlan (Supabase RLS
-- performance guidance). Policy meaning does not change.
--
-- Rewrites every policy in public and storage in place with ALTER POLICY, so
-- roles, command and permissive/restrictive stay as they are. Policies that
-- already contain a wrapped call are skipped.

do $$
declare
  v_pol record;
  v_pattern constant text :=
    '\m((public\.)?is_supervisor_or_admin|(public\.)?is_admin|auth\.uid|auth\.jwt)\(\)';
  v_wrapped constant text := 'SELECT (auth\.(uid|jwt)|(public\.)?is_(supervisor_or_)?admin)\(\)';
  v_using text;
  v_check text;
  v_sql text;
  v_count int := 0;
begin
  for v_pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
      and (coalesce(qual, '') ~ v_pattern or coalesce(with_check, '') ~ v_pattern)
  loop
    if coalesce(v_pol.qual, '') ~ v_wrapped or coalesce(v_pol.with_check, '') ~ v_wrapped then
      continue;
    end if;

    v_using := regexp_replace(v_pol.qual, v_pattern, '(select \1())', 'g');
    v_check := regexp_replace(v_pol.with_check, v_pattern, '(select \1())', 'g');

    v_sql := format('alter policy %I on %I.%I', v_pol.policyname, v_pol.schemaname, v_pol.tablename);
    if v_using is not null then
      v_sql := v_sql || format(' using (%s)', v_using);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;

    execute v_sql;
    v_count := v_count + 1;
  end loop;

  raise notice 'rls_initplan_wrap: rewrote % policies', v_count;
end;
$$;
