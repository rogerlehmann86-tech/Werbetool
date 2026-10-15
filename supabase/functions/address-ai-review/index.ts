const corsHeaders = {
  "Access-Control-Allow-Origin": "https://rogerlehmann86-tech.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST erforderlich." }, 405);
  if (!req.headers.get("authorization")) return json({ error: "Anmeldung erforderlich." }, 401);
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "Die KI-Auswertung ist noch nicht aktiviert. Im Supabase-Projekt fehlt das Secret OPENAI_API_KEY." }, 200);
  try {
    const body = await req.json();
    const input = body?.summary;
    if (!input || typeof input !== "object" || !Number.isFinite(input.total)) return json({ error: "Keine gültige Adresszusammenfassung übergeben." }, 400);
    if (!Array.isArray(input.cities) || input.cities.length > 150) return json({ error: "Bitte höchstens 150 Ortsgruppen übermitteln." }, 413);
    const safeNumber = (value: unknown, max = 1000000) =>
      Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(Number(value) * 10) / 10)) : 0;
    const rawCounts = input.counts && typeof input.counts === "object" ? input.counts : {};
    const summary = {
      total: safeNumber(input.total),
      radiusKm: safeNumber(input.radiusKm, 1000),
      counts: {
        total: safeNumber(rawCounts.total),
        complete: safeNumber(rawCounts.complete),
        matched: safeNumber(rawCounts.matched),
        inside: safeNumber(rawCounts.inside),
        outside: safeNumber(rawCounts.outside),
        notFound: safeNumber(rawCounts.notFound),
        incomplete: safeNumber(rawCounts.incomplete)
      },
      cities: input.cities.map((city: any) => ({
        place: String(city?.place || "").trim().slice(0, 80),
        count: safeNumber(city?.count),
        inside: safeNumber(city?.inside),
        outside: safeNumber(city?.outside),
        averageDistanceKm: safeNumber(city?.averageDistanceKm, 2500)
      }))
    };
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini",
        store: false,
        instructions: "Du analysierst ausschliesslich die übermittelten, aggregierten geografischen Kampagnendaten. Keine individuellen Kundendaten wurden übermittelt. Erfinde keine Fakten und ändere keine Zahlen. Schreibe knapp auf Deutsch. Erkläre die geografische Verteilung, hebe auffällige Orte oder Ausreisser ausserhalb des Radius hervor und gib höchstens drei konkrete Segmentierungsvorschläge. Die Entfernung ist Luftlinie, keine Fahrdistanz. Wenn wenige oder unvollständige Daten vorliegen, sage das klar.",
        input: JSON.stringify(summary),
        text: {
          format: {
            type: "json_schema",
            name: "address_quality_analysis",
            strict: true,
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                findings: { type: "array", items: { type: "string" } },
                suggestions: { type: "array", items: { type: "string" } },
                limitations: { type: "string" }
              },
              required: ["summary", "findings", "suggestions", "limitations"],
              additionalProperties: false
            }
          }
        }
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const detail = await response.text();
      return json({ error: "OpenAI-Auswertung fehlgeschlagen (" + response.status + ").", detail: detail.slice(0, 500) }, 502);
    }
    const data = await response.json();
    const text = (data.output || []).flatMap((item: any) => item.content || []).find((part: any) => part.type === "output_text")?.text;
    if (!text) return json({ error: "Die KI hat keine auswertbare Antwort geliefert." }, 502);
    return json({ analysis: JSON.parse(text) });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, 500);
  }
});