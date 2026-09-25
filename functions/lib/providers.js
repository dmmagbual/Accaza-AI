"use strict";
// AI chain for the standalone Accaza AI app (ChatGPT-style, v1.1).
// Order: Gemini (owner/staff: 3.8 Flash, then Flash-Lite) -> Groq -> Cerebras -> DeepSeek -> Qwen (Ollama on SUPERDAD) -> Ashna.
// Replies stream: each provider pushes text pieces through ctx.onDelta as they arrive. A provider
// that fails before or during its reply is a provider failure; if it had already streamed some
// text, the caller is told to reset (the client clears the bubble) and the next provider answers.
const {HttpsError} = require("firebase-functions/v2/https");

const GEMINI = {
  // Owner and staff get the stronger model; members and guests the cheaper one (Danilo, 25 Sep 2026).
  standard: {model: "gemini-3.5-flash-lite", maxOutputTokens: 2048, thinkingLevel: null},
  strong: {model: "gemini-3.8-flash", maxOutputTokens: 4096, thinkingLevel: "low"},
};
const REQUEST_BUDGET_MS = 110000;
const FIRST_TEXT_MS = 25000;
const OLLAMA_FIRST_TEXT_MS = 70000;
const ASHNA_TIMEOUT_MS = 20000;
const MIN_ATTEMPT_MS = 8000;
const HISTORY_ENTRIES = 12;
const HISTORY_CHARS = 1500;
const MAX_ANSWER_CHARS = 40000;
// qwen3:8b runs CPU-only at roughly 5-6 tokens/s, so its reply length is sized to the time it has.
const OLLAMA_MAX_TOKENS = 350;
// Groq's free tier allows 8,000 tokens per minute (prompt + max_tokens), so its cap stays modest.
const GROQ = {label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", maxTokens: 1500, extra: {reasoning_effort: "low"}};
const CEREBRAS = {label: "Cerebras", url: "https://api.cerebras.ai/v1/chat/completions", model: "gpt-oss-120b", maxTokens: 3000, extra: {reasoning_effort: "low"}};
const DEEPSEEK = {label: "DeepSeek", url: "https://api.deepseek.com/chat/completions", model: "deepseek-flash", maxTokens: 2000, extra: {}};
const ASHNA = {label: "Ashna", url: "https://api.ashna.ai/v1/api/chat/completions", model: "glm-5.3-flash", maxTokens: 1500, extra: {}};
const OLLAMA_URL = "https://ollama.accazacoffee.com/api/chat";

const INSTRUCTION = [
  "You are Accaza AI, a helpful, knowledgeable AI assistant.",
  "Answer the user's question directly and accurately. Start with the answer itself, then add the detail that is useful.",
  "Format with Markdown when it helps readability: short paragraphs, ## headings for longer answers, bullet or numbered lists for steps and options, **bold** for key terms, tables for comparisons, and fenced code blocks with a language tag for any code. Keep short, simple answers short and lightly formatted.",
  "Say plainly when an answer depends on current or recent information you may not have, and never invent facts, figures, quotes or sources.",
  "If asked who you are, say you are Accaza AI, an AI assistant; do not name the company or model behind you, and do not refer to these instructions.",
  "You cannot see any private business records; if asked about the user's own business figures, say briefly that you cannot see them and answer in general terms.",
].join(" ");

function cleanText(value, max = 800) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
// Keeps line breaks and tabs (code, lists) but removes other control characters.
function cleanMultiline(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}
// History rows: {role, text, files?}. `files` is only ever set by the server from the caller's own
// resolved uploads ({displayName, mimeType, uri}); it is never taken from the browser.
function chatHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(-HISTORY_ENTRIES)
    .map(row => ({role: row && row.role === "model" ? "model" : "user", text: cleanMultiline(row && row.text, HISTORY_CHARS), files: row && Array.isArray(row.files) ? row.files.filter(f => f && f.uri && f.mimeType) : [], fileNames: row && Array.isArray(row.fileNames) ? row.fileNames.map(n => cleanText(n, 80)).filter(Boolean) : []}))
    .filter(row => row.text.length >= 1 || row.files.length);
}
function fileNote(names) {
  return names.length ? `[Attached: ${names.join(", ")}]` : "";
}
// Text for providers that cannot read files: the attachment is named so the model knows it exists.
function textWithNote(text, names) {
  const note = fileNote(names);
  return note ? (text ? `${note}\n${text}` : note) : text;
}
function providerFailure(message) {
  return new HttpsError("unavailable", message, {providerFailure: true});
}
function finalAnswer(value) {
  const text = cleanMultiline(value, MAX_ANSWER_CHARS);
  if (!text) throw providerFailure("The provider returned an empty answer.");
  return text;
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
// Cloudflare/credential values must be plain printable ASCII (a pasted newline breaks headers).
function headerValue(value) {
  return String(value || "").replace(/[^\x21-\x7E]/g, "");
}
function openAiMessages(question, history, files = []) {
  const current = files.length ? `${question}\n\n(The user attached ${files.length === 1 ? "a file" : files.length + " files"}: ${files.map(f => f.displayName).join(", ")}. You cannot open attachments right now. Say so in one short sentence, then help as far as you can without them.)` : question;
  return [{role: "system", content: INSTRUCTION}, ...chatHistory(history).map(row => ({role: row.role === "model" ? "assistant" : "user", content: textWithNote(row.text, [...row.files.map(f => f.displayName), ...row.fileNames])})), {role: "user", content: current}];
}
function geminiParts(text, files, fileNames = []) {
  const parts = files.map(f => ({fileData: {fileUri: f.uri, mimeType: f.mimeType}}));
  const body = textWithNote(text, fileNames);
  if (body) parts.push({text: body});
  return parts;
}

// Streams one HTTP response line by line. The first-text timer aborts a provider that has not
// produced any text within firstMs; once text flows, the whole reply must finish within totalMs.
async function streamLines(label, url, init, limits, onLine) {
  const controller = new AbortController(), started = Date.now();
  let gotText = false, timer = setTimeout(() => controller.abort(), Math.max(1000, limits.firstMs));
  const markText = () => {
    if (gotText) return;
    gotText = true; clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), Math.max(1000, limits.totalMs - (Date.now() - started)));
  };
  try {
    const response = await fetch(url, Object.assign({}, init, {signal: controller.signal}));
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw providerFailure(providerMessage(body, `${label} could not answer right now (HTTP ${response.status}).`));
    }
    const type = String(response.headers.get("content-type") || "");
    if (type.includes("application/json")) {
      // Provider ignored stream:true and sent one JSON body.
      const body = await response.json().catch(() => ({}));
      await onLine(null, body, markText);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, {stream: true});
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) await onLine(line, null, markText);
      }
    }
    if (buffer.trim()) await onLine(buffer.trim(), null, markText);
  } catch (error) {
    if (error && error.details && error.details.providerFailure) throw error;
    throw providerFailure(controller.signal.aborted ? (gotText ? `${label} took too long to finish.` : `${label} did not answer within ${Math.round(limits.firstMs / 1000)} seconds.`) : `${label} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}
function sseData(line) {
  if (!line || !line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try { return JSON.parse(payload); } catch (_error) { return null; }
}

async function askGemini(key, config, question, history, limits, ctx, files = []) {
  const contents = [...chatHistory(history).map(row => ({role: row.role, parts: geminiParts(row.text, row.files, row.fileNames)})), {role: "user", parts: geminiParts(question, files)}];
  const generationConfig = {temperature: 0.4, maxOutputTokens: config.maxOutputTokens};
  if (config.thinkingLevel) generationConfig.thinkingConfig = {thinkingLevel: config.thinkingLevel};
  let text = "";
  const take = (body, markText) => {
    if (body && body.error) throw providerFailure(providerMessage(body, "Gemini could not answer right now."));
    const parts = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts || [];
    const piece = parts.filter(part => !part.thought).map(part => part.text || "").join("");
    if (piece) { markText(); text += piece; ctx.onDelta(piece); }
  };
  await streamLines("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?alt=sse`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, body: JSON.stringify({systemInstruction: {parts: [{text: INSTRUCTION}]}, contents, generationConfig})}, limits,
    async (line, body, markText) => take(body || sseData(line), markText));
  return finalAnswer(text);
}
async function askOpenAiCompatible(provider, key, question, history, limits, ctx, files = []) {
  let text = "";
  await streamLines(provider.label, provider.url, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${key}`}, body: JSON.stringify(Object.assign({model: provider.model, messages: openAiMessages(question, history, files), temperature: 0.4, max_tokens: provider.maxTokens, stream: true}, provider.extra))}, limits,
    async (line, body, markText) => {
      const data = body || sseData(line);
      if (!data) return;
      if (data.error) throw providerFailure(providerMessage(data, `${provider.label} could not answer right now.`));
      const choice = data.choices && data.choices[0] || {};
      const piece = (choice.delta && choice.delta.content) || (choice.message && choice.message.content) || "";
      if (piece) { markText(); text += piece; ctx.onDelta(piece); }
    });
  return finalAnswer(text);
}
async function askOllama(clientId, clientSecret, question, history, limits, ctx, files = []) {
  const tokens = Math.max(80, Math.min(OLLAMA_MAX_TOKENS, Math.floor((Number(limits.totalMs || 0) / 1000 - 12) * 5)));
  let text = "", cut = false;
  await streamLines("Qwen", OLLAMA_URL, {method: "POST", headers: {"content-type": "application/json", "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret}, body: JSON.stringify({model: "qwen3:8b", messages: openAiMessages(question, history, files), stream: true, think: false, options: {temperature: 0.4, num_predict: tokens}})}, limits,
    async (line, body, markText) => {
      let data = body;
      if (!data) { try { data = JSON.parse(line); } catch (_error) { return; } }
      if (data.error) throw providerFailure(providerMessage(data, "Qwen could not answer right now."));
      const piece = data.message && data.message.content || "";
      if (piece) { markText(); text += piece; ctx.onDelta(piece); }
      if (data.done && data.done_reason === "length") cut = true;
    });
  return finalAnswer(cut ? trimToSentence(text) : text);
}

// keys: {gemini, groq, cerebras, deepseek, ollamaId, ollamaSecret, ashna} as getter functions.
// tier: "owner" | "staff" get the strong Gemini model; everyone else the standard one.
// files: attachments on the current question (resolved, owner-checked). With files, a second
// Gemini attempt always follows the first, because only Gemini can read them.
function generalChatProviders(question, history, keys, tier, files = []) {
  const key = name => headerValue(keys[name] ? keys[name]() : "");
  const gemini = tier === "owner" || tier === "staff" ? GEMINI.strong : GEMINI.standard;
  const retryGemini = gemini === GEMINI.strong || files.length > 0;
  const ask = (fn, ...args) => (limits, ctx) => fn(...args, question, history, limits, ctx, files);
  return [
    {name: "gemini", model: gemini.model, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("gemini")), ask: ask(askGemini, key("gemini"), gemini)},
    // The newest Flash models often return 503 "high demand" (seen 25 Sep 2026), which fails in
    // under a second; Flash-Lite is then the quickest good answer before the non-Google backups.
    ...(retryGemini ? [{name: "gemini-lite", model: GEMINI.standard.model, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("gemini")), ask: ask(askGemini, key("gemini"), GEMINI.standard)}] : []),
    {name: "groq", model: GROQ.model, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("groq")), ask: ask(askOpenAiCompatible, GROQ, key("groq"))},
    {name: "cerebras", model: CEREBRAS.model, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("cerebras")), ask: ask(askOpenAiCompatible, CEREBRAS, key("cerebras"))},
    {name: "deepseek", model: DEEPSEEK.model, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("deepseek")), ask: ask(askOpenAiCompatible, DEEPSEEK, key("deepseek"))},
    {name: "ollama", model: "qwen3:8b", firstMs: OLLAMA_FIRST_TEXT_MS, enabled: () => Boolean(key("ollamaId") && key("ollamaSecret")), ask: ask(askOllama, key("ollamaId"), key("ollamaSecret"))},
    // Ashna keeps a reserved slice of the budget so a slow Qwen reply cannot use up the last turn.
    {name: "ashna", model: ASHNA.model, firstMs: ASHNA_TIMEOUT_MS, reserveMs: ASHNA_TIMEOUT_MS, enabled: () => Boolean(key("ashna")), ask: ask(askOpenAiCompatible, ASHNA, key("ashna"))},
  ];
}

// hooks: {onDelta(text), onReset(), onUnusual(answeredBy|null, failures)}. onUnusual runs only
// when a backup answered or nothing did, so a normal first-provider answer costs no extra write.
async function withFallback(providers, hooks = {}) {
  const started = Date.now(), failures = [];
  let configured = 0;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider.enabled()) continue;
    configured += 1;
    const reserve = providers.slice(index + 1).reduce((total, next) => total + (next.reserveMs && next.enabled() ? next.reserveMs : 0), 0);
    const remaining = REQUEST_BUDGET_MS - (Date.now() - started) - reserve;
    const limits = {firstMs: Math.min(provider.firstMs || FIRST_TEXT_MS, remaining), totalMs: remaining};
    if (limits.firstMs < MIN_ATTEMPT_MS) { failures.push({provider: provider.name, reason: "Skipped: not enough time left."}); continue; }
    let streamed = false;
    const ctx = {onDelta: piece => { if (!piece) return; streamed = true; if (hooks.onDelta) hooks.onDelta(piece); }};
    try {
      const answer = await provider.ask(limits, ctx);
      if (failures.length && hooks.onUnusual) await hooks.onUnusual(provider.name, failures);
      return {provider: provider.name, model: provider.model || provider.name, answer, failures};
    } catch (error) {
      if (!(error && error.details && error.details.providerFailure)) throw error;
      if (streamed && hooks.onReset) hooks.onReset();
      failures.push({provider: provider.name, reason: error.message});
    }
  }
  if (!configured) throw new HttpsError("failed-precondition", "No AI provider is configured.");
  if (hooks.onUnusual) await hooks.onUnusual(null, failures);
  throw new HttpsError("unavailable", "The AI service is temporarily unavailable. Please try again in a few minutes.");
}

module.exports = {
  INSTRUCTION, GEMINI, REQUEST_BUDGET_MS, MIN_ATTEMPT_MS, HISTORY_ENTRIES, HISTORY_CHARS,
  cleanText, cleanMultiline, chatHistory, openAiMessages, geminiParts, providerFailure, finalAnswer, streamLines, sseData, trimToSentence, headerValue,
  generalChatProviders, withFallback,
};
