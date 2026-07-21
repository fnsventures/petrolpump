-- Default vault document types (safe to re-run after staging truncate/sync)
insert into public.document_categories (name, label, sort_order)
values
  ('purchase', 'Purchase invoice', 1),
  ('license', 'License / permit', 2),
  ('insurance', 'Insurance', 3),
  ('compliance', 'Tax / compliance', 4),
  ('bank', 'Bank / finance', 5),
  ('other', 'Other', 6)
on conflict (name) do update set label = excluded.label, sort_order = excluded.sort_order;
