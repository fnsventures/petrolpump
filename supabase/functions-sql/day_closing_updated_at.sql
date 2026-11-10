-- Canonical definition of public.day_closing_updated_at. Edit here, then:
--   node scripts/sql-functions.mjs emit day_closing_updated_at
create or replace function public.day_closing_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;
