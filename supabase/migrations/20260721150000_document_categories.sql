-- Configurable vault document types (Settings → Document types)

create table if not exists public.document_categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  label text not null,
  sort_order int not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists document_categories_sort_idx
  on public.document_categories (sort_order, label);

comment on table public.document_categories is
  'User-managed document types shown in Vault upload/filter and Settings.';

alter table public.document_categories enable row level security;

drop policy if exists "document_categories_select_authenticated" on public.document_categories;
create policy "document_categories_select_authenticated" on public.document_categories
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "document_categories_insert_admin" on public.document_categories;
create policy "document_categories_insert_admin" on public.document_categories
  for insert to authenticated with check (public.is_admin());

drop policy if exists "document_categories_update_admin" on public.document_categories;
create policy "document_categories_update_admin" on public.document_categories
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "document_categories_delete_admin" on public.document_categories;
create policy "document_categories_delete_admin" on public.document_categories
  for delete to authenticated using (public.is_admin());

insert into public.document_categories (name, label, sort_order)
values
  ('purchase', 'Purchase invoice', 1),
  ('license', 'License / permit', 2),
  ('insurance', 'Insurance', 3),
  ('compliance', 'Tax / compliance', 4),
  ('bank', 'Bank / finance', 5),
  ('other', 'Other', 6)
on conflict (name) do update set label = excluded.label, sort_order = excluded.sort_order;

alter table public.invoice_documents
  drop constraint if exists invoice_documents_category_check;
