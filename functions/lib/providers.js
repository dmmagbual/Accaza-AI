"use strict";
// AI chain for the standalone Accaza AI app (ChatGPT-style, v1.3: memory, tools).
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
// Canvas mode (building pages/apps): long outputs, and a function call with a whole page as its
// argument only arrives when it is finished, so the first-output wait and total budget are longer.
const BIG_BUDGET_MS = 280000;
const BIG_FIRST_MS = 180000;
const HISTORY_ENTRIES = 12;
const HISTORY_CHARS = 1500;
const MAX_ANSWER_CHARS = 40000;
// qwen3:8b runs CPU-only at roughly 5-6 tokens/s, so its reply length is sized to the time it has.
const OLLAMA_MAX_TOKENS = 350;
// Groq's free tier allows 8,000 tokens per minute (prompt + max_tokens), so its cap stays modest.
const GROQ = {label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", maxTokens: 1500, bigTokens: 1500, extra: {reasoning_effort: "low"}};
const CEREBRAS = {label: "Cerebras", url: "https://api.cerebras.ai/v1/chat/completions", model: "gpt-oss-120b", maxTokens: 3000, extra: {reasoning_effort: "low"}};
const DEEPSEEK = {label: "DeepSeek", url: "https://api.deepseek.com/chat/completions", model: "deepseek-flash", maxTokens: 2000, extra: {}};
const ASHNA = {label: "Ashna", url: "https://api.ashna.ai/v1/api/chat/completions", model: "glm-5.3-flash", maxTokens: 1500, extra: {}};
const OLLAMA_URL = "https://ollama.accazacoffee.com/api/chat";
// Base URL for Gemini calls (tests point this at a local server).
const ENDPOINTS = {gemini: "https://generativelanguage.googleapis.com"};

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
// System text = the base instruction plus per-request blocks (personalisation, memories, skill
// catalogue, tool guidance). Blocks written by users are fenced and labelled as user data.
function systemText(extra) {
  return extra ? `${INSTRUCTION}\n\n${extra}` : INSTRUCTION;
}
function openAiMessages(question, history, files = [], system = "") {
  const current = files.length ? `${question}\n\n(The user attached ${files.length === 1 ? "a file" : files.length + " files"}: ${files.map(f => f.displayName).join(", ")}. You cannot open attachments right now. Say so in one short sentence, then help as far as you can without them.)` : question;
  return [{role: "system", content: systemText(system)}, ...chatHistory(history).map(row => ({role: row.role === "model" ? "assistant" : "user", content: textWithNote(row.text, [...row.files.map(f => f.displayName), ...row.fileNames])})), {role: "user", content: current}];
}
function geminiParts(text, files, fileNames = []) {
  const parts = files.map(f => ({fileData: {fileUri: f.uri, mimeType: f.mimeType}}));
  const body = textWithNote(text, fileNames);
  if (body) parts.push({text: body});
  return parts;
}

// Streams one HTTP response line by line. The first-text timer aborts a provider that has not
// produced anything within firstMs; once output flows, the whole call must finish within totalMs.
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

// ---------- Tools ----------
// req.tools = {declarations: [{name, description, parameters}], run: async (name, args, ctx) => object}
// The model may call tools for up to MAX_TOOL_ROUNDS rounds (MAX_TOOL_CALLS each); the last round
// has tools switched off so it must answer. Results are capped so one tool cannot flood the prompt.
const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS = 4;
const MAX_TOOL_RESULT_CHARS = 12000;
function roundLimits(started, totalMs, firstMs) {
  const remaining = totalMs - (Date.now() - started);
  if (remaining < 3000) throw providerFailure("Ran out of time while using tools.");
  return {firstMs: Math.min(firstMs, remaining), totalMs: remaining};
}
async function runTool(tools, name, args, ctx) {
  const declared = tools && tools.declarations.find(d => d.name === name);
  if (!declared) return {error: `Unknown tool ${String(name).slice(0, 40)}.`};
  if (ctx.onEvent) ctx.onEvent({type: "tool", name, status: "running", args});
  let result;
  try { result = await tools.run(name, args && typeof args === "object" ? args : {}, ctx); }
  catch (error) { result = {error: String(error && error.message || "The tool failed.").slice(0, 300)}; }
  if (ctx.onEvent) ctx.onEvent({type: "tool", name, status: result && result.error ? "failed" : "done", args});
  const text = JSON.stringify(result === undefined ? {ok: true} : result);
  return text.length > MAX_TOOL_RESULT_CHARS ? {truncated: true, partial: text.slice(0, MAX_TOOL_RESULT_CHARS)} : result;
}
function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch (_error) { return {}; }
}

