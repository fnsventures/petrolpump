-- Drop letter text from Postgres once the PDF is archived in Google Drive.
-- GST invoice rows stay in the database (needed for reports); only generated files live in Drive.

comment on table public.letterhead_letters is
  'Index of official letters. The PDF lives in Google Drive. body is held only until archive succeeds, then cleared.';

comment on column public.letterhead_letters.body is
  'Temporary letter text used to build the Drive PDF. Cleared after a successful archive so the database stays small.';

comment on column public.letterhead_letters.subject is
  'Short subject for history lists. Full letter content is the Drive PDF.';

-- Keep the content check satisfied after body is stripped.
update public.letterhead_letters
set subject = left(regexp_replace(trim(body), '\s+', ' ', 'g'), 80)
where drive_file_id is not null
  and length(trim(coalesce(subject, ''))) = 0
  and length(trim(coalesce(body, ''))) > 0;

update public.letterhead_letters
set subject = 'Letter'
where drive_file_id is not null
  and length(trim(coalesce(subject, ''))) = 0;

update public.letterhead_letters
set body = ''
where drive_file_id is not null
  and length(trim(coalesce(subject, ''))) > 0;
