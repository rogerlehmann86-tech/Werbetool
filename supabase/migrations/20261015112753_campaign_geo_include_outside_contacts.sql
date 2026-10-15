alter table public.campaigns
  add column if not exists geo_included_contact_ids bigint[] not null default '{}'::bigint[];
