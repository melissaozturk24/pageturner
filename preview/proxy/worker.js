// Pageturner proxy: forwards Gemini requests so the API key stays server-side.
const ALLOWED_ORIGIN = 'https://melissaozturk24.github.io';
// Stable Flash models, newest first, ending with a Flash-Lite model. If one is
// overloaded (503), rate-limited (429) or unavailable to this key (404), the next is tried.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const RETRY_STATUSES = [404, 429, 503];
const geminiUrl = model => 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
const MAX_BODY_BYTES = 64 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Test-Models',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'Method not allowed' } }, 405);
    }
    // Browsers always send Origin on cross-site POSTs; this blocks other websites
    // from using the proxy (it does not stop scripts that fake the header).
    if (request.headers.get('Origin') !== ALLOWED_ORIGIN) {
      return json({ error: { message: 'Origin not allowed' } }, 403);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: { message: 'Proxy is missing its GEMINI_API_KEY secret' } }, 500);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: { message: 'Request too large' } }, 413);
    }
    let body;
    try { body = JSON.parse(raw); } catch {
      return json({ error: { message: 'Body must be JSON' } }, 400);
    }
    // Forward only the fields the app uses.
    const forward = {
      contents: body.contents,
      systemInstruction: body.systemInstruction,
      generationConfig: body.generationConfig,
    };

    const payload = JSON.stringify(forward);
    // TEMPORARY (measurement build): force a model order with X-Test-Models, report every attempt.
    const ALL = ['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite'];
    const forced = (request.headers.get('X-Test-Models') || '').split(',').map(x => x.trim()).filter(x => ALL.includes(x));
    const order = forced.length ? forced : GEMINI_MODELS;
    const attempts = [];
    let upstream = null, usedModel = '';
    for (const model of order) {
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      try {
        upstream = await fetch(geminiUrl(model), {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY.trim() },
          body: payload,
        });
        const text = await upstream.text();
        clearTimeout(timer);
        attempts.push(model + ':' + upstream.status + ':' + (Date.now() - t0));
        upstream = { status: upstream.status, text };
      } catch (e) {
        clearTimeout(timer);
        attempts.push(model + ':' + (e.name === 'AbortError' ? 'timeout' : 'neterr') + ':' + (Date.now() - t0));
        upstream = null; continue;
      }
      if (!RETRY_STATUSES.includes(upstream.status)) { usedModel = model; break; }
    }
    const hdr = { ...corsHeaders, 'Content-Type': 'application/json', 'X-Gemini-Model': usedModel || 'none', 'X-Gemini-Attempts': attempts.join(','), 'Access-Control-Expose-Headers': 'X-Gemini-Model, X-Gemini-Attempts' };
    if (!upstream) return new Response(JSON.stringify({ error: { message: 'Could not reach Gemini' } }), { status: 502, headers: hdr });
    return new Response(upstream.text, { status: upstream.status, headers: hdr });
  },
};
