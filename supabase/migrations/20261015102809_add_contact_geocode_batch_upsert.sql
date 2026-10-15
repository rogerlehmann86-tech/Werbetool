create or replace function public.save_contact_geocodes(p_records jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  changed_count integer;
begin
  update public.contacts c
  set
    geo_latitude = x.geo_latitude,
    geo_longitude = x.geo_longitude,
    geo_status = x.geo_status,
    geo_address_key = x.geo_address_key,
    geo_result_label = x.geo_result_label,
    geo_checked_at = x.geo_checked_at
  from jsonb_to_recordset(p_records) as x(
    id bigint,
    geo_latitude double precision,
    geo_longitude double precision,
    geo_status text,
    geo_address_key text,
    geo_result_label text,
    geo_checked_at timestamptz
  )
  where c.id = x.id;

  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.save_contact_geocodes(jsonb) from public, anon;
grant execute on function public.save_contact_geocodes(jsonb) to authenticated;
