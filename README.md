# Lehmann Werbetool v0.7 – WhatsApp Cloud API

Basis: v0.6.5 (E-Mail/Resend stabil) plus WhatsApp über die direkte Meta WhatsApp Cloud API.

## Neu
- WhatsApp-Versand aus gespeicherten Kampagnen.
- Von Meta freigegebene WhatsApp-Templates mit Template-Name, Sprache und optionalen Body-Parametern.
- Versand in Batches, damit grössere Empfängerlisten nicht in einem einzigen Edge-Function-Aufruf verarbeitet werden müssen.
- Zustellstatus: geplant, Warteschlange, gesendet, zugestellt, gelesen, fehlgeschlagen, abgemeldet.
- Eigener WhatsApp-Statuscontainer und Empfängerhistorie.
- WhatsApp-Opt-out wird dauerhaft in `contact_channels` gespeichert, wenn der Empfänger exakt `STOP`, `STOPP`, `ABMELDEN`, `ABMELDUNG`, `UNSUBSCRIBE`, `KEINE WERBUNG` oder `WERBUNG ABBESTELLEN` antwortet bzw. einen entsprechend benannten Quick-Reply-Button verwendet.
- Kontakte mit WhatsApp-Opt-out/ungültigem WhatsApp-Kanal bleiben sichtbar und werden für WhatsApp nicht mehr verwendet.
- E-Mail-Webhook aktualisiert den Gesamtstatus nun zusammen mit WhatsApp, damit eine Kampagne nicht zu früh als abgeschlossen erscheint.

## 1. SQL
Einmal ausführen:
`supabase_v0.7_whatsapp.sql`

## 2. Supabase Edge Function Secrets
Nicht im Browser/HTML speichern und nicht im Chat teilen:
- `WHATSAPP_ACCESS_TOKEN` – Meta WhatsApp Cloud API Access Token
- `WHATSAPP_PHONE_NUMBER_ID` – Phone Number ID aus Meta
- `WHATSAPP_GRAPH_VERSION` – aktuelle Graph-API-Version aus Meta, z. B. `vXX.X`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` – frei gewählter langer Prüfwert; derselbe Wert wird beim Meta-Webhook eingetragen
- `WHATSAPP_APP_SECRET` – App Secret der Meta-App; wird zur Signaturprüfung der Webhooks verwendet

Die normalen Supabase-Umgebungsvariablen `SUPABASE_URL`, `SUPABASE_ANON_KEY` und `SUPABASE_SERVICE_ROLE_KEY` stellt Supabase der Edge Function zur Verfügung.

## 3. Edge Functions
Deployen:
- `whatsapp-send-campaign` – JWT-Prüfung EIN
- `whatsapp-webhook` – JWT-Prüfung AUS
- `resend-webhook` – bestehende Function durch die v0.7-Datei ersetzen; JWT-Prüfung weiterhin AUS

Webhook-URL für Meta:
`https://mvjlmubyyfckzxepixil.supabase.co/functions/v1/whatsapp-webhook`

In Meta beim Webhook mindestens das Feld `messages` abonnieren. Der Verify Token muss mit `WHATSAPP_WEBHOOK_VERIFY_TOKEN` identisch sein.

## 4. WhatsApp Template
Unter WhatsApp Manager ein Template erstellen und freigeben lassen. Für Werbeaktionen wird typischerweise die Kategorie MARKETING verwendet.

Im Werbetool pro Kampagne eintragen:
- Template-Name: exakt wie in Meta, z. B. `fruehlingsaktion_2026`
- Sprache: exakt wie im freigegebenen Template, z. B. `de` oder der von Meta angezeigte Sprachcode
- Template-Parameter: nur wenn das Template Body-Variablen enthält. Beispiel: `vorname,firma` bedeutet `{{1}} = Vorname`, `{{2}} = Firma`.

Unterstützte Parameter-Schlüssel:
- `vorname`
- `nachname`
- `firma`
- `ort`
- `plz`

Hat das Template keine Body-Variablen, Feld leer lassen.

Der Text im Feld „WhatsApp“ ist in v0.7 nur eine interne Vorschau/Notiz. Ausserhalb eines laufenden Kundenservice-Fensters wird nicht beliebiger Freitext verschickt, sondern das freigegebene Meta-Template.

### Empfehlung für Abmeldung
Dem Marketing-Template einen Quick-Reply-Button `Abmelden` hinzufügen. Die v0.7-Webhook-Function erkennt diesen und sperrt den WhatsApp-Kanal des Kontakts dauerhaft.

## 5. Erster Test
1. `index.html` öffnen und anmelden.
2. Eine Testkampagne mit genau einer eigenen Mobilnummer erstellen.
3. WhatsApp als Zuweisung prüfen.
4. Freigegebenen Template-Namen/Sprache eintragen.
5. Kampagne speichern.
6. Im WhatsApp-Status muss `Geplant: 1` erscheinen.
7. Versandprüfung bestätigen und `WhatsApp senden` klicken.
8. Status sollte über Webhook von Warteschlange -> Gesendet -> Zugestellt -> Gelesen wechseln.
9. Danach mit `Abmelden` antworten und prüfen, ob der Kontakt in einer neuen Kampagne nicht mehr WhatsApp zugewiesen bekommt.

## Sicherheit
- Zugangstoken und App Secret nie in `index.html` eintragen.
- `whatsapp-send-campaign`: JWT EIN.
- `whatsapp-webhook`: JWT AUS, weil Meta den Endpoint direkt aufruft; die Function prüft Verify Token und `X-Hub-Signature-256` mit dem App Secret.
