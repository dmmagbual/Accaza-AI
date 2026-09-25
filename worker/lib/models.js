"use strict";
// Model calls for laptop tasks. One call = one agent step: the model sees the whole task so far
// and either calls tools or gives its final answer. Calls are not streamed (progress is shown per
// step instead), and each step falls back through the chain below if a provider fails:
//   Gemini (strong) -> Gemini (lite) -> DeepSeek -> Cerebras
// Model names come from functions/lib/providers.js so the chat and the worker stay in step.
//
// Transcript format (provider-neutral, saved to disk after every step so a task can resume):
//   {role: "user", text}
//   {role: "assistant", text, calls: [{id, name, args}], gemini?: [raw parts]}
//   {role: "tool", results: [{id, name, result}]}
const AI = require("./deps").AI();

const STEP_TIMEOUT_MS = 180000;
const COOL_DOWN_MS = 5 * 60 * 1000;
// Gemini 3 checks "thought signatures" on function calls. Calls made by another provider (after a
// fallback) have none, so they carry Google's documented placeholder instead.
const SKIP_SIGNATURE = "skip_thought_signature_validator";

function failure(message, status) { const e = new Error(message); e.providerFailure = true; e.status = status || 0; return e; }
function toolResultText(result) { return typeof result === "string" ? result : JSON.stringify(result === undefined ? {ok: true} : result); }

// ---------- Gemini ----------
function geminiContents(transcript) {
  return transcript.map(m => {
    if (m.role === "user") return {role: "user", parts: [{text: m.text || " "}]};
    if (m.role === "tool") return {role: "user", parts: m.results.map(r => ({functionResponse: {name: r.name, response: r.result && typeof r.result === "object" && !Array.isArray(r.result) ? r.result : {result: r.result}}}))};
    if (Array.isArray(m.gemini) && m.gemini.length) return {role: "model", parts: m.gemini};
    const parts = [];
    if (m.text) parts.push({text: m.text});
    (m.calls || []).forEach((c, i) => parts.push(Object.assign({functionCall: {name: c.name, args: c.args || {}}}, i === 0 ? {thoughtSignature: SKIP_SIGNATURE} : {})));
    return {role: "model", parts: parts.length ? parts : [{text: " "}]};
  });
}
async function geminiStep({key, model, thinkingLevel, system, transcript, tools, signal, fetchImpl = fetch}) {
  const generationConfig = {temperature: 0.3, maxOutputTokens: 32768};
  if (thinkingLevel) generationConfig.thinkingConfig = {thinkingLevel};
  const body = {systemInstruction: {parts: [{text: system}]}, contents: geminiContents(transcript), generationConfig};
  if (tools.length) body.tools = [{functionDeclarations: tools}];
  const response = await fetchImpl(`${AI.ENDPOINTS.gemini}/v1beta/models/${model}:generateContent`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, body: JSON.stringify(body), signal});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(`Gemini ${model}: ${(data.error && data.error.message || `HTTP ${response.status}`).slice(0, 200)}`, response.status);
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  if (!parts.length) throw failure(`Gemini ${model} returned nothing (${cand && cand.finishReason || "no candidate"}).`);
  const calls = [], texts = [];
  parts.forEach((p, i) => {
    if (p.functionCall) calls.push({id: `g${Date.now().toString(36)}_${i}`, name: p.functionCall.name, args: p.functionCall.args || {}});
    else if (p.text && !p.thought) texts.push(p.text);
  });
  return {text: texts.join("").trim(), calls, gemini: parts, usage: data.usageMetadata || null};
}

