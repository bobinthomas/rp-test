// Cloudflare Worker: serves the static app (public/) and implements the same
// "relay" contract as relay/server.js — forward LLM calls untouched, no state,
// no logging of bodies/keys. The one addition vs. the local relay: a host
// allowlist, because this version is reachable from the public internet and
// an unrestricted pass-through proxy (any baseUrl/headers/body) is an open
// relay / SSRF vector once it's not just bound to localhost.
const ALLOWED_HOSTS = new Set([
  "api.moonshot.ai", // Moonshot — international
  "api.moonshot.cn", // Moonshot — China
  "api.groq.com", // Groq
  "api.openai.com", // OpenAI
  "api.tokenrouter.com", // TokenRouter
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleRelay(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return new Response("not found", { status: 404 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: { message: "relay: invalid JSON body" } }, 400);
  }

  const { baseUrl, path, headers, body } = payload || {};
  let baseParsed;
  try {
    baseParsed = new URL(baseUrl);
  } catch {
    return json({ error: { message: "relay: invalid baseUrl" } }, 400);
  }

  if (!ALLOWED_HOSTS.has(baseParsed.hostname)) {
    return json({ error: { message: `relay: host "${baseParsed.hostname}" is not on the allowlist — add it in worker/index.js if this is a provider you intend to use` } }, 403);
  }

  // Plain concatenation, not the two-arg URL() constructor — baseUrl carries a
  // path prefix (e.g. "/openai/v1") that a leading-slash `path` would otherwise
  // clobber instead of append to.
  const targetUrl = `${baseUrl}${path}`;
  let upstream;
  try {
    upstream = await fetch(targetUrl, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    return json({ error: { message: "relay: upstream fetch failed — " + err.message } }, 502);
  }
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/relay") return handleRelay(request);
    return env.ASSETS.fetch(request);
  },
};
