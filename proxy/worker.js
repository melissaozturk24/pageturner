// Pageturner proxy: forwards Gemini requests so the API key stays server-side.
const ALLOWED_ORIGIN = 'https://melissaozturk24.github.io';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';
const MAX_BODY_BYTES = 64 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

    let upstream;
    try {
      upstream = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(forward),
      });
    } catch {
      return json({ error: { message: 'Could not reach Gemini' } }, 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
