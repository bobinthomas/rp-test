// Optional simulation layer. When Settings.simulate is on, ProviderAdapter.call
// short-circuits here instead of hitting the relay/provider — lets someone try
// the whole flow (Generate, the Maker/Checker outer loop, Test Connection)
// with no API key and no network dependency, e.g. when the configured
// provider is slow/down. Everything downstream of this (inner loop repair,
// the evaluator, gates, scoring) still runs for real against whatever JSON
// comes back — only the model call itself is faked, and it's always labeled
// as simulated in the UI so it's never mistaken for a real result.
window.SimulatedProvider = (function () {
  const DS = window.DESIGN_SYSTEM;
  const KNOWN_NAMES = DS.components.map((c) => c.name);

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function propsFor(componentName, spoil) {
    const comp = DS.components.find((c) => c.name === componentName);
    if (!comp) return {};
    const props = {};
    for (const [key, allowed] of Object.entries(comp.props)) {
      props[key] = spoil && Math.random() < 0.5 ? "made-up-value" : randChoice(allowed);
    }
    return props;
  }

  function pickComponentsForIntent(intentLower) {
    if (/error|fail|declin/.test(intentLower)) return ["Alert", "Button"];
    if (/empty|no transactions|no data|nothing/.test(intentLower)) return ["EmptyState", "Button"];
    if (/table|list|transactions/.test(intentLower)) return ["Table", "EmptyState"];
    if (/modal|confirm/.test(intentLower)) return ["Modal", "Button"];
    if (/form|field|input|amount/.test(intentLower)) return ["Input", "Button"];
    if (/banner|warning|delay/.test(intentLower)) return ["Banner"];
    if (/select|dropdown|choose/.test(intentLower)) return ["Select", "Button"];
    if (/checkbox|toggle|consent/.test(intentLower)) return ["Checkbox", "Button"];
    return ["Card", "Button"];
  }

  function isSensitiveRequest(intentLower) {
    return DS.blocklist.some((b) => intentLower.includes(b));
  }

  function isUnknownComponentRequest(intentLower) {
    return /carousel|wysiwyg|chart|graph|calendar|slider|map view|video player|rich text editor/.test(intentLower);
  }

  function buildGenerationResponse(userMessage, spoilChance) {
    const m = userMessage.match(/Request:\s*(.*?)(?:\s*Constraints:|$)/s);
    const intent = (m ? m[1] : userMessage).toLowerCase();

    if (isSensitiveRequest(intent)) {
      if (Math.random() < 0.5) {
        return {
          refused: true,
          refusal_reason: "The request asks to collect a sensitive field that shouldn't be shown or stored directly.",
          safe_substitution: null,
          components_used: [],
          props_used: {},
          layout_description: "",
          field_names: [],
        };
      }
      return {
        refused: false,
        refusal_reason: null,
        safe_substitution: "Used a masked reference id instead of the raw sensitive value.",
        components_used: ["Input", "Button"],
        props_used: { Input: propsFor("Input", false), Button: propsFor("Button", false) },
        layout_description: "A masked reference field with a label and accessible description, paired with a primary Button.",
        field_names: ["masked reference id"],
      };
    }

    if (isUnknownComponentRequest(intent)) {
      return {
        refused: true,
        refusal_reason: "The requested component isn't in the approved design system library.",
        safe_substitution: null,
        components_used: [],
        props_used: {},
        layout_description: "",
        field_names: [],
      };
    }

    let comps = pickComponentsForIntent(intent);
    const spoil = Math.random() < spoilChance;
    if (spoil) comps = [...comps, "Carousel"]; // not a real component — exercises the hallucination gate
    const propsUsed = {};
    for (const c of comps) if (KNOWN_NAMES.includes(c)) propsUsed[c] = propsFor(c, spoil && Math.random() < 0.5);
    return {
      refused: false,
      refusal_reason: null,
      safe_substitution: null,
      components_used: comps,
      props_used: propsUsed,
      layout_description: `A ${comps.join(" and ")} composed to address: ${intent.slice(0, 90)}. Includes a label and description for accessibility.`,
      field_names: [],
    };
  }

  function buildMakerResponse(userMessage) {
    const m = userMessage.match(/Live system prompt:\s*\n?-{3}\n([\s\S]*?)\n-{3}/);
    const livePrompt = m ? m[1] : "You are a UI specification generator for an internal fintech design system team.";
    return {
      candidate_prompt: livePrompt + "\n\nAlways double-check every prop value against the approved list before responding — never invent a value that isn't explicitly listed.",
      rationale: "Simulated Maker: targets prop-hallucination failures seen in the lowest-scoring cases.",
    };
  }

  async function respond(system, user) {
    await sleep(250 + Math.random() * 450); // fake latency so loading states stay visible
    let text;
    if (/You are the Maker/.test(system)) {
      text = JSON.stringify(buildMakerResponse(user));
    } else if (/components_used/.test(system)) {
      const spoilChance = system.startsWith("UI spec generator") ? 0.35 : /strict house-style conformance/i.test(system) ? 0.08 : 0.15;
      text = JSON.stringify(buildGenerationResponse(user, spoilChance));
    } else {
      text = "ok";
    }
    const promptTokens = Math.round((system.length + user.length) / 4);
    const completionTokens = Math.round(text.length / 4);
    return {
      text,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      latencyMs: Math.round(250 + Math.random() * 450),
    };
  }

  return { respond };
})();