// ---------- OpenAI-compatible (DeepSeek, Cerebras) ----------
function openAiMessages(system, transcript) {
  const out = [{role: "system", content: system}];
  for (const m of transcript) {
    if (m.role === "user") out.push({role: "user", content: m.text || " "});
    else if (m.role === "assistant") {
      const msg = {role: "assistant", content: m.text || ""};
      if ((m.calls || []).length) msg.tool_calls = m.calls.map(c => ({id: c.id, type: "function", function: {name: c.name, arguments: JSON.stringify(c.args || {})}}));
      out.push(msg);
    } else if (m.role === "tool") m.results.forEach(r => out.push({role: "tool", tool_call_id: r.id, content: toolResultText(r.result)}));
  }
  return out;
}
async function openAiStep({provider, key, system, transcript, tools, signal, fetchImpl = fetch}) {
  const body = Object.assign({model: provider.model, messages: openAiMessages(system, transcript), temperature: 0.3, max_tokens: 8000}, provider.extra || {});
  if (tools.length) { body.tools = tools.map(d => ({type: "function", function: {name: d.name, description: d.description, parameters: d.parameters}})); body.tool_choice = "auto"; }
  const response = await fetchImpl(provider.url, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${key}`}, body: JSON.stringify(body), signal});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(`${provider.label}: ${(data.error && (data.error.message || data.error) || `HTTP ${response.status}`).toString().slice(0, 200)}`, response.status);
  const msg = data.choices && data.choices[0] && data.choices[0].message || {};
  const calls = (msg.tool_calls || []).filter(c => c && c.function && c.function.name).map((c, i) => {
    let args = {};
    try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments || {}; } catch (_error) { args = {__invalid: String(c.function.arguments).slice(0, 200)}; }
    return {id: c.id || `c${Date.now().toString(36)}_${i}`, name: c.function.name, args};
  });
  const text = String(msg.content || "").trim();
  if (!text && !calls.length) throw failure(`${provider.label} returned nothing.`);
  return {text, calls, usage: data.usage || null};
}

// Old tool results are shortened once the transcript gets long, so a 40-step task stays inside
// every provider's context window. The most recent results are kept whole.
function compact(transcript, maxChars = 240000, keepRecent = 6) {
  let total = JSON.stringify(transcript).length;
  if (total <= maxChars) return transcript;
  const out = transcript.map(m => m);
  const toolIdx = out.map((m, i) => m.role === "tool" ? i : -1).filter(i => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))) {
    const m = out[i];
    out[i] = {role: "tool", results: m.results.map(r => { const t = toolResultText(r.result); return t.length > 600 ? Object.assign({}, r, {result: {shortened: true, start: t.slice(0, 600)}}) : r; })};
    total = JSON.stringify(out).length;
    if (total <= maxChars) break;
  }
  return out;
}

class ModelChain {
  // keys: {gemini, deepseek, cerebras}
  constructor(keys, {fetchImpl = fetch, now = () => Date.now()} = {}) {
    this.keys = keys; this.fetchImpl = fetchImpl; this.now = now; this.coolUntil = {};
    const G = AI.GEMINI;
    this.providers = [
      {name: "gemini", group: "gemini", label: `Gemini (${G.strong.model})`, enabled: () => Boolean(keys.gemini), step: a => geminiStep(Object.assign({key: keys.gemini, model: G.strong.model, thinkingLevel: G.strong.thinkingLevel}, a))},
      {name: "gemini-lite", group: "gemini", label: `Gemini (${G.standard.model})`, enabled: () => Boolean(keys.gemini), step: a => geminiStep(Object.assign({key: keys.gemini, model: G.standard.model, thinkingLevel: null}, a))},
      {name: "deepseek", label: "DeepSeek", enabled: () => Boolean(keys.deepseek), step: a => openAiStep(Object.assign({provider: AI.DEEPSEEK, key: keys.deepseek}, a))},
      {name: "cerebras", label: "Cerebras", enabled: () => Boolean(keys.cerebras), step: a => openAiStep(Object.assign({provider: AI.CEREBRAS, key: keys.cerebras}, a))},
    ];
  }
  // Returns {provider, text, calls, gemini?}. Throws when every provider failed or on abort.
  async step({system, transcript, tools, signal}) {
    const failures = [], shortened = compact(transcript);
    for (const p of this.providers) {
      if (!p.enabled() || (this.coolUntil[p.name] || 0) > this.now()) continue;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, {once: true});
      try {
        const out = await p.step({system, transcript: shortened, tools, signal: controller.signal, fetchImpl: this.fetchImpl});
        return Object.assign({provider: p.name, failures}, out);
      } catch (error) {
        if (signal && signal.aborted) throw Object.assign(new Error("Stopped."), {stopped: true});
        const reason = controller.signal.aborted ? `${p.label} took longer than ${STEP_TIMEOUT_MS / 1000} s.` : String(error && error.message || error).slice(0, 240);
        failures.push({provider: p.name, reason});
        // Quota and server errors rest this model for a while instead of retrying every step; a
        // rejected key (401/403) rests every model that uses it.
        if (error && [429, 500, 502, 503].includes(error.status)) this.coolUntil[p.name] = this.now() + COOL_DOWN_MS;
        if (error && [401, 403].includes(error.status)) this.providers.filter(q => q.name === p.name || (p.group && q.group === p.group)).forEach(q => { this.coolUntil[q.name] = this.now() + COOL_DOWN_MS; });
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }
    const e = new Error(`No AI model could continue the task: ${failures.map(f => f.reason).join(" | ") || "none configured"}`);
    e.failures = failures;
    throw e;
  }
}

module.exports = {ModelChain, geminiContents, openAiMessages, geminiStep, openAiStep, compact, SKIP_SIGNATURE, toolResultText};
