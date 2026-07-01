/**
 * GET /api/latest
 *
 * Serveert de kant-en-klare JSON die de cron-worker elke 10 minuten
 * in KV zet. Geen live fetch, geen Gemini-call hier — puur uitlezen.
 *
 * Vereist: dezelfde KV-namespace gebonden aan dit Pages-project onder
 * de naam BRIEFING_KV (Pages dashboard > Settings > Functions > KV bindings).
 */
export async function onRequestGet(context) {
  const data = await context.env.BRIEFING_KV.get('latest', 'json');

  if (!data) {
    return new Response(JSON.stringify({ error: 'Nog geen data — eerste cyclus moet nog draaien' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60', // korte cache, want elke 10 min ververst de bron toch
    },
  });
}
