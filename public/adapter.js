// Single provider adapter module. Every LLM call in the app goes through
// ProviderAdapter.call(). Nothing outside this file knows about Moonshot,
// the relay, or the request/response shape of any specific provider.
//
// Adding a second provider = adding one entry to PROVIDER_KINDS below.
// Nothing else in the app changes.
window.ProviderAdapter = (function () {
  // Same-origin "/relay" when served by the Cloudflare Worker (wrangler dev or
  // deployed) or any static server proxying that path; falls back to the
  // standalone Node relay's absolute URL when opened directly from file://.
  const RELAY_URL = window.location.protocol === "file:" ? "http://localhost:8787/relay" : "/relay";

  // Each entry knows how to build the request body/headers/path for that
  // provider family and how to pull text/usage back out of the response.
  const PROVIDER_KINDS = {
    "openai-compatible": {
      chatPath: "/chat/completions",
      buildHeaders(apiKey) {
        return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      },
      buildBody({ model, system, user, temperature, maxTokens }) {
        return {
          model,
          temperature,
          max_tokens: maxTokens || 900,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        };
      },
      extractText(data) {
        const choice = data.choices && data.choices[0];
        return choice && choice.message ? choice.message.content : "";
      },
      extractUsage(data) {
        return data.usage || null;
      },
    },
  };

  function regionHint(status, message) {
    if (status === 401) {
      return (
        message +
        ' — Moonshot API keys are region-isolated: a key issued on the China console returns 401 against the international endpoint (and vice versa). Confirm this key matches the configured base URL\'s region.'
      );
    }
    return message;
  }

  // settings: { baseUrl, model, apiKey, providerKind } (providerKind defaults to openai-compatible)
  async function call(settings, { system, user, temperature, maxTokens }) {
    const kind = PROVIDER_KINDS[settings.providerKind || "openai-compatible"];
    if (!kind) throw new Error(`Unknown provider kind "${settings.providerKind}"`);
    if (!settings.apiKey) throw new Error("No API key set — add one in Settings.");
    if (!settings.baseUrl) throw new Error("No base URL set — add one in Settings.");
    if (!settings.model) throw new Error("No model set — add one in Settings.");

    const started = performance.now();
    let resp;
    try {
      resp = await fetch(RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: settings.baseUrl,
          path: kind.chatPath,
          headers: kind.buildHeaders(settings.apiKey),
          body: kind.buildBody({ model: settings.model, system, user, temperature, maxTokens }),
        }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach the relay at ${RELAY_URL}. Is it running? (node relay/server.js) — ${err.message}`
      );
    }

    const latencyMs = Math.round(performance.now() - started);
    let data;
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error(`Relay returned a non-JSON response (HTTP ${resp.status}).`);
    }

    if (!resp.ok || data.error) {
      const rawMsg = (data.error && data.error.message) || `HTTP ${resp.status}`;
      throw new Error(regionHint(resp.status, rawMsg));
    }

    const text = kind.extractText(data);
    const usage = kind.extractUsage(data);
    return { text, usage, latencyMs };
  }

  // Fires one minimal real call against the configured provider — used by the
  // Settings "Test connection" button and required before any other screen is trusted.
  async function testConnection(settings) {
    return call(settings, { system: "Reply with exactly: ok", user: "ping", temperature: 0, maxTokens: 10 });
  }

  return { call, testConnection, PROVIDER_KINDS };
})();
