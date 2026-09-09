-- Lehmann Werbetool v0.7 – WhatsApp Cloud API
-- Einmal im Supabase SQL Editor ausführen. Kann danach erneut ausgeführt werden.

-- WhatsApp kennt zusätzlich den Status "read".
alter type public.delivery_state add value if not exists 'read';

alter table public.campaigns
  add column if not exists whatsapp_template_name text,
  add column if not exists whatsapp_template_language text default 'de',
  add column if not exists whatsapp_template_params jsonb default '[]'::jsonb,
  add column if not exists whatsapp_send_status text,
  add column if not exists whatsapp_sent_at timestamptz;

create index if not exists idx_cr_whatsapp_provider_message
  on public.campaign_recipients(provider_message_id)
  where assigned_channel = 'whatsapp';

create index if not exists idx_cr_whatsapp_recipient
  on public.campaign_recipients(recipient_address)
  where assigned_channel = 'whatsapp';
