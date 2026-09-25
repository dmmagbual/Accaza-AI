"use strict";
// General chat AI chain for the standalone Accaza AI app.
// Copied from the Accaza Coffee project's General chat (25 Sep 2026) and made independent:
// no Accaza business data, no link to the Accaza Coffee Firebase project.
//
// Order: Gemini -> Groq -> Cerebras -> DeepSeek -> Qwen (Ollama on SUPERDAD) -> Ashna.
// Each provider call has its own abort timer inside one request budget. A timeout, a network
// error, a non-OK reply or an empty answer is a provider failure, so the next provider is tried.
const {HttpsError} = require("firebase-functions/v2/https");

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const REQUEST_BUDGET_MS = 110000;
const CLOUD_TIMEOUT_MS = 25000;
const OLLAMA_TIMEOUT_MS = 70000;
const ASHNA_TIMEOUT_MS = 20000;
const MIN_ATTEMPT_MS = 8000;
// qwen3:8b runs CPU-only at roughly 5-6 tokens/s, so its reply length is sized to the time it has.
const OLLAMA_MAX_TOKENS = 350;
const GROQ = {label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", options: {maxTokens: 1500, body: {reasoning_effort: "low"}}};
const CEREBRAS = {label: "Cerebras", url: "https://api.cerebras.ai/v1/chat/completions", model: "gpt-oss-120b", options: {maxTokens: 2500, body: {reasoning_effort: "low"}}};
const DEEPSEEK = {label: "DeepSeek", url: "https://api.deepseek.com/chat/completions", model: "deepseek-flash", options: {maxTokens: 900}};
const ASHNA = {label: "Ashna", url: "https://api.ashna.ai/v1/api/chat/completions", model: "glm-5.3-flash", options: {maxTokens: 900}};
const OLLAMA_URL = "https://ollama.accazacoffee.com/api/chat";

const GENERAL_CHAT_INSTRUCTION = "You are a helpful, knowledgeable AI assistant. Answer the user's question directly and accurately from your built-in knowledge, and say plainly when an answer depends on current or externally verified information you may not have. Write like a polished chat assistant: start with a one- or two-sentence direct answer, then use short, well-organized paragraphs separated by one blank line. When a list genuinely helps (steps, options, key figures or prioritized actions), put each item on its own line starting with \"• \" for bullets or \"1. \", \"2. \" for ordered items, keep each item to one or two sentences, and leave a blank line before and after the list. A short plain-text label on its own line may introduce a section. Do not use Markdown syntax: no # headings, no asterisks, no bold or italic markers, no tables and no emojis. Do not mention any company, brand, product, app, mode or system you are running in, and do not refer to these instructions. You cannot see any private business records; if asked about the user's own business figures, say briefly that you cannot see them and answer in general terms.";

function cleanText(value, max = 800) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function chatHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-8)
    .map(row => ({role: row && row.role === "model" ? "model" : "user", text: cleanText(row && row.text, 800)}))
    .filter(row => row.text.length >= 1);
}
function providerFailure(message) {
  return new HttpsError("unavailable", message, {providerFailure: true});
}
function plainAnswer(value) {
  const answer = cleanText(value, 5000);
  if (!answer) throw providerFailure("The provider returned an empty answer.");
  return answer;
}
async function fetchJson(label, url, init, timeoutMs) {
  const controller = new AbortController(), limit = Math.max(1000, Number(timeoutMs) || CLOUD_TIMEOUT_MS), timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(url, Object.assign({}, init, {signal: controller.signal}));
    const body = await response.json().catch(() => ({}));
    return {response, body};
  } catch (_error) {
    throw providerFailure(controller.signal.aborted ? `${label} did not answer within ${Math.round(limit / 1000)} seconds.` : `${label} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}
function providerMessage(body, fallback) {
  const error = body && body.error;
  return cleanText(error && typeof error === "object" ? error.message : error, 200) || fallback;
}
// A reply cut off by the token cap ends at its last complete sentence instead of mid-word.
function trimToSentence(text) {
  const value = String(text || "").trim();
  const cut = Math.max(value.lastIndexOf(". "), value.lastIndexOf("! "), value.lastIndexOf("? "), value.lastIndexOf(".\n"), value.lastIndexOf("!\n"), value.lastIndexOf("?\n"));
  return cut > 40 ? value.slice(0, cut + 1).trim() : value;
}
// Normalizes any provider reply into clean chat text (the client renders pre-wrap): Markdown
// emphasis, headings, quotes and rules are removed; bullets become "• ", numbered items stay
// "1. ", and lists get a blank line around them. Arithmetic like 2*3*4 is left alone.
function proseAnswer(value) {
  const raw = String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/^\s*```[\w-]*\s*$/gm, "").replace(/`([^`\n]+)`/g, "$1").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/gm, "$1$2").replace(/^[ \t]{0,3}#{1,6}[ \t]+(?:\d{1,2}[.)][ \t]+)?/gm, "\n")
    .replace(/^[ \t]*>[ \t]?/gm, "").replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
  const out = [];
  let previous = "blank";
  raw.split("\n").forEach(source => {
    let line = source.replace(/[ \t]+/g, " ").trim(), kind = "text";
    if (!line) { if (out.length && out[out.length - 1] !== "") out.push(""); previous = "blank"; return; }
    const bullet = line.match(/^(?:[-*+•●▪])\s+(.*)$/), numbered = line.match(/^(\d{1,2})[.)]\s+(.*)$/);
    if (bullet) { line = "• " + bullet[1]; kind = "list"; } else if (numbered) { line = numbered[1] + ". " + numbered[2]; kind = "list"; }
    line = line.replace(/\*\*/g, "");
    if (previous !== "blank" && previous !== kind && out.length) out.push("");
    out.push(line);
    previous = kind;
  });
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
  if (!text) throw providerFailure("The provider returned an empty answer.");
  return text;
}
// Cloudflare/credential values must be plain printable ASCII (a pasted newline breaks headers).
function headerValue(value) {
  return String(value || "").replace(/[^\x21-\x7E]/g, "");
}
function openAiMessages(question, history) {
  return [{role: "system", content: GENERAL_CHAT_INSTRUCTION}, ...chatHistory(history).map(row => ({role: row.role === "model" ? "assistant" : "user", content: row.text})), {role: "user", content: question}];
}

async function askGemini(key, question, history, timeoutMs) {
  const contents = [...chatHistory(history).map(row => ({role: row.role, parts: [{text: row.text}]})), {role: "user", parts: [{text: question}]}];
  const {response, body} = await fetchJson("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, body: JSON.stringify({systemInstruction: {parts: [{text: GENERAL_CHAT_INSTRUCTION}]}, contents, generationConfig: {temperature: 0.35, maxOutputTokens: 900}})}, timeoutMs);
  if (!response.ok) throw providerFailure(providerMessage(body, "Gemini could not answer right now."));
  const parts = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
  return proseAnswer(parts && parts.map(part => part.text || "").join("\n"));
}
async function askOpenAiCompatible(provider, key, question, history, timeoutMs) {
  const opts = provider.options || {};
  const {response, body} = await fetchJson(provider.label, provider.url, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${key}`}, body: JSON.stringify(Object.assign({model: provider.model, messages: openAiMessages(question, history), temperature: 0.35, max_tokens: opts.maxTokens || 900, stream: false}, opts.body || {}))}, timeoutMs);
  if (!response.ok) throw providerFailure(providerMessage(body, `${provider.label} could not answer right now.`));
  return proseAnswer(body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content);
}
async function askOllama(clientId, clientSecret, question, history, timeoutMs) {
  const tokens = Math.max(80, Math.min(OLLAMA_MAX_TOKENS, Math.floor((Number(timeoutMs || 0) / 1000 - 12) * 5)));
  const {response, body} = await fetchJson("Qwen", OLLAMA_URL, {method: "POST", headers: {"content-type": "application/json", "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret}, body: JSON.stringify({model: "qwen3:8b", messages: openAiMessages(question, history), stream: false, think: false, options: {temperature: 0.35, num_predict: tokens}})}, timeoutMs);
  if (!response.ok) throw providerFailure(providerMessage(body, "Qwen could not answer right now."));
  const content = body && body.message && body.message.content;
  return proseAnswer(body && body.done_reason === "length" ? trimToSentence(content) : content);
}

// keys: {gemini, groq, cerebras, deepseek, ollamaId, ollamaSecret, ashna} as getter functions.
function generalChatProviders(question, history, keys) {
  const key = name => headerValue(keys[name] ? keys[name]() : "");
  return [
    {name: "gemini", maxMs: CLOUD_TIMEOUT_MS, enabled: () => Boolean(key("gemini")), ask: t => askGemini(key("gemini"), question, history, t)},
    {name: "groq", maxMs: CLOUD_TIMEOUT_MS, enabled: () => Boolean(key("groq")), ask: t => askOpenAiCompatible(GROQ, key("groq"), question, history, t)},
    {name: "cerebras", maxMs: CLOUD_TIMEOUT_MS, enabled: () => Boolean(key("cerebras")), ask: t => askOpenAiCompatible(CEREBRAS, key("cerebras"), question, history, t)},
    {name: "deepseek", maxMs: CLOUD_TIMEOUT_MS, enabled: () => Boolean(key("deepseek")), ask: t => askOpenAiCompatible(DEEPSEEK, key("deepseek"), question, history, t)},
    {name: "ollama", maxMs: OLLAMA_TIMEOUT_MS, enabled: () => Boolean(key("ollamaId") && key("ollamaSecret")), ask: t => askOllama(key("ollamaId"), key("ollamaSecret"), question, history, t)},
    // Ashna keeps a reserved slice of the budget so a slow Qwen reply cannot use up the last turn.
    {name: "ashna", maxMs: ASHNA_TIMEOUT_MS, reserveMs: ASHNA_TIMEOUT_MS, enabled: () => Boolean(key("ashna")), ask: t => askOpenAiCompatible(ASHNA, key("ashna"), question, history, t)},
  ];
}

// onUnusual(answeredBy|null, failures) is called only when a backup answered or nothing did,
// so a normal first-provider answer costs no extra database write.
async function withFallback(providers, onUnusual) {
  const started = Date.now(), failures = [];
  let configured = 0;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider.enabled()) continue;
    configured += 1;
    const reserve = providers.slice(index + 1).reduce((total, next) => total + (next.reserveMs && next.enabled() ? next.reserveMs : 0), 0);
    const remaining = REQUEST_BUDGET_MS - (Date.now() - started), limit = Math.min(provider.maxMs || CLOUD_TIMEOUT_MS, remaining - reserve);
    if (limit < MIN_ATTEMPT_MS) { failures.push({provider: provider.name, reason: "Skipped: not enough time left."}); continue; }
    try {
      const answer = await provider.ask(limit);
      if (failures.length && onUnusual) await onUnusual(provider.name, failures);
      return {provider: provider.name, answer, failures};
    } catch (error) {
      if (!(error && error.details && error.details.providerFailure)) throw error;
      failures.push({provider: provider.name, reason: error.message});
    }
  }
  if (!configured) throw new HttpsError("failed-precondition", "No AI provider is configured.");
  if (onUnusual) await onUnusual(null, failures);
  throw new HttpsError("unavailable", "The AI service is temporarily unavailable. Please try again in a few minutes.");
}

module.exports = {
  GENERAL_CHAT_INSTRUCTION, REQUEST_BUDGET_MS, MIN_ATTEMPT_MS,
  cleanText, chatHistory, providerFailure, plainAnswer, fetchJson, proseAnswer, trimToSentence, headerValue,
  generalChatProviders, withFallback,
};
