// Per-request repair loop (section 4). Everything here is local to a single
// call to runProfileOnce() — nothing it does is written to app state, so it
// changes nothing that outlives the request it was called for.
window.InnerLoop = (function () {
  function aggregateUsage(usages) {
    if (!usages.length) return null;
    const sum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let any = false;
    for (const u of usages) {
      if (!u) continue;
      any = true;
      sum.prompt_tokens += u.prompt_tokens || 0;
      sum.completion_tokens += u.completion_tokens || 0;
      sum.total_tokens += u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0);
    }
    return any ? sum : null;
  }

  // settings: provider settings. systemPrompt/userMessage/temperature/maxTokens: this call's config.
  async function runProfileOnce(settings, systemPrompt, userMessage, temperature, maxTokens) {
    let attempts = 0;
    let totalLatency = 0;
    const usages = [];

    async function callOnce(system, user) {
      const res = await window.ProviderAdapter.call(settings, { system, user, temperature, maxTokens });
      totalLatency += res.latencyMs;
      if (res.usage) usages.push(res.usage);
      return res.text;
    }

    let rawText = await callOnce(systemPrompt, userMessage);
    let parsed = window.Utils.tryParseJson(rawText);
    let shape = parsed.ok ? window.Evaluator.validateShape(parsed.value) : { valid: false, errors: [parsed.error] };

    // Step 1: one retry for parse/shape failure.
    if (!parsed.ok || !shape.valid) {
      attempts++;
      const errDetail = !parsed.ok ? `not valid JSON: ${parsed.error}` : `did not match the required shape: ${shape.errors.join("; ")}`;
      const repairUser = `${userMessage}\n\n--- CORRECTION NEEDED ---\nYour previous response was ${errDetail}\nPrevious response:\n${rawText}\nReturn ONLY the corrected JSON object matching the exact schema, no markdown fences, no prose.`;
      rawText = await callOnce(systemPrompt, repairUser);
      parsed = window.Utils.tryParseJson(rawText);
      shape = parsed.ok ? window.Evaluator.validateShape(parsed.value) : { valid: false, errors: [parsed.error] };
    }

    if (!parsed.ok || !shape.valid) {
      return {
        result: null,
        raw: rawText,
        repairAttempts: attempts,
        violations: [],
        violatedAfterRepair: true,
        parseError: !parsed.ok ? parsed.error : shape.errors.join("; "),
        latencyMs: totalLatency,
        usage: aggregateUsage(usages),
      };
    }

    let result = parsed.value;
    let violations = window.Evaluator.validateAgainstDesignSystem(result);

    // Step 2: one repair call for design-system violations, within the 2-attempt cap.
    if (violations.length > 0 && attempts < 2) {
      attempts++;
      const repairUser = `${userMessage}\n\n--- CORRECTION NEEDED ---\nYour previous response used components/props outside the approved design system:\n${violations
        .map((v) => "- " + v)
        .join("\n")}\nFix ONLY these specific violations, keep everything else the same. Previous response:\n${JSON.stringify(
        result
      )}\nReturn ONLY the corrected JSON object matching the exact schema, no markdown fences, no prose.`;
      rawText = await callOnce(systemPrompt, repairUser);
      const reparsed = window.Utils.tryParseJson(rawText);
      if (reparsed.ok && window.Evaluator.validateShape(reparsed.value).valid) {
        result = reparsed.value;
        violations = window.Evaluator.validateAgainstDesignSystem(result);
      }
      // If the repair call itself came back malformed, keep the prior best attempt.
    }

    return {
      result,
      raw: rawText,
      repairAttempts: attempts,
      violations,
      violatedAfterRepair: violations.length > 0,
      parseError: null,
      latencyMs: totalLatency,
      usage: aggregateUsage(usages),
    };
  }

  return { runProfileOnce };
})();
