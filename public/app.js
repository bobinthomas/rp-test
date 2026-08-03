(function () {
  const DS = window.DESIGN_SYSTEM;
  const Utils = window.Utils;
  const Evaluator = window.Evaluator;
  const Profiles = window.Profiles;
  const EVAL_CASES = window.EVAL_CASES;

  // ---------------------------------------------------------------------
  // State — everything lives here, in memory, for the life of the tab.
  // Export/import (Settings screen) serializes this object to/from JSON,
  // always stripping the API key first.
  // ---------------------------------------------------------------------
  const AppState = {
    settings: {
      providerKind: "openai-compatible",
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k3",
      apiKey: "",
      temperatures: { CONFORMIST: 0.15, EXPLORER: 0.9, SPRINTER: 0.3 },
      runsPerCase: 3,
      connectionOk: false,
    },
    prompts: {
      versions: [
        {
          id: "v0",
          text: Profiles.CONFORMIST_DEFAULT_PROMPT,
          status: "live",
          createdAt: Utils.nowIso(),
          rationale: "Initial baseline prompt (seed).",
          parentId: null,
          source: "seed",
        },
      ],
      liveId: "v0",
    },
    lastLiveTrainingEval: null,
    lastGeneration: null,
    generationHistory: [], // live Generate-screen outputs only, for the Review Queue stub
    correctionLog: [],
    outerLoop: { history: [] },
    judgmentRatings: {},
  };

  // ---------------------------------------------------------------------
  // Generation core — shared by the Generate screen, the Checker, and the
  // held-out commit run, so the eval loop always exercises the exact same
  // code path a designer's live request would.
  // ---------------------------------------------------------------------
  function getLiveVersion() {
    return AppState.prompts.versions.find((v) => v.id === AppState.prompts.liveId);
  }

  function getSystemPromptFor(profileKey, overrideText) {
    if (profileKey === "CONFORMIST") return overrideText || getLiveVersion().text;
    if (profileKey === "EXPLORER") return Profiles.EXPLORER_PROMPT;
    if (profileKey === "SPRINTER") return Profiles.SPRINTER_PROMPT;
    throw new Error(`Unknown profile "${profileKey}"`);
  }

  function getProfileRuntimeConfig(profileKey) {
    const def = Profiles.DEFAULTS[profileKey];
    return { label: def.label, purpose: def.purpose, temperature: AppState.settings.temperatures[profileKey], maxTokens: def.maxTokens };
  }

  function constraintLabels(constraints) {
    const labels = [];
    if (constraints.approved) labels.push("use only approved components from the library");
    if (constraints.primary) labels.push("include a primary action");
    if (constraints.accessible) labels.push("include an accessible description");
    return labels;
  }

  function buildUserMessage(intent, surface, constraints) {
    const labels = constraintLabels(constraints);
    const c = labels.length ? ` Constraints: ${labels.join("; ")}.` : "";
    return `Surface: ${surface}. Request: ${intent}${c}`;
  }

  // request: { intent, surface, constraints, expected_behavior? }. Runs the full
  // inner loop, then scores the final attempt against the evaluator. Throws only
  // on transport/auth failure — parse/shape failures are captured in the result.
  async function generateOne(profileKey, request, systemPromptOverride) {
    const cfg = getProfileRuntimeConfig(profileKey);
    const systemPrompt = getSystemPromptFor(profileKey, systemPromptOverride);
    const userMessage = buildUserMessage(request.intent, request.surface, request.constraints);
    const inner = await window.InnerLoop.runProfileOnce(AppState.settings, systemPrompt, userMessage, cfg.temperature, cfg.maxTokens);
    const expectedBehavior = request.expected_behavior || "generate";

    if (!inner.result) {
      return {
        profileKey,
        request,
        inner,
        result: null,
        gates: {
          safety: { pass: false, reason: "response could not be parsed: " + inner.parseError },
          hallucination: { pass: false, reason: "response could not be parsed" },
        },
        accuracy: 0,
        instruction: { checks: [], fraction: null },
      };
    }

    const safety = Evaluator.safetyGate(inner.result);
    const hallucination = Evaluator.hallucinationGate(inner.violations);
    const accuracy = Evaluator.accuracy(inner.result, expectedBehavior, inner.violations);
    const instruction = Evaluator.instructionFollowing(inner.result, request.constraints, request.intent);
    return { profileKey, request, inner, result: inner.result, gates: { safety, hallucination }, accuracy, instruction };
  }

  // Runs every case in `cases` `runsPerCase` times through CONFORMIST with the
  // given system prompt text, concurrency-capped at 3, reporting progress.
  async function runCaseSet(cases, systemPromptText, runsPerCase, onProgress) {
    const jobs = [];
    for (const c of cases) for (let i = 0; i < runsPerCase; i++) jobs.push(c);
    return Utils.mapWithConcurrency(
      jobs,
      3,
      async (c) => {
        const request = { intent: c.intent, surface: c.surface, constraints: c.constraints, expected_behavior: c.expected_behavior };
        try {
          const r = await generateOne("CONFORMIST", request, systemPromptText);
          return { ...r, caseId: c.id };
        } catch (err) {
          return {
            caseId: c.id,
            request,
            error: err.message,
            accuracy: 0,
            gates: { safety: { pass: false, reason: "call failed: " + err.message }, hallucination: { pass: false, reason: "call failed" } },
            instruction: { checks: [], fraction: null },
            inner: null,
            result: null,
          };
        }
      },
      onProgress
    );
  }

  function aggregateResults(rows) {
    const accs = rows.map((r) => r.accuracy);
    const instrFractions = rows.filter((r) => r.instruction.fraction !== null).map((r) => r.instruction.fraction * 100);
    const safetyPasses = rows.map((r) => r.gates.safety.pass);
    const halluPasses = rows.map((r) => r.gates.hallucination.pass);
    return {
      accuracy: { mean: Utils.round1(Utils.mean(accs)), range: Utils.range(accs) },
      instruction: instrFractions.length
        ? { mean: Utils.round1(Utils.mean(instrFractions)), range: Utils.range(instrFractions) }
        : { mean: null, range: null },
      safetyPassRate: Utils.round1((safetyPasses.filter(Boolean).length / safetyPasses.length) * 100),
      hallucinationPassRate: Utils.round1((halluPasses.filter(Boolean).length / halluPasses.length) * 100),
      anyGateFail: rows.some((r) => !r.gates.safety.pass || !r.gates.hallucination.pass),
      rows,
    };
  }

  function perCaseSummaries(cases, rows) {
    return cases.map((c) => {
      const crows = rows.filter((r) => r.caseId === c.id);
      const accs = crows.map((r) => r.accuracy);
      return {
        id: c.id,
        intent: c.intent,
        surface: c.surface,
        accuracyMean: Utils.round1(Utils.mean(accs)),
        accuracyRange: Utils.range(accs),
        exampleRun: crows[0],
        runs: crows,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Rendering — Generate screen
  // ---------------------------------------------------------------------
  function renderDsSummary() {
    document.getElementById("dsSummary").innerHTML = DS.components.map((c) => `<span class="chip">${c.name}</span>`).join(" ");
  }

  function renderMockBlock(result) {
    if (!result) return '<div class="empty-state">No result.</div>';
    let html = "";
    if (result.refused) {
      html += `<div class="refusal-block">Refused: ${Utils.escapeHtml(result.refusal_reason || "(no reason given)")}</div>`;
      return html;
    }
    if (result.safe_substitution) {
      html += `<div class="subst-block">Substituted: ${Utils.escapeHtml(result.safe_substitution)}</div>`;
    }
    const comps = result.components_used || [];
    if (!comps.length) return html + '<div class="empty-state">Model returned no components.</div>';
    html += comps
      .map((c) => {
        const known = Evaluator.isKnownComponent(c);
        return `<div class="comp-block ${known ? "known" : "unknown"}">${Utils.escapeHtml(c)}${known ? "" : " (unrecognized)"}</div>`;
      })
      .join("");
    return html;
  }

  function renderScorecard(item) {
    const g = item.gates;
    const instrRows = (item.instruction.checks || [])
      .map((c) => `<div class="instr-item"><span>${Utils.escapeHtml(c.label)}</span><span class="${c.pass ? "good" : "bad"}">${c.pass ? "PASS" : "FAIL"}</span></div>`)
      .join("");
    return `
      <div class="scorecard">
        <div class="gate-row">
          <span class="pill ${g.safety.pass ? "good" : "bad"}">SAFETY ${g.safety.pass ? "PASS" : "FAIL"}</span>
          <span class="pill ${g.hallucination.pass ? "good" : "bad"}">HALLUCINATION ${g.hallucination.pass ? "PASS" : "FAIL"}</span>
        </div>
        ${!g.safety.pass ? `<div class="gate-fail-note">Safety: ${Utils.escapeHtml(g.safety.reason)}</div>` : ""}
        ${!g.hallucination.pass ? `<div class="gate-fail-note">Hallucination: ${Utils.escapeHtml(g.hallucination.reason)}</div>` : ""}
        <div class="score-row"><span>Accuracy (target)</span><span class="num">${item.accuracy}%</span></div>
        <div class="score-row"><span>Instruction-following</span><span class="num">${
          item.instruction.fraction === null ? "n/a" : Math.round(item.instruction.fraction * 100) + "%"
        }</span></div>
        <div class="instr-list">${instrRows}</div>
        <div class="caption" style="margin-top:8px;">Gates are constraints, not objectives.</div>
      </div>`;
  }

  function renderCostLine(item) {
    if (!item.inner) return "";
    const u = item.inner.usage;
    const tokenStr = u
      ? `${u.prompt_tokens ?? "?"} in / ${u.completion_tokens ?? "?"} out / ${u.total_tokens ?? "?"} total`
      : "usage not reported by provider";
    return `<div class="cost-line">latency ${item.inner.latencyMs}ms &middot; repair attempts ${item.inner.repairAttempts}/2 &middot; tokens: ${tokenStr}</div>`;
  }

  function renderProfileCard(profileKey, item) {
    const def = Profiles.DEFAULTS[profileKey];
    const greyed = !item.error && (!item.gates.safety.pass || !item.gates.hallucination.pass);
    return `
    <div class="profile-card ${greyed ? "result-greyed" : ""}" data-profile="${profileKey}">
      <div class="ptitle">${def.label}</div>
      <div class="ppurpose">${Utils.escapeHtml(def.purpose)}</div>
      ${
        item.error
          ? `<div class="status-line err">Call failed: ${Utils.escapeHtml(item.error)}</div>`
          : `
        <div class="mockscreen">${renderMockBlock(item.result)}</div>
        ${greyed ? `<div class="gate-fail-note">Excluded from optimization data — a gate failed.</div>` : ""}
        <div class="json-toggle" data-action="toggle-json">Raw JSON &#9662;</div>
        <div class="rawjson">${Utils.escapeHtml(JSON.stringify(item.result, null, 2))}</div>
        ${renderScorecard(item)}
        ${renderCostLine(item)}
        <div class="action-row">
          <button class="good small" data-action="accept">Accept</button>
          <button class="small" data-action="edit">Edit</button>
          <button class="bad small" data-action="reject">Reject</button>
        </div>`
      }
    </div>`;
  }

  function renderGenerationResults() {
    const el = document.getElementById("genResults");
    const gen = AppState.lastGeneration;
    if (!gen) {
      el.innerHTML = '<div class="empty-state">Nothing generated yet. Fill in a request and click Generate UI.</div>';
      return;
    }
    el.innerHTML = `<div class="profiles-grid">${["CONFORMIST", "EXPLORER", "SPRINTER"].map((p) => renderProfileCard(p, gen.results[p])).join("")}</div>`;
  }

  function computeSimpleDiff(oldObj, newObj) {
    const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
    const diffs = [];
    for (const k of keys) {
      const a = JSON.stringify(oldObj ? oldObj[k] : undefined);
      const b = JSON.stringify(newObj ? newObj[k] : undefined);
      if (a !== b) diffs.push({ key: k, before: a, after: b });
    }
    return diffs;
  }

  function logCorrection(profileKey, action, item, diff, editedResult) {
    AppState.correctionLog.push({
      id: Utils.uid("c"),
      timestamp: Utils.nowIso(),
      profile: Profiles.DEFAULTS[profileKey].label,
      action,
      request: item.request,
      output: editedResult || item.result || null,
      diff: diff || null,
    });
    renderCorrectionLog();
  }

  function renderCorrectionLog() {
    const el = document.getElementById("corrections");
    if (!AppState.correctionLog.length) {
      el.innerHTML = '<div class="empty-state">No actions logged yet.</div>';
      return;
    }
    el.innerHTML = [...AppState.correctionLog]
      .reverse()
      .map(
        (c) =>
          `<div class="correction-item">[${new Date(c.timestamp).toLocaleTimeString()}] ${Utils.escapeHtml(c.profile)} &mdash; <strong>${c.action.toUpperCase()}</strong> &mdash; "${Utils.escapeHtml(
            c.request.intent.slice(0, 70)
          )}"${c.diff && c.diff.length ? ` &mdash; edited: ${c.diff.map((d) => d.key).join(", ")}` : ""}</div>`
      )
      .join("");
  }

  function openEditor(card, item) {
    if (!item.result || card.querySelector(".edit-box")) return;
    const box = document.createElement("div");
    box.className = "edit-box";
    box.innerHTML = `
      <label style="margin-top:12px;">Edit JSON</label>
      <textarea style="min-height:140px; font-family:var(--mono); font-size:11.5px;">${Utils.escapeHtml(JSON.stringify(item.result, null, 2))}</textarea>
      <div class="action-row">
        <button class="good small" data-action="save-edit">Save</button>
        <button class="small" data-action="cancel-edit">Cancel</button>
      </div>`;
    card.appendChild(box);
  }

  function saveEditor(card, profileKey, item) {
    const textarea = card.querySelector(".edit-box textarea");
    let edited;
    try {
      edited = JSON.parse(textarea.value);
    } catch (err) {
      alert("Invalid JSON: " + err.message);
      return;
    }
    const diff = computeSimpleDiff(item.result, edited);
    logCorrection(profileKey, "edit", item, diff, edited);
    const violations = Evaluator.validateAgainstDesignSystem(edited);
    const safety = Evaluator.safetyGate(edited);
    const hallucination = Evaluator.hallucinationGate(violations);
    const accuracy = Evaluator.accuracy(edited, "generate", violations);
    const instruction = Evaluator.instructionFollowing(edited, item.request.constraints, item.request.intent);
    AppState.lastGeneration.results[profileKey] = { ...item, result: edited, gates: { safety, hallucination }, accuracy, instruction };
    renderGenerationResults();
  }

  function initGenerateScreenEvents() {
    document.getElementById("genResults").addEventListener("click", (e) => {
      const toggle = e.target.closest('[data-action="toggle-json"]');
      if (toggle) {
        const raw = toggle.nextElementSibling;
        raw.classList.toggle("open");
        toggle.innerHTML = raw.classList.contains("open") ? "Raw JSON &#9652;" : "Raw JSON &#9662;";
        return;
      }
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const card = btn.closest(".profile-card");
      const profileKey = card.getAttribute("data-profile");
      const action = btn.getAttribute("data-action");
      const item = AppState.lastGeneration.results[profileKey];
      if (action === "accept" || action === "reject") logCorrection(profileKey, action, item);
      else if (action === "edit") openEditor(card, item);
      else if (action === "save-edit") saveEditor(card, profileKey, item);
      else if (action === "cancel-edit") renderGenerationResults();
    });

    document.getElementById("genBtn").addEventListener("click", onGenerateClick);
  }

  async function onGenerateClick() {
    const s = AppState.settings;
    const statusEl = document.getElementById("genStatus");
    if (!s.apiKey) {
      statusEl.className = "status-line err";
      statusEl.textContent = "Set an API key in Settings first.";
      return;
    }
    const intent = document.getElementById("reqIntent").value.trim();
    if (!intent) {
      statusEl.className = "status-line err";
      statusEl.textContent = "Enter an intent.";
      return;
    }
    const request = {
      intent,
      surface: document.getElementById("reqSurface").value,
      constraints: {
        approved: document.getElementById("reqApproved").checked,
        primary: document.getElementById("reqPrimary").checked,
        accessible: document.getElementById("reqAccessible").checked,
      },
    };
    const btn = document.getElementById("genBtn");
    btn.disabled = true;
    statusEl.className = "status-line";
    const progressEl = document.getElementById("genProgress");
    const bar = progressEl.querySelector("div");
    progressEl.style.display = "block";
    bar.style.width = "0%";
    let done = 0;
    statusEl.textContent = "Calling CONFORMIST, EXPLORER, SPRINTER — 0 of 3 complete";

    const profiles = ["CONFORMIST", "EXPLORER", "SPRINTER"];
    const results = {};
    await Promise.all(
      profiles.map(async (p) => {
        try {
          results[p] = await generateOne(p, request);
        } catch (err) {
          results[p] = { profileKey: p, request, error: err.message };
        }
        done++;
        bar.style.width = Math.round((done / 3) * 100) + "%";
        statusEl.textContent = `Calling CONFORMIST, EXPLORER, SPRINTER — ${done} of 3 complete`;
      })
    );

    AppState.lastGeneration = { request, results };
    for (const p of profiles) {
      if (!results[p].error) AppState.generationHistory.push({ id: Utils.uid("g"), profileKey: p, request, result: results[p].result });
    }
    renderGenerationResults();
    progressEl.style.display = "none";
    statusEl.textContent = "Done.";
    btn.disabled = false;
  }

  // ---------------------------------------------------------------------
  // Optimization screen — Maker / Checker / Decision / Held-out / Promotion
  // ---------------------------------------------------------------------
  function renderLivePrompt() {
    const v = getLiveVersion();
    document.getElementById("livePromptView").textContent = `[${v.id} · live · created ${new Date(v.createdAt).toLocaleString()}]\n\n${v.text}`;
  }

  function renderMakerPanel(maker, candidateVersion) {
    document.getElementById("makerPanel").style.display = "block";
    document.getElementById("makerContent").innerHTML = `
      <div class="chip">rationale</div>
      <p style="margin:8px 0 14px;">${Utils.escapeHtml(maker.rationale)}</p>
      <label>Candidate prompt — full text</label>
      <div class="rawjson open" style="max-height:260px;">${Utils.escapeHtml(candidateVersion.text)}</div>`;
  }

  function renderCheckerPanel(liveAgg, candAgg) {
    document.getElementById("checkerPanel").style.display = "block";
    const N = EVAL_CASES.training.length * AppState.settings.runsPerCase;
    const metricRow = (label, l, c) => `
      <tr>
        <td>${label}</td>
        <td>${l.mean === null ? "n/a" : l.mean + "%"} ${l.range ? `<span style="color:var(--text-faint)">(${Utils.round1(l.range.min)}&ndash;${Utils.round1(l.range.max)})</span>` : ""}</td>
        <td>${c.mean === null ? "n/a" : c.mean + "%"} ${c.range ? `<span style="color:var(--text-faint)">(${Utils.round1(c.range.min)}&ndash;${Utils.round1(c.range.max)})</span>` : ""}</td>
      </tr>`;
    document.getElementById("checkerContent").innerHTML = `
      <table>
        <thead><tr><th>Metric</th><th>Live (N=${N})</th><th>Candidate (N=${N})</th></tr></thead>
        <tbody>
          ${metricRow("Accuracy (target)", liveAgg.accuracy, candAgg.accuracy)}
          ${metricRow("Instruction-following", liveAgg.instruction, candAgg.instruction)}
          <tr><td>Safety gate pass rate</td><td>${liveAgg.safetyPassRate}%</td><td>${candAgg.safetyPassRate}%</td></tr>
          <tr><td>Hallucination gate pass rate</td><td>${liveAgg.hallucinationPassRate}%</td><td>${candAgg.hallucinationPassRate}%</td></tr>
        </tbody>
      </table>`;
  }

  function renderDecisionPanel(decision, reason) {
    document.getElementById("decisionPanel").style.display = "block";
    document.getElementById("decisionContent").innerHTML = `<div class="decision-banner ${decision === "staged" ? "staged" : "rejected"}"><strong>${decision.toUpperCase()}</strong> &mdash; ${Utils.escapeHtml(
      reason
    )}</div>`;
  }

  function renderHeldOutPanel(trainingDelta, heldOutDelta, liveHOAgg, candHOAgg) {
    document.getElementById("heldOutPanel").style.display = "block";
    const fmt = (d) => (d > 0 ? "+" : "") + Utils.round1(d) + "pp";
    document.getElementById("heldOutContent").innerHTML = `
      <div class="metric-compare">
        <div class="metric-box"><div class="mtitle">Training accuracy delta</div><div class="mval" style="color:var(--${trainingDelta >= 0 ? "good" : "bad"})">${fmt(trainingDelta)}</div></div>
        <div class="metric-box"><div class="mtitle">Held-out accuracy delta</div><div class="mval" style="color:var(--${heldOutDelta >= 0 ? "good" : "bad"})">${fmt(heldOutDelta)}</div></div>
      </div>
      <table style="margin-top:14px;">
        <thead><tr><th>Held-out</th><th>Live</th><th>Candidate</th></tr></thead>
        <tbody><tr><td>Accuracy</td><td>${liveHOAgg.accuracy.mean}%</td><td>${candHOAgg.accuracy.mean}%</td></tr></tbody>
      </table>`;
  }

  function renderPromotionPanel(candidateVersion, liveVersion, opts) {
    document.getElementById("promotionPanel").style.display = "block";
    const diffRows = Utils.lineDiff(liveVersion.text, candidateVersion.text)
      .map((d) => `<div class="diff-line ${d.type}">${Utils.escapeHtml(d.text) || "&nbsp;"}</div>`)
      .join("");
    document.getElementById("promotionContent").innerHTML = `
      ${opts.isRollback ? `<div class="caption top">Rollback &mdash; restoring a previously-live version through the same gate. ${Utils.escapeHtml(opts.note || "")}</div>` : ""}
      <div class="chip">Maker rationale</div>
      <p>${Utils.escapeHtml(candidateVersion.rationale || "(rollback — no new rationale)")}</p>
      <div class="metric-compare">
        <div class="metric-box"><div class="mtitle">Training &Delta;</div><div class="mval">${
          candidateVersion.trainingDelta != null ? (candidateVersion.trainingDelta > 0 ? "+" : "") + Utils.round1(candidateVersion.trainingDelta) + "pp" : "n/a"
        }</div></div>
        <div class="metric-box"><div class="mtitle">Held-out &Delta;</div><div class="mval">${
          candidateVersion.heldOutDelta != null ? (candidateVersion.heldOutDelta > 0 ? "+" : "") + Utils.round1(candidateVersion.heldOutDelta) + "pp" : "n/a"
        }</div></div>
      </div>
      <label style="margin-top:14px;">Diff vs. live (${liveVersion.id})</label>
      <div class="diff-view">${diffRows}</div>
      <div class="action-row" style="margin-top:14px;">
        <button class="good" id="approveBtn">Approve — make live</button>
        <button class="bad" id="rejectBtn">Reject</button>
      </div>`;
    document.getElementById("approveBtn").onclick = () => decidePromotion(candidateVersion.id, "approve", opts.isRollback);
    document.getElementById("rejectBtn").onclick = () => decidePromotion(candidateVersion.id, "reject", opts.isRollback);
  }

  function decidePromotion(versionId, decision, isRollback) {
    const v = AppState.prompts.versions.find((x) => x.id === versionId);
    const prevLive = getLiveVersion();
    if (decision === "approve") {
      v.status = "live";
      AppState.prompts.liveId = v.id;
      if (isRollback && prevLive) prevLive.status = "rolled-back";
      AppState.outerLoop.history.push({
        id: Utils.uid("h"),
        timestamp: Utils.nowIso(),
        versionId: v.id,
        action: isRollback ? "rollback-approve" : "promotion-approve",
        decidedBy: "human",
        details: `${v.id} made live${isRollback ? " via rollback" : ""}.`,
      });
    } else {
      v.status = "rejected";
      AppState.outerLoop.history.push({
        id: Utils.uid("h"),
        timestamp: Utils.nowIso(),
        versionId: v.id,
        action: isRollback ? "rollback-reject" : "promotion-reject",
        decidedBy: "human",
        details: `${v.id} rejected at promotion gate${isRollback ? " (rollback)" : ""}.`,
      });
    }
    document.getElementById("promotionPanel").style.display = "none";
    renderLivePrompt();
    renderHistory();
  }

  function renderHistory() {
    const el = document.getElementById("historyList");
    const versionsRows = AppState.prompts.versions
      .map((v) => {
        const isCurrentLive = v.id === AppState.prompts.liveId;
        const canRollback = v.status === "live" && !isCurrentLive;
        return `<tr>
          <td>${v.id}${isCurrentLive ? ' <span class="chip">current</span>' : ""}</td>
          <td><span class="status-tag ${v.status}">${v.status}</span></td>
          <td>${new Date(v.createdAt).toLocaleString()}</td>
          <td>${Utils.escapeHtml(v.rationale || "")}</td>
          <td>${canRollback ? `<button class="small" data-rollback="${v.id}">Roll back</button>` : ""}</td>
        </tr>`;
      })
      .join("");

    const logHtml = AppState.outerLoop.history.length
      ? [...AppState.outerLoop.history]
          .reverse()
          .map(
            (h) => `<div class="history-item">
              <div class="h-top"><span>${Utils.escapeHtml(h.details)}</span><span class="status-tag ${
              h.action.includes("approve") ? "live" : h.action.includes("reject") ? "rejected" : "candidate"
            }">${h.action}</span></div>
              <div class="h-meta">${new Date(h.timestamp).toLocaleString()} &middot; decided by ${h.decidedBy} &middot; version ${h.versionId}</div>
            </div>`
          )
          .join("")
      : '<div class="empty-state">No decisions logged yet.</div>';

    el.innerHTML = `
      <table><thead><tr><th>Version</th><th>Status</th><th>Created</th><th>Rationale</th><th></th></tr></thead><tbody>${versionsRows}</tbody></table>
      <div style="margin-top:16px;">${logHtml}</div>`;

    el.querySelectorAll("[data-rollback]").forEach((btn) => {
      btn.onclick = () => startRollback(btn.getAttribute("data-rollback"));
    });
  }

  function startRollback(versionId) {
    const target = AppState.prompts.versions.find((v) => v.id === versionId);
    const live = getLiveVersion();
    renderPromotionPanel(target, live, { isRollback: true, note: `${target.id} was live from an earlier iteration; no new Maker/Checker run — it was already measured when first promoted.` });
    document.getElementById("promotionPanel").scrollIntoView({ behavior: "smooth" });
  }

  async function callMaker(livePromptText, liveAgg) {
    const lowest = [...liveAgg.perCaseSummaries].sort((a, b) => a.accuracyMean - b.accuracyMean).slice(0, 3);
    const caseBlock = lowest
      .map((c) => {
        const ex = c.exampleRun;
        const out =
          ex && ex.result
            ? `refused=${ex.result.refused}, components_used=${JSON.stringify(ex.result.components_used)}, refusal_reason=${JSON.stringify(
                ex.result.refusal_reason
              )}, safe_substitution=${JSON.stringify(ex.result.safe_substitution)}`
            : ex && ex.error
            ? `call error: ${ex.error}`
            : "response could not be parsed";
        return `- Case "${c.intent}" (${c.surface}): accuracy ${c.accuracyMean}%. Example output — ${out}`;
      })
      .join("\n");

    const makerSystem = `You are the Maker in a prompt-optimization loop that improves a UI-generation system prompt. You will see the current live prompt, its aggregate training accuracy, and its 3 lowest-scoring cases. Propose exactly ONE specific, targeted change — the smallest change likely to fix the pattern you see. Do not rewrite the prompt wholesale. Return ONLY a JSON object: {"candidate_prompt": "<the full corrected system prompt, ready to use as-is>", "rationale": "<one sentence: what failure this targets>"}. No markdown fences, no prose outside the JSON.`;
    const makerUser = `Live system prompt:\n---\n${livePromptText}\n---\n\nAggregate training accuracy this session: ${liveAgg.accuracy.mean}% (range ${liveAgg.accuracy.range.min}-${liveAgg.accuracy.range.max})\n\n3 lowest-scoring cases:\n${caseBlock}\n\nPropose one change and return the full candidate prompt.`;

    let res = await window.ProviderAdapter.call(AppState.settings, { system: makerSystem, user: makerUser, temperature: 0.4, maxTokens: 1600 });
    let parsed = Utils.tryParseJson(res.text);
    if (!parsed.ok || !parsed.value.candidate_prompt) {
      const retryUser = `${makerUser}\n\n--- CORRECTION NEEDED ---\nYour previous response could not be parsed as the required JSON object. Previous response:\n${res.text}\nReturn ONLY valid JSON: {"candidate_prompt": "...", "rationale": "..."}`;
      res = await window.ProviderAdapter.call(AppState.settings, { system: makerSystem, user: retryUser, temperature: 0.4, maxTokens: 1600 });
      parsed = Utils.tryParseJson(res.text);
    }
    if (!parsed.ok || !parsed.value.candidate_prompt) {
      throw new Error("Maker did not return a parseable candidate_prompt after one retry: " + (parsed.error || "missing field"));
    }
    return { candidatePrompt: parsed.value.candidate_prompt, rationale: parsed.value.rationale || "(no rationale given)" };
  }

  async function runIteration() {
    if (!AppState.settings.apiKey) {
      const statusEl = document.getElementById("iterStatus");
      statusEl.className = "status-line err";
      statusEl.textContent = "Set an API key in Settings first.";
      return;
    }
    const btn = document.getElementById("runIterationBtn");
    btn.disabled = true;
    ["makerPanel", "checkerPanel", "decisionPanel", "heldOutPanel", "promotionPanel"].forEach((id) => (document.getElementById(id).style.display = "none"));
    const progressEl = document.getElementById("iterProgress");
    const bar = progressEl.querySelector("div");
    const statusEl = document.getElementById("iterStatus");
    statusEl.className = "status-line";
    progressEl.style.display = "block";
    function setProgress(done, total, label) {
      bar.style.width = total ? Math.round((done / total) * 100) + "%" : "0%";
      statusEl.textContent = `${label} — ${done} of ${total} complete`;
    }

    try {
      const liveVersion = getLiveVersion();
      const runsPerCase = AppState.settings.runsPerCase;

      statusEl.textContent = "Step 1 of 5 — measuring live prompt against training set...";
      const liveRows = await runCaseSet(EVAL_CASES.training, liveVersion.text, runsPerCase, (d, t) => setProgress(d, t, "Measuring live prompt (training)"));
      const liveAgg = aggregateResults(liveRows);
      liveAgg.perCaseSummaries = perCaseSummaries(EVAL_CASES.training, liveRows);
      AppState.lastLiveTrainingEval = liveAgg;

      statusEl.textContent = "Step 2 of 5 — Maker proposing a candidate change...";
      const maker = await callMaker(liveVersion.text, liveAgg);
      const candidateVersion = {
        id: Utils.uid("v"),
        text: maker.candidatePrompt,
        status: "candidate",
        createdAt: Utils.nowIso(),
        rationale: maker.rationale,
        parentId: liveVersion.id,
        source: "maker",
      };
      AppState.prompts.versions.push(candidateVersion);
      renderMakerPanel(maker, candidateVersion);

      statusEl.textContent = "Step 3 of 5 — Checker running candidate against training set...";
      const candRows = await runCaseSet(EVAL_CASES.training, candidateVersion.text, runsPerCase, (d, t) => setProgress(d, t, "Checking candidate (training)"));
      const candAgg = aggregateResults(candRows);
      candAgg.perCaseSummaries = perCaseSummaries(EVAL_CASES.training, candRows);
      renderCheckerPanel(liveAgg, candAgg);

      let decision, reason;
      if (candAgg.anyGateFail) {
        decision = "rejected";
        reason = "At least one candidate run failed a gate (safety or hallucination) — rejected regardless of accuracy.";
      } else if (candAgg.accuracy.mean > liveAgg.accuracy.mean) {
        decision = "staged";
        reason = `Candidate training accuracy ${candAgg.accuracy.mean}% improves over live ${liveAgg.accuracy.mean}% (measured this session).`;
      } else {
        decision = "rejected";
        reason = `Candidate training accuracy ${candAgg.accuracy.mean}% did not improve over live ${liveAgg.accuracy.mean}% (measured this session).`;
      }
      candidateVersion.trainingDelta = candAgg.accuracy.mean - liveAgg.accuracy.mean;
      renderDecisionPanel(decision, reason);
      AppState.outerLoop.history.push({
        id: Utils.uid("h"),
        timestamp: Utils.nowIso(),
        versionId: candidateVersion.id,
        action: "checker-decision",
        decidedBy: "system (checker gate + accuracy)",
        details: `${candidateVersion.id}: ${decision} — ${reason}`,
      });

      if (decision === "rejected") {
        candidateVersion.status = "rejected";
        renderHistory();
        statusEl.textContent = "Iteration complete — candidate rejected by checker.";
        progressEl.style.display = "none";
        btn.disabled = false;
        return;
      }

      candidateVersion.status = "staged";
      renderHistory();

      statusEl.textContent = "Step 4 of 5 — running held-out set for both prompts...";
      const liveHORows = await runCaseSet(EVAL_CASES.heldOut, liveVersion.text, runsPerCase, (d, t) => setProgress(d, t, "Held-out — live prompt"));
      const liveHOAgg = aggregateResults(liveHORows);
      const candHORows = await runCaseSet(EVAL_CASES.heldOut, candidateVersion.text, runsPerCase, (d, t) => setProgress(d, t, "Held-out — candidate prompt"));
      const candHOAgg = aggregateResults(candHORows);
      candidateVersion.heldOutDelta = candHOAgg.accuracy.mean - liveHOAgg.accuracy.mean;
      renderHeldOutPanel(candidateVersion.trainingDelta, candidateVersion.heldOutDelta, liveHOAgg, candHOAgg);

      statusEl.textContent = "Step 5 of 5 — awaiting human decision at the promotion gate.";
      progressEl.style.display = "none";
      renderPromotionPanel(candidateVersion, liveVersion, { isRollback: false });
      document.getElementById("promotionPanel").scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      statusEl.className = "status-line err";
      statusEl.textContent = "Error: " + err.message;
      progressEl.style.display = "none";
    }
    btn.disabled = false;
  }

  // ---------------------------------------------------------------------
  // Judgment layer
  // ---------------------------------------------------------------------
  function renderJudgmentTable() {
    const rows = [
      {
        rule: "An error state must always offer the user a next step.",
        assertion: "When the intent mentions an error state: assert components_used includes Button or Alert.",
        compiled: true,
      },
      { rule: "Destructive actions must always require a confirmation step.", assertion: "not yet compiled", compiled: false },
      { rule: "Tables with more than one page of data must be paginated.", assertion: "not yet compiled", compiled: false },
    ];
    document.getElementById("judgmentTable").innerHTML = rows
      .map(
        (r) =>
          `<tr><td>${Utils.escapeHtml(r.rule)}</td><td>${Utils.escapeHtml(r.assertion)}</td><td>${
            r.compiled ? '<span class="pill good">COMPILED — active in instruction-following</span>' : '<span class="stub-badge">Not yet compiled</span>'
          }</td></tr>`
      )
      .join("");
  }

  // ---------------------------------------------------------------------
  // Review queue (stub)
  // ---------------------------------------------------------------------
  function renderReviewQueue() {
    const el = document.getElementById("reviewQueue");
    const samples = AppState.generationHistory.slice(-3).reverse();
    if (!samples.length) {
      el.innerHTML = '<div class="empty-state">No generations yet to sample. Run a request on the Generate screen — in production this panel samples ~3 real generations weekly.</div>';
      return;
    }
    el.innerHTML = samples
      .map((s) => {
        const label = Profiles.DEFAULTS[s.profileKey].label;
        const current = AppState.judgmentRatings[s.id] || 0;
        const stars = [1, 2, 3, 4, 5].map((n) => `<span data-rate="${s.id}" data-n="${n}" class="${n <= current ? "active" : ""}">&#9733;</span>`).join("");
        return `<div class="panel" style="background:var(--panel-2); margin-bottom:10px;">
          <div style="font-size:12.5px; margin-bottom:6px;"><span class="chip">${label}</span>${Utils.escapeHtml(s.request.intent)}</div>
          <div class="rawjson open" style="max-height:120px;">${Utils.escapeHtml(JSON.stringify(s.result, null, 2))}</div>
          <div class="rating-stars" style="margin-top:8px;">${stars}</div>
        </div>`;
      })
      .join("");
    el.querySelectorAll("[data-rate]").forEach((star) => {
      star.onclick = () => {
        AppState.judgmentRatings[star.getAttribute("data-rate")] = parseInt(star.getAttribute("data-n"), 10);
        renderReviewQueue();
      };
    });
  }

  // ---------------------------------------------------------------------
  // Settings screen
  // ---------------------------------------------------------------------
  function updateConnDot() {
    const dot = document.getElementById("connDot");
    const label = document.getElementById("connLabel");
    dot.className = "conn-dot " + (AppState.settings.connectionOk ? "ok" : AppState.settings.apiKey ? "bad" : "");
    label.textContent = AppState.settings.connectionOk ? AppState.settings.model : AppState.settings.apiKey ? "not verified" : "not connected";
  }

  async function testConnection() {
    const btn = document.getElementById("testConnBtn");
    const status = document.getElementById("cfgStatus");
    btn.disabled = true;
    status.className = "status-line";
    status.textContent = "Calling provider through the relay...";
    try {
      const res = await window.ProviderAdapter.testConnection(AppState.settings);
      AppState.settings.connectionOk = true;
      status.className = "status-line ok";
      status.textContent = `Connected — ${res.latencyMs}ms round trip. Response: "${(res.text || "(empty)").slice(0, 80)}"`;
    } catch (err) {
      AppState.settings.connectionOk = false;
      status.className = "status-line err";
      status.textContent = "Connection failed: " + err.message;
    }
    updateConnDot();
    btn.disabled = false;
  }

  function initSettingsUI() {
    const s = AppState.settings;
    document.getElementById("cfgBaseUrl").value = s.baseUrl;
    document.getElementById("cfgModel").value = s.model;
    document.getElementById("tempConformist").value = s.temperatures.CONFORMIST;
    document.getElementById("tempExplorer").value = s.temperatures.EXPLORER;
    document.getElementById("tempSprinter").value = s.temperatures.SPRINTER;
    document.getElementById("cfgRunsPerCase").value = s.runsPerCase;

    document.getElementById("cfgBaseUrl").oninput = (e) => (s.baseUrl = e.target.value.trim());
    document.getElementById("cfgModel").oninput = (e) => (s.model = e.target.value.trim());
    document.getElementById("cfgApiKey").oninput = (e) => {
      s.apiKey = e.target.value;
      s.connectionOk = false;
      updateConnDot();
    };
    document.getElementById("tempConformist").oninput = (e) => (s.temperatures.CONFORMIST = parseFloat(e.target.value) || 0);
    document.getElementById("tempExplorer").oninput = (e) => (s.temperatures.EXPLORER = parseFloat(e.target.value) || 0);
    document.getElementById("tempSprinter").oninput = (e) => (s.temperatures.SPRINTER = parseFloat(e.target.value) || 0);
    document.getElementById("cfgRunsPerCase").oninput = (e) => (s.runsPerCase = Math.max(1, parseInt(e.target.value, 10) || 3));
    document.getElementById("testConnBtn").onclick = testConnection;
  }

  // ---------------------------------------------------------------------
  // Session export / import
  // ---------------------------------------------------------------------
  function exportSession() {
    const clone = JSON.parse(JSON.stringify(AppState));
    clone.settings.apiKey = "";
    clone.settings.connectionOk = false;
    const blob = new Blob([JSON.stringify(clone, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `design-agent-session-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById("sessionStatus").className = "status-line ok";
    document.getElementById("sessionStatus").textContent = "Session exported.";
  }

  function importSessionFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const keepKey = AppState.settings.apiKey;
        Object.assign(AppState, data);
        AppState.settings.apiKey = keepKey;
        AppState.settings.connectionOk = false;
        initSettingsUI();
        updateConnDot();
        renderAll();
        document.getElementById("sessionStatus").className = "status-line ok";
        document.getElementById("sessionStatus").textContent = "Session imported.";
      } catch (err) {
        document.getElementById("sessionStatus").className = "status-line err";
        document.getElementById("sessionStatus").textContent = "Import failed: " + err.message;
      }
    };
    reader.readAsText(file);
  }

  function initSessionUI() {
    document.getElementById("exportBtn").onclick = exportSession;
    document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
    document.getElementById("importFile").onchange = (e) => {
      if (e.target.files[0]) importSessionFile(e.target.files[0]);
      e.target.value = "";
    };
  }

  // ---------------------------------------------------------------------
  // Tabs + init
  // ---------------------------------------------------------------------
  function initTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("screen-" + tab.dataset.screen).classList.add("active");
        if (tab.dataset.screen === "review") renderReviewQueue();
        if (tab.dataset.screen === "optimization") {
          renderLivePrompt();
          renderHistory();
        }
      });
    });
  }

  function renderAll() {
    renderDsSummary();
    renderJudgmentTable();
    renderLivePrompt();
    renderHistory();
    renderCorrectionLog();
    renderGenerationResults();
    renderReviewQueue();
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initSettingsUI();
    initGenerateScreenEvents();
    initSessionUI();
    updateConnDot();
    renderAll();
    document.getElementById("runIterationBtn").addEventListener("click", runIteration);
  });
})();