async function askGemini(key, config, req, limits, ctx) {
  const started = Date.now(), total = limits.totalMs;
  const contents = [...chatHistory(req.history).map(row => ({role: row.role, parts: geminiParts(row.text, row.files, row.fileNames)})), {role: "user", parts: geminiParts(req.question, req.files || [])}];
  const generationConfig = {temperature: 0.4, maxOutputTokens: req.big ? Math.max(config.maxOutputTokens, 32768) : config.maxOutputTokens};
  if (config.thinkingLevel) generationConfig.thinkingConfig = {thinkingLevel: config.thinkingLevel};
  const tools = req.tools && req.tools.declarations.length ? [{functionDeclarations: req.tools.declarations}] : null;
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const final = round === MAX_TOOL_ROUNDS || !tools, parts = [], calls = [];
    const body = {systemInstruction: {parts: [{text: systemText(req.system)}]}, contents, generationConfig};
    if (tools && !final) body.tools = tools;
    if (tools && final) body.toolConfig = {functionCallingConfig: {mode: "NONE"}};
    if (tools && final) body.tools = tools;
    const lim = round === 0 ? limits : roundLimits(started, total, req.big ? BIG_FIRST_MS : FIRST_TEXT_MS);
    await streamLines("Gemini", `${ENDPOINTS.gemini}/v1beta/models/${config.model}:streamGenerateContent?alt=sse`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, body: JSON.stringify(body)}, lim,
      async (line, json, markText) => {
        const data = json || sseData(line);
        if (!data) return;
        if (data.error) throw providerFailure(providerMessage(data, "Gemini could not answer right now."));
        for (const part of (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []) {
          parts.push(part);
          if (part.functionCall) { markText(); calls.push(part.functionCall); }
          else if (part.text && !part.thought) { markText(); text += part.text; ctx.onDelta(part.text); }
        }
      });
    if (!calls.length) return finalAnswer(text);
    // Keep the model's parts verbatim (thought signatures must go back unchanged).
    contents.push({role: "model", parts});
    const results = await Promise.all(calls.map((call, i) => i < MAX_TOOL_CALLS ? runTool(req.tools, call.name, parseArgs(call.args), ctx) : Promise.resolve({error: "Too many tool calls in one step."})));
    contents.push({role: "user", parts: calls.map((call, i) => ({functionResponse: {name: call.name, response: results[i] && typeof results[i] === "object" && !Array.isArray(results[i]) ? results[i] : {result: results[i]}}}))});
  }
  return finalAnswer(text);
}

