-- Canonical definition of public.enqueue_drive_pdf_archive. Edit here, then:
--   node scripts/sql-functions.mjs emit enqueue_drive_pdf_archive
create or replace function public.enqueue_drive_pdf_archive(p_kind text, p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_host text;
  v_auth text;
  v_apikey text;
  v_url text;
  v_payload jsonb;
  v_drive jsonb;
begin
  perform public.require_staff_access();

  begin
  if p_kind is null or p_record_id is null then
    return;
  end if;

  select config->'integrations'->'googleDrive'
    into v_drive
  from public.pump_settings
  where id = 1;
  if coalesce(v_drive->>'enabled', '') <> 'true'
     or length(trim(coalesce(v_drive->>'rootFolderId', ''))) = 0 then
    return;
  end if;

  begin
    v_headers := current_setting('request.headers', true)::jsonb;
  exception when others then
    return;
  end;
  if v_headers is null then
    return;
  end if;

  v_host := nullif(trim(v_headers->>'host'), '');
  v_auth := nullif(trim(v_headers->>'authorization'), '');
  v_apikey := coalesce(nullif(trim(v_headers->>'apikey'), ''), nullif(trim(v_headers->>'x-api-key'), ''));
  if v_host is null or v_auth is null then
    return;
  end if;

  v_url := case
    when v_host like '%localhost%' or v_host like '127.0.0.1%'
      then 'http://' || v_host || '/functions/v1/drive-files'
    else 'https://' || v_host || '/functions/v1/drive-files'
  end;

  if p_kind = 'sales_invoice' then
    v_payload := jsonb_build_object('action', 'archive', 'kind', 'sales_invoice', 'invoiceId', p_record_id);
  elsif p_kind = 'letter' then
    v_payload := jsonb_build_object('action', 'archive', 'kind', 'letter', 'letterId', p_record_id);
  else
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_strip_nulls(jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', v_auth,
      'apikey', v_apikey
    )),
    body := v_payload,
    timeout_milliseconds := 25000
  );
  exception
    when others then
      raise warning 'enqueue_drive_pdf_archive failed: %', sqlerrm;
  end;
end;
$$;

comment on function public.enqueue_drive_pdf_archive(text, uuid) is
  'Fire-and-forget Drive PDF archive via pg_net. Provisioned staff only. Never blocks invoice/letter save.';

revoke all on function public.enqueue_drive_pdf_archive(text, uuid) from public, anon;

grant execute on function public.enqueue_drive_pdf_archive(text, uuid) to authenticated;
