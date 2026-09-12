alter table public.campaign_recipients
  add column if not exists opted_out_at timestamptz,
  add column if not exists opt_out_source text;

create index if not exists campaign_recipients_opted_out_idx
  on public.campaign_recipients (campaign_id, assigned_channel, opted_out_at)
  where opted_out_at is not null;

create table if not exists public.campaign_sms_claims (
  root_campaign_id uuid not null references public.campaigns(id) on delete cascade,
  phone_e164 text not null,
  recipient_id uuid not null references public.campaign_recipients(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  primary key (root_campaign_id, phone_e164),
  unique (recipient_id)
);

insert into public.campaign_sms_claims (root_campaign_id, phone_e164, recipient_id, claimed_at)
select distinct on (coalesce(c.root_campaign_id, c.id), cr.recipient_address)
  coalesce(c.root_campaign_id, c.id), cr.recipient_address, cr.id,
  coalesce(cr.sent_at, cr.status_updated_at, cr.created_at)
from public.campaign_recipients cr
join public.campaigns c on c.id = cr.campaign_id
where cr.assigned_channel = 'sms'
  and cr.recipient_address is not null
  and cr.state <> 'planned'
order by coalesce(c.root_campaign_id, c.id), cr.recipient_address,
         coalesce(cr.sent_at, cr.status_updated_at, cr.created_at)
on conflict do nothing;

alter table public.campaign_sms_claims enable row level security;

comment on table public.campaign_sms_claims is
  'Serverseitige, atomare Einmal-Sperre pro Mobilnummer und Kampagnenkette.';
