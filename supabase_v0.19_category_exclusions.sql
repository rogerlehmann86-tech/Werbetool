-- v0.19: Persist category exclusions for segment-based campaigns.
alter table public.campaigns
  add column if not exists excluded_category_filter text[] not null default '{}';

comment on column public.campaigns.excluded_category_filter is
  'Categories whose contacts are excluded from a segment campaign.';