async function askOpenAiCompatible(provider, key, req, limits, ctx) {
  const started = Date.now(), total = limits.totalMs;
  const messages = openAiMessages(req.question, req.history, req.files || [], req.system);
  const tools = provider.tools !== false && req.tools && req.tools.declarations.length ? req.tools.declarations.map(d => ({type: "function", function: {name: d.name, description: d.description, parameters: d.parameters}})) : null;
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const final = round === MAX_TOOL_ROUNDS || !tools, calls = [];
    let roundText = "";
    const body = Object.assign({model: provider.model, messages, temperature: 0.4, max_tokens: req.big ? Math.max(provider.maxTokens, provider.bigTokens || 8000) : provider.maxTokens, stream: true}, provider.extra);
    if (tools) { body.tools = tools; body.tool_choice = final ? "none" : "auto"; }
    const lim = round === 0 ? limits : roundLimits(started, total, req.big ? BIG_FIRST_MS : FIRST_TEXT_MS);
    await streamLines(provider.label, provider.url, {method: "POST", headers: {"content-type": "application/json", authorization: `Bearer ${key}`}, body: JSON.stringify(body)}, lim,
      async (line, json, markText) => {
        const data = json || sseData(line);
        if (!data) return;
        if (data.error) throw providerFailure(providerMessage(data, `${provider.label} could not answer right now.`));
        const choice = data.choices && data.choices[0] || {};
        const delta = choice.delta || choice.message || {};
        if (delta.content) { markText(); text += delta.content; roundText += delta.content; ctx.onDelta(delta.content); }
        for (const tc of delta.tool_calls || []) {
          markText();
          const index = Number.isInteger(tc.index) ? tc.index : calls.length;
          const call = calls[index] || (calls[index] = {id: "", name: "", arguments: ""});
          if (tc.id) call.id = tc.id;
          if (tc.function && tc.function.name) call.name += tc.function.name;
          if (tc.function && tc.function.arguments) call.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        }
      });
    const real = calls.filter(c => c && c.name);
    if (!real.length) return finalAnswer(text);
    real.forEach((c, i) => { if (!c.id) c.id = `call_${round}_${i}`; });
    messages.push({role: "assistant", content: roundText || "", tool_calls: real.map(c => ({id: c.id, type: "function", function: {name: c.name, arguments: c.arguments || "{}"}}))});
    const results = await Promise.all(real.map((c, i) => i < MAX_TOOL_CALLS ? runTool(req.tools, c.name, parseArgs(c.arguments), ctx) : Promise.resolve({error: "Too many tool calls in one step."})));
    real.forEach((c, i) => messages.push({role: "tool", tool_call_id: c.id, content: JSON.stringify(results[i])}));
  }
  return finalAnswer(text);
}

