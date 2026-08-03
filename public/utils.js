// Small shared helpers used across the app.
window.Utils = (function () {
  function stripFences(text) {
    if (!text) return "";
    let t = text.trim();
    t = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "");
    return t.trim();
  }

  function tryParseJson(text) {
    const cleaned = stripFences(text);
    try {
      return { ok: true, value: JSON.parse(cleaned), cleaned };
    } catch (err) {
      return { ok: false, error: err.message, cleaned };
    }
  }

  function mean(nums) {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  function range(nums) {
    if (!nums.length) return null;
    return { min: Math.min(...nums), max: Math.max(...nums) };
  }
  function round1(n) {
    return n === null || n === undefined ? null : Math.round(n * 10) / 10;
  }

  function uid(prefix) {
    return `${prefix || "id"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // Minimal line-level diff for the prompt promotion-gate viewer. Not a general
  // diff algorithm — good enough for comparing two short system prompts line by line.
  function lineDiff(oldText, newText) {
    const a = (oldText || "").split("\n");
    const b = (newText || "").split("\n");
    const max = Math.max(a.length, b.length);
    const rows = [];
    for (let i = 0; i < max; i++) {
      const oldLine = a[i];
      const newLine = b[i];
      if (oldLine === newLine) rows.push({ type: "same", text: oldLine ?? "" });
      else {
        if (oldLine !== undefined) rows.push({ type: "removed", text: oldLine });
        if (newLine !== undefined) rows.push({ type: "added", text: newLine });
      }
    }
    return rows;
  }

  // Runs `items` through `fn` with a concurrency cap, reporting progress via onProgress(done, total).
  async function mapWithConcurrency(items, concurrency, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  return { stripFences, tryParseJson, mean, range, round1, uid, nowIso, lineDiff, mapWithConcurrency, escapeHtml };
})();
