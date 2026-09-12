import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Webhook } from "npm:svix@1.76.1";

const clean = (value: unknown) => String(value ?? "").trim();
function bounceInfo(data: any) {
  const bounce = data?.bounce || {};
  const code = clean(bounce.type || bounce.subType || bounce.subtype || bounce.code);
  const reason = clean(bounce.message || bounce.diagnostic_code || bounce.diagnosticCode) || "Bounce";
  const type = code.toLowerCase();
  return { code: code || "bounce", reason, hard: type.includes("hard") || type.includes("permanent") };
}

Deno.serve(async (req) => {
  try {
    const raw = await req.text();
    const webhook = new Webhook(Deno.env.get("RESEND_WEBHOOK_SECRET")!);
    const event: any = webhook.verify(raw, {
      "svix-id": req.headers.get("svix-id") || "",
      "svix-timestamp": req.headers.get("svix-timestamp") || "",
      "svix-signature": req.headers.get("svix-signature") || "",
    });
    const eventId = req.headers.get("svix-id") || crypto.randomUUID();
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: insertError } = await admin.from("resend_webhook_events").insert({ event_id: eventId, event_type: event.type, payload: event });
    if (insertError?.code === "23505") return Response.json({ ok: true, duplicate: true });
    if (insertError) throw insertError;

    const data = event.data || {};
    const email = clean((Array.isArray(data.to) ? data.to[0] : data.email)).toLowerCase();
    const broadcastId = data.broadcast_id || null;
    const now = event.created_at || new Date().toISOString();
    let campaign: any = null;
    if (broadcastId) {
      const result = await admin.from("campaigns").select("id").eq("resend_broadcast_id", broadcastId).maybeSingle();
      campaign = result.data;
    }
    let contacts: any[] = [];
    if (email) {
      const [company, privateEmail] = await Promise.all([
        admin.from("contacts").select("id").ilike("email_company", email).limit(1000),
        admin.from("contacts").select("id").ilike("email_private", email).limit(1000),
      ]);
      contacts = [...(company.data || []), ...(privateEmail.data || [])]
        .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index);
    }
    const contact = contacts[0] || null;
    const contactIds = contacts.map((row: any) => row.id);

    let state: string | null = null;
    const extra: any = { provider: "resend", provider_event_type: event.type, last_event_at: now, status_updated_at: now };
    if (data.email_id) extra.provider_message_id = data.email_id;
    if (email) extra.recipient_address = email;
    if (event.type === "email.sent") { state = "sent"; extra.sent_at = now; extra.failure_reason = null; extra.failure_code = null; }
    else if (event.type === "email.delivered") { state = "delivered"; extra.delivered_at = now; extra.failure_reason = null; extra.failure_code = null; }
    else if (event.type === "email.bounced") { const bounce = bounceInfo(data); state = "failed"; extra.failure_reason = bounce.reason; extra.failure_code = bounce.code; }
    else if (event.type === "email.failed") { state = "failed"; extra.failure_reason = clean(data.failed?.reason) || "Versand fehlgeschlagen"; extra.failure_code = clean(data.failed?.code) || "failed"; }
    else if (event.type === "email.suppressed") { state = "failed"; extra.failure_reason = "Von Resend unterdrückt"; extra.failure_code = "suppressed"; }
    else if (event.type === "email.complained") { state = "opted_out"; extra.failure_reason = "Als Spam gemeldet"; extra.failure_code = "complained"; extra.opted_out_at = now; extra.opt_out_source = "Resend Spam-Beschwerde"; }
    if (campaign?.id && contact?.id && state) {
      await admin.from("campaign_recipients").update({ state, ...extra })
        .eq("campaign_id", campaign.id).eq("contact_id", contact.id).eq("assigned_channel", "email");
    }

    if (contact?.id) {
      if (event.type === "email.delivered") await admin.from("contact_channels").upsert({ contact_id: contact.id, channel: "email", state: "available", last_success_at: now, failure_reason: null }, { onConflict: "contact_id,channel" });
      if (event.type === "email.bounced") {
        const bounce = bounceInfo(data);
        const row: any = { contact_id: contact.id, channel: "email", last_failure_at: now, failure_reason: bounce.reason };
        if (bounce.hard) row.state = "invalid";
        await admin.from("contact_channels").upsert(row, { onConflict: "contact_id,channel" });
      }
      if (["email.failed", "email.suppressed"].includes(event.type)) await admin.from("contact_channels").upsert({ contact_id: contact.id, channel: "email", state: "invalid", last_failure_at: now, failure_reason: clean(data.failed?.reason) || "Resend Fehler" }, { onConflict: "contact_id,channel" });
    }
    if (contactIds.length && event.type === "email.complained") {
      await admin.from("contact_channels").upsert(contactIds.map((contactId: number) => ({ contact_id: contactId, channel: "email", state: "blocked", opted_out_at: now, last_failure_at: now, failure_reason: "Spam-Beschwerde" })), { onConflict: "contact_id,channel" });
    }

    if (event.type === "contact.updated" && email && data.unsubscribed === true) {
      if (contactIds.length) {
        await admin.from("contact_channels").upsert(contactIds.map((contactId: number) => ({ contact_id: contactId, channel: "email", state: "blocked", opted_out_at: now, failure_reason: "Abmeldung über Resend" })), { onConflict: "contact_id,channel" });
        await admin.from("campaign_recipients").update({ state: "opted_out", failure_reason: "Abmeldung über Resend", failure_code: "unsubscribe", provider_event_type: event.type, last_event_at: now, status_updated_at: now })
          .in("contact_id", contactIds).eq("assigned_channel", "email").eq("state", "planned");
      }
      const latestResult = await admin.from("campaign_recipients").select("id")
        .eq("assigned_channel", "email").ilike("recipient_address", email)
        .in("state", ["queued", "sent", "delivered", "failed", "opted_out"])
        .order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (latestResult.data?.id) await admin.from("campaign_recipients").update({ opted_out_at: now, opt_out_source: "Resend Abmeldelink" }).eq("id", latestResult.data.id).is("opted_out_at", null);
    }

    if (campaign?.id) {
      const { data: rows } = await admin.from("campaign_recipients").select("state,assigned_channel").eq("campaign_id", campaign.id).in("assigned_channel", ["email", "whatsapp", "sms"]);
      const all = rows || [], terminal = (value: string) => ["delivered", "read", "failed", "skipped", "opted_out"].includes(value);
      const emailRows = all.filter((row: any) => row.assigned_channel === "email"), waRows = all.filter((row: any) => row.assigned_channel === "whatsapp"), smsRows = all.filter((row: any) => row.assigned_channel === "sms");
      const emailDone = emailRows.length > 0 && emailRows.every((row: any) => terminal(row.state));
      const waDone = waRows.length === 0 || waRows.every((row: any) => terminal(row.state));
      const smsDone = smsRows.length === 0 || smsRows.every((row: any) => terminal(row.state));
      await admin.from("campaigns").update({ email_send_status: emailDone ? "completed" : "sending", state: emailDone && waDone && smsDone ? "completed" : "sending", updated_at: new Date().toISOString() }).eq("id", campaign.id);
    }
    await admin.from("resend_webhook_events").update({ processed_at: new Date().toISOString() }).eq("event_id", eventId);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
});
