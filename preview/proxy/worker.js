// Pageturner proxy: forwards Gemini requests so the API key stays server-side.
const ALLOWED_ORIGIN = 'https://melissaozturk24.github.io';

// Models are tried in this order until one gives a usable answer. Order and limits come from
// timing the app's real requests (Nov 2026):
// - Flash-Lite models answer in about 2.5-4.5s and have a much larger free-tier quota.
//   3.5 Flash-Lite was the most consistent; 3.1 Flash-Lite sometimes stalls for 25-60s,
//   so each attempt is capped.
// - Full Flash models take 20-45s (they "think" first) and the free tier allows only
//   20 requests a day each, so they are a last resort. When out of quota they answer
//   429 within about 0.2s, so trying them costs almost nothing.
const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', timeoutMs: 12000 },
  { id: 'gemini-3.1-flash-lite', timeoutMs: 12000 },
  { id: 'gemini-3.6-flash', timeoutMs: 25000 },
  { id: 'gemini-3.8-flash', timeoutMs: 25000 },
  { id: 'gemini-3.7-flash', timeoutMs: 25000 },
  { id: 'gemini-3.5-flash', timeoutMs: 25000 },
];
// Whole request must finish well under Cloudflare's 100s limit (error 524). The app gives up at 60s.
const TOTAL_BUDGET_MS = 50000;
// Do not start a new attempt with less time than this left.
const MIN_ATTEMPT_MS = 3000;
// Statuses that mean "try the next model": not found for this key, quota/rate limit, server busy or down.
const RETRY_STATUSES = [404, 429, 500, 502, 503, 504];
const geminiUrl = model => 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
const MAX_BODY_BYTES = 64 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-Gemini-Model, X-Gemini-Attempts',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
  });
}

// The app always asks for a JSON array. A 200 reply whose text is empty or not JSON is
// treated like a failure so the next model gets a chance.
function hasUsableAnswer(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) return false;
  text = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  try { JSON.parse(text); return true; } catch {}
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s === -1 || e <= s) return false;
  try { JSON.parse(text.substring(s, e + 1)); return true; } catch { return false; }
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, 405);
  }
  // Browsers always send Origin on cross-site POSTs; this blocks other websites
  // from using the proxy (it does not stop scripts that fake the header).
  if (request.headers.get('Origin') !== ALLOWED_ORIGIN) {
    return json({ error: { code: 'origin_not_allowed', message: 'Origin not allowed' } }, 403);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: { code: 'not_configured', message: 'Proxy is missing its GEMINI_API_KEY secret' } }, 500);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: { code: 'too_large', message: 'Request too large' } }, 413);
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    return json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400);
  }
  // Forward only the fields the app uses.
  const payload = JSON.stringify({
    contents: body.contents,
    systemInstruction: body.systemInstruction,
    generationConfig: body.generationConfig,
  });

  const started = Date.now();
  const attempts = []; // "model:outcome:ms", returned in X-Gemini-Attempts for debugging
  let lastError = null;
  for (const { id, timeoutMs } of GEMINI_MODELS) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < MIN_ATTEMPT_MS) break;
    const limit = Math.min(timeoutMs, left);
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
    let status, text;
    try {
      const res = await fetch(geminiUrl(id), {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY.trim() },
        body: payload,
      });
      status = res.status;
      text = await res.text(); // still covered by the timer
    } catch (e) {
      attempts.push(id + ':' + (e && e.name === 'AbortError' ? 'timeout' : 'network') + ':' + (Date.now() - t0));
      lastError = e && e.name === 'AbortError' ? 'timeout' : 'network';
      continue;
    } finally {
      clearTimeout(timer);
    }
    attempts.push(id + ':' + status + ':' + (Date.now() - t0));
    if (RETRY_STATUSES.includes(status)) { lastError = status === 429 ? 'quota' : 'busy'; continue; }
    if (status !== 200) {
      // A request Gemini itself rejects (e.g. 400) will not get better on another model.
      return json({ error: { code: 'upstream_error', message: 'The recommendation service rejected the request (' + status + ')' } }, 502,
        { 'X-Gemini-Model': id, 'X-Gemini-Attempts': attempts.join(',') });
    }
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || !hasUsableAnswer(data)) {
      attempts[attempts.length - 1] = id + ':bad_output:' + (Date.now() - t0);
      lastError = 'bad_output';
      continue;
    }
    return new Response(text, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Gemini-Model': id, 'X-Gemini-Attempts': attempts.join(',') },
    });
  }
  return json({
    error: {
      code: 'busy',
      reason: lastError || 'timeout',
      message: 'All recommendation models are busy or too slow right now. Please try again.',
    },
  }, 503, { 'X-Gemini-Model': 'none', 'X-Gemini-Attempts': attempts.join(',') });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      // Never let an unexpected error turn into a Cloudflare error page without CORS headers.
      return json({ error: { code: 'internal', message: 'Unexpected proxy error' } }, 500);
    }
  },
};
