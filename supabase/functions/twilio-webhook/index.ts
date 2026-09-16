import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import twilio from "npm:twilio@5.10.4";

const clean = (value: unknown) => String(value ?? "").trim();
const xmlResponse = (body = "<Response></Response>", status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return xmlResponse("<Response></Response>", 405);

    const authToken = clean(Deno.env.get("TWILIO_AUTH_TOKEN"));
    const configuredUrl = clean(Deno.env.get("TWILIO_WEBHOOK_URL"));
    if (!authToken || !configuredUrl) throw new Error("Twilio-Webhook-Secrets fehlen.");

    const raw = await req.text();
    const search = new URLSearchParams(raw);
    const params: Record<string, string> = {};
    for (const [key, value] of search.entries()) params[key] = value;

    const requestUrl = new URL(req.url);
    const publicUrl = new URL(configuredUrl);
    publicUrl.search = requestUrl.search;
    const signature = req.headers.get("x-twilio-signature") || "";
    if (!signature || !twilio.validateRequest(authToken, signature, publicUrl.toString(), params)) {
      return xmlResponse("<Response></Response>", 403);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const messageSid = clean(params.MessageSid || params.SmsSid);
    const messageStatus = clean(params.MessageStatus || params.SmsStatus).toLowerCase();
    const optOutType = clean(params.OptOutType).toUpperCase();
    const bodyCommand = clean(params.Body)
      .toUpperCase()
      .replace(/\s+/g, " ")
      .replace(/[.!]+$/g, "")
      .trim();
    const stopByBody = /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|ABMELDUNG:\s*STOP)$/.test(bodyCommand);
    const startByBody = /^(START|UNSTOP)$/.test(bodyCommand);
    const effectiveOptOutType = ["STOP", "START"].includes(optOutType)
      ? optOutType
      : stopByBody
        ? "STOP"
        : startByBody
          ? "START"
          : "";
    const from = clean(params.From);
    const recipientId = clean(requestUrl.searchParams.get("recipient_id"));
    const eventType = effectiveOptOutType
      ? `optout.${effectiveOptOutType.toLowerCase()}`
      : `status.${messageStatus || "unknown"}`;
    const eventId = await sha256(publicUrl.toString() + "\n" + raw);
    const now = new Date().toISOString();
    const payload = Object.fromEntries(search.entries());

    const { error: insertError } = await admin.from("twilio_webhook_events").insert({
      event_id: eventId,
      event_type: eventType,
      message_sid: messageSid || null,
      payload,
    });
    if (insertError?.code === "23505") return xmlResponse();
    if (insertError) throw insertError;

    let contacts: any[] = [];
    if (from) {
      const { data } = await admin.from("contacts")
        .select("id")
        .eq("phone_mobile_e164", from)
        .limit(1000);
      contacts = data || [];
    }
    const contact = contacts[0] || null;
    const contactIds = contacts.map((row: any) => row.id);

    if (contactIds.length && effectiveOptOutType === "STOP") {
      await admin.from("contact_channels").upsert(contactIds.map((contactId: number) => ({
        contact_id: contactId,
        channel: "sms",
        state: "blocked",
        opted_out_at: now,
        last_failure_at: now,
        failure_reason: "SMS-Abmeldung mit STOP über Twilio",
      })), { onConflict: "contact_id,channel" });
      await admin.from("campaign_recipients").update({
        state: "opted_out",
        failure_reason: "SMS-Abmeldung mit STOP über Twilio",
        failure_code: "stop",
        provider_event_type: eventType,
        last_event_at: now,
        status_updated_at: now,
      }).in("contact_id", contactIds).eq("assigned_channel", "sms").eq("state", "planned");
      const { data: latest } = await admin.from("campaign_recipients")
        .select("id")
        .eq("assigned_channel", "sms")
        .eq("recipient_address", from)
        .in("state", ["queued", "sent", "delivered", "failed", "opted_out"])
        .order("sent_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest?.id) await admin.from("campaign_recipients").update({
        opted_out_at: now,
        opt_out_source: "Twilio STOP",
      }).eq("id", latest.id).is("opted_out_at", null);
    } else if (contactIds.length && effectiveOptOutType === "START") {
      await admin.from("contact_channels").upsert(contactIds.map((contactId: number) => ({
        contact_id: contactId,
        channel: "sms",
        state: "available",
        consent_source: "Twilio START",
        consent_at: now,
        opted_out_at: null,
        failure_reason: null,
      })), { onConflict: "contact_id,channel" });
      await admin.from("contact_marketing").upsert(contactIds.map((contactId: number) => ({
        contact_id: contactId,
        marketing_status: "consent",
        block_all: false,
        note: "SMS-Einwilligung mit START über Twilio",
        updated_at: now,
      })), { onConflict: "contact_id" });
    }

    let recipient: any = null;
    if (recipientId) {
      const { data } = await admin.from("campaign_recipients")
        .select("id,campaign_id,contact_id,state")
        .eq("id", recipientId)
        .maybeSingle();
      recipient = data;
    }
    if (!recipient && messageSid) {
      const { data } = await admin.from("campaign_recipients")
        .select("id,campaign_id,contact_id,state")
        .eq("provider_message_id", messageSid)
        .limit(1)
        .maybeSingle();
      recipient = data;
    }

    const statusMap: Record<string, string> = {
      accepted: "queued",
      queued: "queued",
      sending: "queued",
      sent: "sent",
      delivered: "delivered",
      failed: "failed",
      undelivered: "failed",
      canceled: "failed",
    };
    const mappedState = statusMap[messageStatus];
    if (recipient && mappedState) {
      const errorCode = clean(params.ErrorCode);
      const update: Record<string, unknown> = {
        state: mappedState,
        provider: "twilio",
        provider_message_id: messageSid || null,
        provider_event_type: eventType,
        failure_code: errorCode || null,
        failure_reason: ["failed", "undelivered", "canceled"].includes(messageStatus)
          ? `Twilio-Status ${messageStatus}${errorCode ? " (" + errorCode + ")" : ""}`
          : null,
        last_event_at: now,
        status_updated_at: now,
      };
      if (messageStatus === "sent") update.sent_at = now;
      if (messageStatus === "delivered") {
        update.sent_at = now;
        update.delivered_at = now;
      }
      // Twilio callbacks can arrive out of lifecycle order. Never downgrade a recipient status.
      const allowedCurrentStates: Record<string, string[]> = {
        queued: ["planned", "queued"],
        sent: ["planned", "queued", "sent"],
        delivered: ["planned", "queued", "sent", "delivered"],
        failed: ["planned", "queued", "sent", "failed"],
      };
      const { data: updatedRows, error: updateError } = await admin
        .from("campaign_recipients")
        .update(update)
        .eq("id", recipient.id)
        .in("state", allowedCurrentStates[mappedState] || [])
        .select("id");
      if (updateError) throw updateError;
      const statusAdvanced = (updatedRows || []).length > 0;

      if (statusAdvanced && messageStatus === "delivered") {
        await admin.from("contact_channels").upsert({
          contact_id: recipient.contact_id,
          channel: "sms",
          state: "available",
          last_success_at: now,
          failure_reason: null,
        }, { onConflict: "contact_id,channel" });
      } else if (statusAdvanced && ["failed", "undelivered"].includes(messageStatus)) {
        if (errorCode === "21610") {
          await admin.from("contact_channels").upsert({
            contact_id: recipient.contact_id,
            channel: "sms",
            state: "blocked",
            opted_out_at: now,
            last_failure_at: now,
            failure_reason: "Twilio STOP-Sperre (21610)",
          }, { onConflict: "contact_id,channel" });
          await admin.from("campaign_recipients").update({
            opted_out_at: now,
            opt_out_source: "Twilio 21610",
          }).eq("id", recipient.id).is("opted_out_at", null);
        } else {
          const invalid = ["21211", "21614"].includes(errorCode);
          const row: Record<string, unknown> = {
            contact_id: recipient.contact_id,
            channel: "sms",
            last_failure_at: now,
            failure_reason: `Twilio ${messageStatus}${errorCode ? " (" + errorCode + ")" : ""}`,
          };
          if (invalid) row.state = "invalid";
          await admin.from("contact_channels").upsert(row, { onConflict: "contact_id,channel" });
        }
      }

      const { data: smsRows } = await admin.from("campaign_recipients")
        .select("state")
        .eq("campaign_id", recipient.campaign_id)
        .eq("assigned_channel", "sms");
      const terminal = (state: string) => ["delivered", "failed", "skipped", "opted_out"].includes(state);
      const smsComplete = (smsRows || []).length > 0 && (smsRows || []).every((row: any) => terminal(row.state));

      const { data: digitalRows } = await admin.from("campaign_recipients")
        .select("state,assigned_channel")
        .eq("campaign_id", recipient.campaign_id)
        .in("assigned_channel", ["email", "whatsapp", "sms"]);
      const allDigitalComplete = (digitalRows || []).length > 0 &&
        (digitalRows || []).every((row: any) => terminal(row.state));

      await admin.from("campaigns").update({
        sms_send_status: smsComplete ? "completed" : "sending",
        state: allDigitalComplete ? "completed" : "sending",
        updated_at: now,
      }).eq("id", recipient.campaign_id);
    }

    await admin.from("twilio_webhook_events").update({ processed_at: now }).eq("event_id", eventId);
    return xmlResponse();
  } catch (error) {
    console.error(error);
    return xmlResponse("<Response></Response>", 500);
  }
});
