-- Optional signature footer on typed letters; allow explicit save (without print/Word).

alter table public.letterhead_letters
  add column if not exists include_sign boolean not null default true;

comment on column public.letterhead_letters.include_sign is
  'When true, printed/saved letter includes FROM station name / Authorised Signatory block.';

-- Drop any check constraint on export_type (auto-generated names can vary), then add the updated one.
do $$
declare
  cname text;
begin
  for cname in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'letterhead_letters'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%export_type%'
  loop
    execute format('alter table public.letterhead_letters drop constraint %I', cname);
  end loop;

  alter table public.letterhead_letters
    add constraint letterhead_letters_export_type_check
    check (export_type in ('print', 'word', 'save'));
end $$;
