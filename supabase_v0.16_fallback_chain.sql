-- Nachverfolgbare Fallback-Kette pro Kampagne.
-- Jeder weitere Versandversuch wird als interne, mit der Hauptkampagne
-- verknuepfte Kampagne gespeichert. So bleiben Provider-IDs und Historie
-- jedes einzelnen Versuchs unveraendert erhalten.

alter table public.campaigns
  add column if not exists root_campaign_id uuid null
    references public.campaigns(id) on delete cascade,
  add column if not exists parent_campaign_id uuid null
    references public.campaigns(id) on delete cascade,
  add column if not exists fallback_channel public.channel_name null,
  add column if not exists fallback_level integer not null default 0;

alter table public.campaigns
  drop constraint if exists campaigns_fallback_level_check;

alter table public.campaigns
  add constraint campaigns_fallback_level_check
  check (fallback_level >= 0);

create index if not exists campaigns_root_campaign_id_idx
  on public.campaigns(root_campaign_id)
  where root_campaign_id is not null;

create index if not exists campaigns_parent_campaign_id_idx
  on public.campaigns(parent_campaign_id)
  where parent_campaign_id is not null;

alter table public.campaign_recipients
  add column if not exists fallback_source_recipient_id uuid null
    references public.campaign_recipients(id) on delete set null,
  add column if not exists fallback_next_campaign_id uuid null
    references public.campaigns(id) on delete set null,
  add column if not exists fallback_processed_at timestamptz null,
  add column if not exists fallback_exhausted_at timestamptz null,
  add column if not exists fallback_note text null;

create index if not exists campaign_recipients_fallback_source_idx
  on public.campaign_recipients(fallback_source_recipient_id)
  where fallback_source_recipient_id is not null;

create index if not exists campaign_recipients_fallback_next_idx
  on public.campaign_recipients(fallback_next_campaign_id)
  where fallback_next_campaign_id is not null;

create index if not exists campaign_recipients_unprocessed_failure_idx
  on public.campaign_recipients(campaign_id, state)
  where fallback_processed_at is null
    and state in ('failed', 'skipped', 'opted_out');

comment on column public.campaigns.root_campaign_id is
  'Hauptkampagne fuer interne Fallback-Versandlaeufe; NULL bei sichtbaren Hauptkampagnen.';
comment on column public.campaigns.parent_campaign_id is
  'Direkter vorheriger Fallback-Lauf.';
comment on column public.campaign_recipients.fallback_processed_at is
  'Gesetzt, sobald der naechste gewaehlte Kanal geplant oder die Kette erschoepft wurde.';
comment on column public.campaign_recipients.fallback_exhausted_at is
  'Gesetzt, wenn nach diesem Fehler kein weiterer gewaehlter und nutzbarer Kanal existiert.';
