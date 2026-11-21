-- Canonical definition of public.e20_parse_yes_no. Edit here, then:
--   node scripts/sql-functions.mjs emit e20_parse_yes_no
create or replace function public.e20_parse_yes_no(p_val text)
returns boolean
language sql
immutable
as $$
  select case
    when p_val is null or btrim(p_val) = '' then null
    when lower(btrim(p_val)) in ('true', 'yes', 'y', '1', 't') then true
    when lower(btrim(p_val)) in ('false', 'no', 'n', '0', 'f') then false
    else null
  end;
$$;

grant execute on function public.e20_parse_yes_no(text) to authenticated;

grant execute on function public.e20_parse_yes_no(text) to authenticated;
