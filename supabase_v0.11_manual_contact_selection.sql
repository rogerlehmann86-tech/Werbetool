-- Lehmann Werbetool v0.11
-- Speichert, ob eine Kampagne über ein Segment oder eine manuelle
-- Mehrfachauswahl zusammengestellt wurde.

alter table public.campaigns
  add column if not exists selection_mode text not null default 'segment',
  add column if not exists manual_contact_ids bigint[] not null default '{}'::bigint[];

alter table public.campaigns
  drop constraint if exists campaigns_selection_mode_check;

alter table public.campaigns
  add constraint campaigns_selection_mode_check
  check (selection_mode in ('segment', 'manual'));

comment on column public.campaigns.selection_mode is
  'Empfängerauswahl: segment oder manual';

comment on column public.campaigns.manual_contact_ids is
  'Bei manueller Auswahl die gewählten Kontakt-IDs; die Versandliste liegt zusätzlich in campaign_recipients';