// Anthropic Messages API (for owner-added Claude models), streaming with tool use.
async function askAnthropic(provider, key, req, limits, ctx) {
  const started = Date.now(), total = limits.totalMs;
  const merged = [];
  for (const row of chatHistory(req.history)) {
    const role = row.role === "model" ? "assistant" : "user", text = textWithNote(row.text, [...row.files.map(f => f.displayName), ...row.fileNames]);
    if (!merged.length && role === "assistant") continue;
    if (merged.length && merged[merged.length - 1].role === role) merged[merged.length - 1].content += `\n\n${text}`;
    else merged.push({role, content: text});
  }
  const files = req.files || [];
  const current = files.length ? `${req.question}\n\n(The user attached ${files.map(f => f.displayName).join(", ")}, which you cannot open. Say so briefly.)` : req.question;
  if (merged.length && merged[merged.length - 1].role === "user") merged[merged.length - 1].content += `\n\n${current}`; else merged.push({role: "user", content: current});
  const messages = merged.map(m => ({role: m.role, content: [{type: "text", text: m.content}]}));
  const tools = provider.tools !== false && req.tools && req.tools.declarations.length ? req.tools.declarations.map(d => ({name: d.name, description: d.description, input_schema: d.parameters || {type: "object", properties: {}}})) : null;
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const final = round === MAX_TOOL_ROUNDS || !tools, blocks = [];
    const body = {model: provider.model, max_tokens: req.big ? 16000 : provider.maxTokens || 4000, system: systemText(req.system), messages, stream: true, temperature: 0.4};
    if (tools) { body.tools = tools; body.tool_choice = final ? {type: "none"} : {type: "auto"}; }
    const lim = round === 0 ? limits : roundLimits(started, total, req.big ? BIG_FIRST_MS : FIRST_TEXT_MS);
    await streamLines(provider.label, provider.url, {method: "POST", headers: {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"}, body: JSON.stringify(body)}, lim,
      async (line, json, markText) => {
        const data = json || sseData(line);
        if (!data) return;
        if (data.type === "error" || data.error) throw providerFailure(providerMessage(data, `${provider.label} could not answer right now.`));
        if (data.type === "content_block_start") { blocks[data.index] = Object.assign({}, data.content_block, data.content_block.type === "tool_use" ? {json: ""} : {text: ""}); markText(); }
        if (data.type === "content_block_delta" && blocks[data.index]) {
          markText();
          if (data.delta.type === "text_delta") { blocks[data.index].text += data.delta.text; text += data.delta.text; ctx.onDelta(data.delta.text); }
          if (data.delta.type === "input_json_delta") blocks[data.index].json += data.delta.partial_json || "";
        }
        if (json && Array.isArray(json.content)) json.content.forEach(b => { if (b.type === "text" && b.text) { text += b.text; ctx.onDelta(b.text); } });
      });
    const uses = blocks.filter(b => b && b.type === "tool_use");
    if (!uses.length) return finalAnswer(text);
    messages.push({role: "assistant", content: blocks.filter(Boolean).map(b => b.type === "tool_use" ? {type: "tool_use", id: b.id, name: b.name, input: parseArgs(b.json)} : {type: "text", text: b.text || " "})});
    const results = await Promise.all(uses.map((b, i) => i < MAX_TOOL_CALLS ? runTool(req.tools, b.name, parseArgs(b.json), ctx) : Promise.resolve({error: "Too many tool calls in one step."})));
    messages.push({role: "user", content: uses.map((b, i) => ({type: "tool_result", tool_use_id: b.id, content: JSON.stringify(results[i])}))});
  }
  return finalAnswer(text);
}

async function askOllama(clientId, clientSecret, req, limits, ctx) {
  const tokens = Math.max(80, Math.min(OLLAMA_MAX_TOKENS, Math.floor((Number(limits.totalMs || 0) / 1000 - 12) * 5)));
  let text = "", cut = false;
  await streamLines("Qwen", OLLAMA_URL, {method: "POST", headers: {"content-type": "application/json", "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret}, body: JSON.stringify({model: "qwen3:8b", messages: openAiMessages(req.question, req.history, req.files || [], noToolsSystem(req)), stream: true, think: false, options: {temperature: 0.4, num_predict: tokens}})}, limits,
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
// Providers without tools still get the request's system blocks, plus a note that tools are off.
function noToolsSystem(req) {
  if (!req.tools || !req.tools.declarations.length) return req.system || "";
  return `${req.system || ""}\n\nTools (web search, skills, connected apps) are not available right now. If the question needs them, say so briefly and answer as well as you can.`.trim();
}

// Built-in providers by id (the ids the model menu uses). files = can read attachments,
// tools = can use web search / skills / connectors.
const BUILTIN_IDS = ["gemini", "gemini-lite", "groq", "cerebras", "deepseek", "ollama", "ashna"];
function builtinProvider(id, req) {
  const keys = req.keys || {}, key = name => headerValue(keys[name] ? keys[name]() : "");
  const noTools = Object.assign({}, req, {tools: null, system: noToolsSystem(req)});
  switch (id) {
    case "gemini": return {name: "gemini", model: GEMINI.strong.model, files: true, tools: true, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("gemini")), ask: (l, c) => askGemini(key("gemini"), GEMINI.strong, req, l, c)};
    case "gemini-lite": return {name: "gemini-lite", model: GEMINI.standard.model, files: true, tools: true, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("gemini")), ask: (l, c) => askGemini(key("gemini"), GEMINI.standard, req, l, c)};
    case "groq": return {name: "groq", model: GROQ.model, files: false, tools: true, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("groq")), ask: (l, c) => askOpenAiCompatible(GROQ, key("groq"), req, l, c)};
    case "cerebras": return {name: "cerebras", model: CEREBRAS.model, files: false, tools: true, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("cerebras")), ask: (l, c) => askOpenAiCompatible(CEREBRAS, key("cerebras"), req, l, c)};
    case "deepseek": return {name: "deepseek", model: DEEPSEEK.model, files: false, tools: true, firstMs: FIRST_TEXT_MS, enabled: () => Boolean(key("deepseek")), ask: (l, c) => askOpenAiCompatible(DEEPSEEK, key("deepseek"), req, l, c)};
    case "ollama": return {name: "ollama", model: "qwen3:8b", files: false, tools: false, firstMs: OLLAMA_FIRST_TEXT_MS, enabled: () => Boolean(key("ollamaId") && key("ollamaSecret")), ask: (l, c) => askOllama(key("ollamaId"), key("ollamaSecret"), req, l, c)};
    // Ashna keeps a reserved slice of the budget so a slow Qwen reply cannot use up the last turn.
    case "ashna": return {name: "ashna", model: ASHNA.model, files: false, tools: false, firstMs: ASHNA_TIMEOUT_MS, reserveMs: ASHNA_TIMEOUT_MS, enabled: () => Boolean(key("ashna")), ask: (l, c) => askOpenAiCompatible(Object.assign({}, ASHNA, {tools: false}), key("ashna"), noTools, l, c)};
    default: return null;
  }
}

// req: {question, history, keys, tier, files?, system?, tools?, chosen?}. "Auto" order: Gemini
// (owner/staff: 3.8 Flash, then Flash-Lite) -> Groq -> Cerebras -> DeepSeek -> Qwen -> Ashna. With
// files, a second Gemini attempt always follows the first, because only Gemini can read them.
// req.chosen (a provider object from the model menu) goes first, unless files are attached and
// it cannot read them; the rest of the Auto chain stays behind it as the fallback.
function generalChatProviders(req) {
  const files = req.files || [];
  const strong = req.tier === "owner" || req.tier === "staff";
  const first = builtinProvider(strong ? "gemini" : "gemini-lite", req);
  const auto = [
    Object.assign({}, first, {name: "gemini"}),
    ...(strong || files.length ? [builtinProvider("gemini-lite", req)] : []),
    ...["groq", "cerebras", "deepseek", "ollama", "ashna"].map(id => builtinProvider(id, req)),
  ];
  if (req.big) auto.forEach(p => { if (p.name !== "ollama" && p.name !== "ashna") p.firstMs = BIG_FIRST_MS; });
  const chosen = req.chosen;
  if (chosen && req.big) chosen.firstMs = BIG_FIRST_MS;
  if (chosen && (chosen.files || !files.length)) {
    const same = p => p.name === chosen.name || (BUILTIN_IDS.includes(chosen.name) && p.model === chosen.model);
    return [chosen, ...auto.filter(p => !same(p))];
  }
  return auto;
}

// hooks: {onDelta(text), onReset(), onEvent(event), onUnusual(answeredBy|null, failures)}.
async function withFallback(providers, hooks = {}) {
  const started = Date.now(), failures = [], budget = hooks.budgetMs || REQUEST_BUDGET_MS;
  let configured = 0;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (!provider.enabled()) continue;
    configured += 1;
    const reserve = providers.slice(index + 1).reduce((total, next) => total + (next.reserveMs && next.enabled() ? next.reserveMs : 0), 0);
    const remaining = budget - (Date.now() - started) - reserve;
    const limits = {firstMs: Math.min(provider.firstMs || FIRST_TEXT_MS, remaining), totalMs: remaining};
    if (limits.firstMs < MIN_ATTEMPT_MS) { failures.push({provider: provider.name, reason: "Skipped: not enough time left."}); continue; }
    let streamed = false;
    const ctx = {
      provider: provider.name,
      onDelta: piece => { if (!piece) return; streamed = true; if (hooks.onDelta) hooks.onDelta(piece); },
      onEvent: event => { if (hooks.onEvent) hooks.onEvent(event); },
    };
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

// One-shot JSON call to Gemini (no streaming, no fallback) for small helper jobs such as memory
// extraction. Returns null on any failure: helpers must never break a chat.
async function geminiJson(key, model, system, prompt, timeoutMs = 8000, fetchImpl = fetch) {
  if (!key) return null;
  try {
    const response = await fetchImpl(`${ENDPOINTS.gemini}/v1beta/models/${model}:generateContent`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({systemInstruction: {parts: [{text: system}]}, contents: [{role: "user", parts: [{text: prompt}]}], generationConfig: {temperature: 0, maxOutputTokens: 800, responseMimeType: "application/json"}})});
    if (!response.ok) return null;
    const body = await response.json();
    const text = ((body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || []).map(p => p.text || "").join("");
    return JSON.parse(text);
  } catch (_error) { return null; }
}

module.exports = {
  ENDPOINTS, INSTRUCTION, GEMINI, REQUEST_BUDGET_MS, BIG_BUDGET_MS, MIN_ATTEMPT_MS, HISTORY_ENTRIES, HISTORY_CHARS, MAX_TOOL_ROUNDS, MAX_TOOL_CALLS,
  cleanText, cleanMultiline, chatHistory, openAiMessages, geminiParts, systemText, providerFailure, finalAnswer, streamLines, sseData, trimToSentence, headerValue,
  BUILTIN_IDS, askGemini, askOpenAiCompatible, askAnthropic, noToolsSystem, builtinProvider, generalChatProviders, withFallback, geminiJson,
};
