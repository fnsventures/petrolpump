-- Queue the letter PDF after the insert commits, same as sales invoices.
-- The previous AFTER INSERT trigger called Drive while the row was still
-- invisible to the edge function, so the PDF was often never stored.

drop trigger if exists letterhead_letters_enqueue_drive_pdf on public.letterhead_letters;

create constraint trigger letterhead_letters_enqueue_drive_pdf
after insert on public.letterhead_letters
deferrable initially deferred
for each row
execute function public.enqueue_drive_pdf_from_letter();
