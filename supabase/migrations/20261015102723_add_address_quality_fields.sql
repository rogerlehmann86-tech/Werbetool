alter table public.contacts
  add column if not exists geo_latitude double precision,
  add column if not exists geo_longitude double precision,
  add column if not exists geo_status text,
  add column if not exists geo_address_key text,
  add column if not exists geo_result_label text,
  add column if not exists geo_checked_at timestamptz;

alter table public.campaigns
  add column if not exists geo_filter_enabled boolean not null default false,
  add column if not exists geo_radius_km integer,
  add column if not exists geo_origin_label text;
