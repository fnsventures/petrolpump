-- Canonical definition of public.enqueue_drive_pdf_from_letter. Edit here, then:
--   node scripts/sql-functions.mjs emit enqueue_drive_pdf_from_letter
create or replace function public.enqueue_drive_pdf_from_letter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enqueue_drive_pdf_archive('letter', new.id);
  return new;
end;
$$;
