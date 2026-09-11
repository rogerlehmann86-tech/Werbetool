import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const clean = (value: unknown) => String(value ?? "").trim();
const normalizePhone = (value: unknown) => {
  let phone = clean(value).replace(/[^0-9+]/g, "");
  if (phone.startsWith("0041")) phone = "+41" + phone.slice(4);
  if (phone.startsWith("0")) phone = "+41" + phone.slice(1);
  return phone;
};
const isSwissMobile = (phone: string) => /^\+417[6-9]\d{7}$/.test(phone);
const personalize = (text: string, contact: any) =>
  text
    .replaceAll("{{vorname}}", clean(contact?.firstname))
    .replaceAll("{{nachname}}", clean(contact?.lastname))
    .replaceAll("{{firma}}", clean(contact?.company));
const withOptOut = (text: string) =>
  /\bstop\b/i.test(text) ? text : text.trimEnd() + "\nAbmeldung: STOP";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function twilioSend(
  accountSid: string,
  authToken: string,
  params: URLSearchParams,
) {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Lehmann-Werbetool/0.7",
      },
      body: params.toString(),
    },
  );
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  return { ok: response.ok, status: response.status, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  let stage = "Start";
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ACCOUNT_SID = clean(Deno.env.get("TWILIO_ACCOUNT_SID"));
    const AUTH_TOKEN = clean(Deno.env.get("TWILIO_AUTH_TOKEN"));
    const MESSAGING_SERVICE_SID = clean(Deno.env.get("TWILIO_MESSAGING_SERVICE_SID"));
    const WEBHOOK_URL = clean(Deno.env.get("TWILIO_WEBHOOK_URL"));
    if (!ACCOUNT_SID || !AUTH_TOKEN || !MESSAGING_SERVICE_SID || !WEBHOOK_URL) {
      throw new Error("Twilio ist noch nicht vollständig in den Supabase Secrets eingerichtet.");
    }

    stage = "Anmeldung";
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) throw new Error("Nicht angemeldet.");
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await caller.auth.getUser();
    if (userError || !user) throw new Error("Ungültige Anmeldung.");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json();
    const campaignId = clean(body?.campaign_id);
    const requestedLimit = Number(body?.limit || 50);
    const batchLimit = Math.max(1, Math.min(50, requestedLimit));
    if (!campaignId) throw new Error("campaign_id fehlt.");

    stage = "Kampagne laden";
    const { data: campaign, error: campaignError } = await admin
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();
    if (campaignError || !campaign) {
      throw new Error(campaignError?.message || "Kampagne nicht gefunden.");
    }
    if (!clean(campaign.sms_text)) {
      throw new Error("In der gespeicherten Kampagne fehlt der SMS-Text.");
    }
    if (["completed"].includes(clean(campaign.sms_send_status))) {
      throw new Error("Der SMS-Versand dieser Kampagne ist bereits abgeschlossen.");
    }

    stage = "Empfänger laden";
    const { data: recipients, error: recipientError } = await admin
      .from("campaign_recipients")
      .select("id,contact_id,state")
      .eq("campaign_id", campaignId)
      .eq("assigned_channel", "sms")
      .eq("state", "planned")
      .order("created_at")
      .limit(batchLimit);
    if (recipientError) throw new Error(recipientError.message);
    if (!recipients?.length) {
      const { count } = await admin
        .from("campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("assigned_channel", "sms")
        .eq("state", "planned");
      if (!count) {
        await admin.from("campaigns").update({
          sms_send_status: "completed",
          sms_provider: "twilio",
          updated_at: new Date().toISOString(),
        }).eq("id", campaignId);
        return json({ ok: true, campaign_id: campaignId, sent_count: 0, failed_count: 0, skipped_count: 0, remaining: 0, completed: true });
      }
      throw new Error("Keine geplanten SMS-Empfänger vorhanden.");
    }

    const contactIds = recipients.map((row: any) => row.contact_id);
    const [{ data: contacts, error: contactsError }, { data: channelRows, error: channelsError }, { data: marketingRows, error: marketingError }] =
      await Promise.all([
        admin.from("contacts").select("id,firstname,lastname,company,phone_mobile_raw,phone_mobile_e164,is_inactive").in("id", contactIds),
        admin.from("contact_channels").select("contact_id,state,opted_out_at,failure_reason").eq("channel", "sms").in("contact_id", contactIds),
        admin.from("contact_marketing").select("contact_id,marketing_status,block_all,note").in("contact_id", contactIds),
      ]);
    if (contactsError) throw new Error(contactsError.message);
    if (channelsError) throw new Error(channelsError.message);
    if (marketingError) throw new Error(marketingError.message);

    const contactMap = new Map((contacts || []).map((row: any) => [String(row.id), row]));
    const channelMap = new Map((channelRows || []).map((row: any) => [String(row.contact_id), row]));
    const marketingMap = new Map((marketingRows || []).map((row: any) => [String(row.contact_id), row]));
    const now = new Date().toISOString();

    await admin.from("campaigns").update({
      sms_send_status: "sending",
      sms_provider: "twilio",
      sms_last_error: null,
      sms_sent_at: campaign.sms_sent_at || now,
      state: "sending",
      sent_at: campaign.sent_at || now,
      updated_at: now,
    }).eq("id", campaignId);

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const recipient of recipients as any[]) {
      const contact = contactMap.get(String(recipient.contact_id));
      const channel = channelMap.get(String(recipient.contact_id));
      const marketing = marketingMap.get(String(recipient.contact_id));
      const phone = normalizePhone(contact?.phone_mobile_e164 || contact?.phone_mobile_raw);
      let skipReason = "";

      if (!contact || contact.is_inactive) skipReason = "Kontakt fehlt oder ist inaktiv.";
      else if (!isSwissMobile(phone)) skipReason = "Keine gültige Schweizer Mobilnummer.";
      else if (marketing?.block_all) skipReason = "Globale Werbesperre.";
      else if (!["consent", "existing_customer"].includes(clean(marketing?.marketing_status))) {
        skipReason = "Keine SMS-Marketingberechtigung dokumentiert.";
      } else if (channel?.state === "blocked" || channel?.opted_out_at) {
        skipReason = channel?.failure_reason || "SMS-Abmeldung oder Sperre.";
      } else if (["invalid", "unavailable"].includes(clean(channel?.state))) {
        skipReason = channel?.failure_reason || "SMS-Kanal nicht verfügbar.";
      }

      if (skipReason) {
        skipped++;
        await admin.from("campaign_recipients").update({
          state: channel?.state === "blocked" || channel?.opted_out_at ? "opted_out" : "skipped",
          provider: "twilio",
          recipient_address: phone || null,
          failure_reason: skipReason,
          failure_code: "sms_not_eligible",
          status_updated_at: new Date().toISOString(),
        }).eq("id", recipient.id);
        continue;
      }

      const message = withOptOut(personalize(clean(campaign.sms_text), contact));
      const callbackUrl = new URL(WEBHOOK_URL);
      callbackUrl.searchParams.set("recipient_id", recipient.id);
      const form = new URLSearchParams({
        To: phone,
        MessagingServiceSid: MESSAGING_SERVICE_SID,
        Body: message,
        StatusCallback: callbackUrl.toString(),
        SmartEncoded: "true",
        ValidityPeriod: "3600",
      });

      const result = await twilioSend(ACCOUNT_SID, AUTH_TOKEN, form);
      if (!result.ok) {
        failed++;
        await admin.from("campaign_recipients").update({
          state: "failed",
          provider: "twilio",
          recipient_address: phone,
          failure_reason: clean(result.data?.message) || `Twilio HTTP ${result.status}`,
          failure_code: clean(result.data?.code) || "twilio_api",
          provider_event_type: "api.failed",
          last_event_at: new Date().toISOString(),
          status_updated_at: new Date().toISOString(),
        }).eq("id", recipient.id);
        continue;
      }

      sent++;
      const initialStatus = ["sent", "delivered"].includes(clean(result.data?.status))
        ? clean(result.data.status)
        : "queued";
      await admin.from("campaign_recipients").update({
        state: initialStatus,
        provider: "twilio",
        provider_message_id: clean(result.data?.sid),
        recipient_address: phone,
        failure_reason: null,
        failure_code: null,
        provider_event_type: `api.${clean(result.data?.status) || "accepted"}`,
        sent_at: initialStatus === "sent" ? new Date().toISOString() : null,
        delivered_at: initialStatus === "delivered" ? new Date().toISOString() : null,
        last_event_at: new Date().toISOString(),
        status_updated_at: new Date().toISOString(),
      })
        .eq("id", recipient.id)
        .in("state", ["planned", "queued"]);
    }

    const { count: remaining } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("assigned_channel", "sms")
      .eq("state", "planned");
    const completed = !remaining;
    await admin.from("campaigns").update({
      sms_send_status: completed ? "completed" : "sending",
      sms_last_error: failed ? `${failed} SMS im letzten Stapel fehlgeschlagen` : null,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);

    return json({
      ok: true,
      campaign_id: campaignId,
      sent_count: sent,
      failed_count: failed,
      skipped_count: skipped,
      remaining: remaining || 0,
      completed,
    });
  } catch (error) {
    return json({
      ok: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

