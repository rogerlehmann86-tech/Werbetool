alter table public.campaigns
  add column if not exists geo_analysis jsonb;
