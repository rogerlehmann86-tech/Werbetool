const corsHeaders = {
  "Access-Control-Allow-Origin": "https://rogerlehmann86-tech.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST erforderlich." }, 405);
  if (!req.headers.get("authorization")) return json({ error: "Anmeldung erforderlich." }, 401);
  try {
    const body = await req.json();
    if (body.action !== "geocode" || !Array.isArray(body.addresses)) return json({ error: "Ungültige Anfrage." }, 400);
    if (body.addresses.length > 20) return json({ error: "Maximal 20 Adressen pro Anfrage." }, 413);
    const results = [];
    for (let i = 0; i < body.addresses.length; i++) {
      if (i) await pause(250);
      const item = body.addresses[i] || {};
      const address = String(item.address || "").trim();
      if (!address || !String(item.id || "")) {
        results.push({ id: item.id, status: "incomplete", latitude: null, longitude: null, label: "" });
        continue;
      }
      try {
        const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
        url.searchParams.set("type", "locations");
        url.searchParams.set("origins", "address");
        url.searchParams.set("searchText", address);
        url.searchParams.set("lang", "de");
        const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error("swisstopo antwortete mit " + response.status);
        const payload = await response.json();
        const attrs = payload?.results?.[0]?.attrs;
        const latitude = Number(attrs?.lat), longitude = Number(attrs?.lon);
        if (attrs?.origin === "address" && Number.isFinite(latitude) && Number.isFinite(longitude)) {
          results.push({ id: String(item.id), status: "matched", latitude, longitude, label: String(attrs.label || attrs.detail || "") });
        } else {
          results.push({ id: String(item.id), status: "not_found", latitude: null, longitude: null, label: "" });
        }
      } catch (error) {
        results.push({ id: String(item.id), status: "error", latitude: null, longitude: null, label: String((error as Error)?.message || error) });
      }
    }
    return json({ results });
  } catch {
    return json({ error: "Die Anfrage konnte nicht verarbeitet werden." }, 400);
  }
});