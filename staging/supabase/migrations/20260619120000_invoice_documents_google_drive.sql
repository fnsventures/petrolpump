-- Invoice documents: metadata in Postgres, files in Google Drive (year/month folders)

create table if not exists public.invoice_documents (
  id uuid primary key default uuid_generate_v4(),
  invoice_date date not null,
  year smallint not null,
  month smallint not null check (month between 1 and 12),
  title text,
  vendor text,
  amount numeric(14, 2),
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  drive_file_id text not null,
  drive_folder_id text,
  drive_web_view_link text,
  notes text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists invoice_documents_date_idx on public.invoice_documents (invoice_date desc);
create index if not exists invoice_documents_year_month_idx on public.invoice_documents (year desc, month desc);

comment on table public.invoice_documents is
  'Supplier / purchase invoice files stored in Google Drive under year/month folders.';
comment on column public.invoice_documents.drive_file_id is 'Google Drive file ID for download via edge function.';
comment on column public.invoice_documents.drive_web_view_link is 'Optional Drive web view link (anyone-with-link if shared on upload).';

alter table public.invoice_documents enable row level security;

drop policy if exists "invoice_documents_select" on public.invoice_documents;
create policy "invoice_documents_select" on public.invoice_documents
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "invoice_documents_insert" on public.invoice_documents;
create policy "invoice_documents_insert" on public.invoice_documents
  for insert to authenticated
  with check (public.is_supervisor_or_admin());

drop policy if exists "invoice_documents_delete_admin" on public.invoice_documents;
create policy "invoice_documents_delete_admin" on public.invoice_documents
  for delete to authenticated
  using (public.is_admin());

-- Edge function inserts via service role; authenticated users read via RLS above.

create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();

  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'staff' then v_role = 'admin'
    when 'analysis' then v_role = 'admin'
    when 'reports' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'day-closing' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit-overdue' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    when 'invoices' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;
