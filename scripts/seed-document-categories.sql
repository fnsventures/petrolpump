-- Default vault document types (safe to re-run after staging truncate/sync)
insert into public.document_categories (name, label, folder_layout, sort_order)
values
  ('purchase', 'Purchase invoices', 'year_month', 1),
  ('license', 'License / permit', 'year', 2),
  ('insurance', 'Insurance', 'year', 3),
  ('compliance', 'Tax / compliance', 'year', 4),
  ('bank', 'Bank / finance', 'year', 5),
  ('other', 'Other', 'year', 6)
on conflict (name) do update set
  label = excluded.label,
  folder_layout = excluded.folder_layout,
  sort_order = excluded.sort_order;
