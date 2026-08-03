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

  // Cloudflare's own edge gives an origin up to 125s before returning a 524
  // itself — nobody should have to wait that long to find out a model is
  // overloaded. Fail client-side well before that, with a clear reason.
  const REQUEST_TIMEOUT_MS = 45000;

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
        const content = choice && choice.message ? choice.message.content : "";
        return content == null ? "" : content; // some providers return content: null (e.g. tool calls, empty completions)
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

  // settings: { baseUrl, model, apiKey, providerKind, simulate } (providerKind defaults to openai-compatible)
  async function call(settings, { system, user, temperature, maxTokens }) {
    if (settings.simulate) return window.SimulatedProvider.respond(system, user);

    const kind = PROVIDER_KINDS[settings.providerKind || "openai-compatible"];
    if (!kind) throw new Error(`Unknown provider kind "${settings.providerKind}"`);
    if (!settings.apiKey) throw new Error("No API key set — add one in Settings.");
    if (!settings.baseUrl) throw new Error("No base URL set — add one in Settings.");
    if (!settings.model) throw new Error("No model set — add one in Settings.");

    const started = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          baseUrl: settings.baseUrl,
          path: kind.chatPath,
          headers: kind.buildHeaders(settings.apiKey),
          body: kind.buildBody({ model: settings.model, system, user, temperature, maxTokens }),
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(
          `Timed out waiting ${REQUEST_TIMEOUT_MS / 1000}s for a response — the provider (${settings.model}) is likely overloaded or slow right now. Try again, switch providers in Settings, or use Simulation mode.`
        );
      }
      throw new Error(
        `Could not reach the relay at ${RELAY_URL}. Is it running? (node relay/server.js) — ${err.message}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Math.round(performance.now() - started);
    let data;
    try {
      data = await resp.json();
    } catch (err) {
      const timeoutHint = resp.status === 524 ? " — the provider took too long to respond (edge proxy timeout); it's likely overloaded. Try again, switch providers, or use Simulation mode." : "";
      throw new Error(`Relay returned a non-JSON response (HTTP ${resp.status}).${timeoutHint}`);
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
