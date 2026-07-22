-- Drive folder layout per document type:
--   year_month → Root / YYYY / {label} / MonthName /
--   year       → Root / YYYY /  (files stored flat under the year)

alter table public.document_categories
  add column if not exists folder_layout text not null default 'year';

alter table public.document_categories
  drop constraint if exists document_categories_folder_layout_check;

alter table public.document_categories
  add constraint document_categories_folder_layout_check
  check (folder_layout in ('year_month', 'year'));

comment on column public.document_categories.folder_layout is
  'Google Drive path: year_month = Root/YYYY/{label}/Month; year = Root/YYYY (flat).';

-- Purchase invoices nest under year → type → month; everything else is year-only.
update public.document_categories
set
  folder_layout = case when name = 'purchase' then 'year_month' else 'year' end,
  label = case when name = 'purchase' then 'Purchase invoices' else label end
where true;
