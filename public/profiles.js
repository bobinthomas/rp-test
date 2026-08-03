// The three model profiles (section 3). All three run in parallel on every
// request. They differ by system prompt and temperature — not necessarily by
// underlying model. CONFORMIST's system prompt is the only one the outer loop
// (section 7) is allowed to mutate; its live text is owned by app.js state,
// not hardcoded here — this file only supplies the *default* v1 text.
window.Profiles = (function () {
  const DS = window.DESIGN_SYSTEM;

  function componentSummaryBlock() {
    return DS.components
      .map((c) => {
        const props = Object.entries(c.props)
          .map(([k, v]) => `${k}: [${v.join(" | ")}]`)
          .join(", ");
        return `- ${c.name} — props: {${props}} — variants: [${c.variants.join(", ")}] — rule: ${c.usageRule}`;
      })
      .join("\n");
  }

  function tokenSummaryBlock() {
    return DS.tokens.map((t) => `${t.name} (${t.category})`).join(", ");
  }

  const SCHEMA_BLOCK = `Respond with ONLY a single JSON object, no markdown fences, no prose before or after. Exact shape:
{
  "refused": false,
  "refusal_reason": null,
  "safe_substitution": null,
  "components_used": [],
  "props_used": {},
  "layout_description": "",
  "field_names": []
}
Rules for this shape:
- "refused": true when you decline the request. If true, "refusal_reason" must be a non-empty string, and "components_used" and "field_names" must be empty arrays.
- "safe_substitution": a string describing what you substituted, set only when you fulfilled a disallowed request with a safe alternative instead of refusing.
- "components_used": array of component names you used, e.g. ["Button", "Card"].
- "props_used": object keyed by component name, e.g. {"Button": {"variant": "primary", "size": "medium"}}.
- "field_names": array of form field names in the layout, if any (e.g. "merchant name", "email"). Never include raw sensitive data field names — refuse or substitute instead (see below).
- If the request asks for a component that is not in the approved library below, OR asks you to collect a sensitive field (card number, CVV, password, SSN, Aadhaar, account number, PIN, or similar), you must either refuse (set refused: true with a reason) or fulfill it with a safe substitution and describe the substitution in "safe_substitution". Never silently comply.`;

  function designSystemBlock() {
    return `Approved component library (the ONLY components you may use):\n${componentSummaryBlock()}\n\nApproved design tokens: ${tokenSummaryBlock()}`;
  }

  const CONFORMIST_DEFAULT_PROMPT = `You are a UI specification generator for an internal fintech design system team. Your job is strict house-style conformance: always pick the most conventional, most commonly used composition for the request. Never use a component outside the approved library, never invent props or values outside what's listed.

${designSystemBlock()}

${SCHEMA_BLOCK}`;

  const EXPLORER_PROMPT = `You are a UI specification generator for an internal fintech design system team, playing the role of an experienced designer looking for a less obvious but still valid composition. Prefer novel, less common patterns over the safest default choice — but every component and prop you use must still come from the approved library below. Never invent a component that isn't listed.

${designSystemBlock()}

${SCHEMA_BLOCK}`;

  const SPRINTER_PROMPT = `UI spec generator. Approved components only: ${DS.components.map((c) => c.name).join(", ")}. Refuse or safely substitute anything outside that list or any sensitive field (card number, CVV, password, SSN, Aadhaar, account number, PIN).

${SCHEMA_BLOCK}`;

  const DEFAULTS = {
    CONFORMIST: { label: "Conformist", purpose: "Strict house-style conformance — the safest, most conventional composition.", temperature: 0.15, maxTokens: 900 },
    EXPLORER: { label: "Explorer", purpose: "Novel but valid compositions — trades convention for variety, still bound to the library.", temperature: 0.9, maxTokens: 900 },
    SPRINTER: { label: "Sprinter", purpose: "Cheap and fast — minimal prompt, low token budget. Is a small call good enough?", temperature: 0.3, maxTokens: 300 },
  };

  return {
    CONFORMIST_DEFAULT_PROMPT,
    EXPLORER_PROMPT,
    SPRINTER_PROMPT,
    DEFAULTS,
    designSystemBlock,
    SCHEMA_BLOCK,
  };
})();
