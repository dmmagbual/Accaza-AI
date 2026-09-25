"use strict";
// Model menu and owner-added models (Danilo, 26 Sep 2026).
// Built-in models: owner/staff may pick any; members/guests the low-cost ones.
// Added models: the owner pastes an API key for a provider (OpenAI-compatible, Anthropic or
// Gemini). The key is stored AES-256-GCM encrypted in models/{id} (never returned to any
// browser), the model is tested before it is saved, and each has an audience and optional daily cap.
// models/{id} {label, provider, format, baseUrl, model, keyEnc, audience: owner|staff|everyone, dailyCap, tools, files, enabled, createdAt, updatedAt}
const {HttpsError} = require("firebase-functions/v2/https");
const {encrypt, decrypt} = require("./crypto");
const {assertPublicUrl} = require("./netguard");
const AI = require("./providers");

const BUILTINS = [
  {id: "gemini", label: "Gemini 3.8 Flash", note: "Smartest · reads files", files: true, tools: true, tiers: ["owner", "staff"]},
  {id: "gemini-lite", label: "Gemini Flash-Lite", note: "Fast · reads files", files: true, tools: true, tiers: ["owner", "staff", "member", "guest"]},
  {id: "groq", label: "Groq · GPT-OSS 120B", note: "Very fast", files: false, tools: true, tiers: ["owner", "staff", "member", "guest"]},
  {id: "cerebras", label: "Cerebras · GPT-OSS 120B", note: "Very fast", files: false, tools: true, tiers: ["owner", "staff", "member", "guest"]},
  {id: "deepseek", label: "DeepSeek", note: "Good at reasoning", files: false, tools: true, tiers: ["owner", "staff", "member", "guest"]},
  {id: "ollama", label: "Qwen 3 (Accaza PC)", note: "Private · slow · PC must be on", files: false, tools: false, tiers: ["owner", "staff"]},
  {id: "ashna", label: "Ashna · GLM", note: "Last-resort backup", files: false, tools: false, tiers: ["owner", "staff"]},
];
const PROVIDERS = {
  openai: {label: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1"},
  openrouter: {label: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1"},
  anthropic: {label: "Anthropic (Claude)", format: "anthropic", baseUrl: "https://api.anthropic.com/v1"},
  gemini: {label: "Google Gemini", format: "gemini", baseUrl: "https://generativelanguage.googleapis.com"},
  mistral: {label: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1"},
  xai: {label: "xAI (Grok)", format: "openai", baseUrl: "https://api.x.ai/v1"},
  together: {label: "Together AI", format: "openai", baseUrl: "https://api.together.xyz/v1"},
  fireworks: {label: "Fireworks", format: "openai", baseUrl: "https://api.fireworks.ai/inference/v1"},
  groq: {label: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1"},
  deepseek: {label: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com"},
  cerebras: {label: "Cerebras", format: "openai", baseUrl: "https://api.cerebras.ai/v1"},
  custom: {label: "Custom (OpenAI-compatible)", format: "openai", baseUrl: ""},
};
const AUDIENCES = {owner: ["owner"], staff: ["owner", "staff"], everyone: ["owner", "staff", "member", "guest"]};

function cleanLine(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

// Builds a provider object (same shape as the built-ins) for an added model.
function customProvider(doc, id, tokenKey, req) {
  const key = decrypt(doc.keyEnc, tokenKey);
  const reqForModel = doc.tools === false ? Object.assign({}, req, {tools: null, system: AI.noToolsSystem(req)}) : req;
  const name = `custom:${id}`, label = doc.label;
  const guard = async () => { if (doc.format !== "gemini") await assertPublicUrl(doc.baseUrl); };
  const base = String(doc.baseUrl || "").replace(/\/+$/, "");
  let ask;
  if (doc.format === "anthropic") ask = async (l, c) => { await guard(); return AI.askAnthropic({label, url: `${base}/messages`, model: doc.model, maxTokens: 4000, tools: doc.tools !== false}, key, reqForModel, l, c); };
  else if (doc.format === "gemini") ask = (l, c) => AI.askGemini(key, {model: doc.model, maxOutputTokens: 4096, thinkingLevel: null}, reqForModel, l, c);
  else ask = async (l, c) => { await guard(); return AI.askOpenAiCompatible({label, url: `${base}/chat/completions`, model: doc.model, maxTokens: 4000, extra: {}, tools: doc.tools !== false}, key, reqForModel, l, c); };
  return {name, model: label, files: doc.format === "gemini", tools: doc.tools !== false, firstMs: 30000, enabled: () => Boolean(key), ask};
}

// The menu for one caller.
async function menu(db, tier) {
  const builtins = BUILTINS.filter(m => m.tiers.includes(tier)).map(m => ({id: m.id, label: m.label, note: m.note, files: m.files, tools: m.tools}));
  const snap = await db.collection("models").where("enabled", "==", true).limit(50).get();
  const added = snap.docs.map(d => Object.assign({id: d.id}, d.data())).filter(m => (AUDIENCES[m.audience] || AUDIENCES.owner).includes(tier))
    .map(m => ({id: `custom:${m.id}`, label: m.label, note: `${(PROVIDERS[m.provider] || PROVIDERS.custom).label} · ${m.model}`, files: m.format === "gemini", tools: m.tools !== false, added: true}));
  return [{id: "auto", label: "Auto", note: "Best available, with backups", files: true, tools: true}, ...builtins, ...added];
}

// Resolves the model picked for one message. Returns null for Auto.
async function resolvePick(db, pick, tier, req, tokenKey, day, now) {
  const id = String(pick || "auto");
  if (id === "auto") return null;
  if (!id.startsWith("custom:")) {
    const b = BUILTINS.find(m => m.id === id);
    if (!b) throw new HttpsError("invalid-argument", "Unknown model.");
    if (!b.tiers.includes(tier)) throw new HttpsError("permission-denied", `${b.label} is available to the owner and staff. Choose another model or Auto.`);
    return {provider: AI.builtinProvider(id, req), label: b.label};
  }
  const docId = id.slice(7);
  if (!/^[A-Za-z0-9]{1,40}$/.test(docId)) throw new HttpsError("invalid-argument", "Unknown model.");
  const snap = await db.collection("models").doc(docId).get(), doc = snap.exists ? snap.data() : null;
  if (!doc || doc.enabled !== true || !(AUDIENCES[doc.audience] || AUDIENCES.owner).includes(tier)) throw new HttpsError("not-found", "That model is no longer available. Choose another model.");
  if (Number(doc.dailyCap || 0) > 0) {
    const ref = db.collection("modelUsage").doc(day);
    const ok = await db.runTransaction(async tx => {
      const s = await tx.get(ref), u = s.exists ? s.data() : {}, models = u.models && typeof u.models === "object" ? u.models : {}, used = Number(models[docId] || 0);
      if (used >= Number(doc.dailyCap)) return false;
      tx.set(ref, {updatedAt: now, models: Object.assign({}, models, {[docId]: used + 1})});
      return true;
    });
    if (!ok) throw new HttpsError("resource-exhausted", `${doc.label} has reached its daily limit. Choose another model or Auto.`);
  }
  return {provider: customProvider(doc, docId, tokenKey, req), label: doc.label};
}

// Owner: add or update a model. The key is tested with a one-line message before saving.
async function saveModel(db, data, tokenKey, uid, now, testImpl = testModel, lookup = undefined) {
  const provider = PROVIDERS[data.provider] ? data.provider : null;
  if (!provider) throw new HttpsError("invalid-argument", "Choose a provider.");
  const preset = PROVIDERS[provider];
  const baseUrl = provider === "custom" ? String(data.baseUrl || "").trim().replace(/\/+$/, "") : preset.baseUrl;
  const model = cleanLine(data.model, 120), label = cleanLine(data.label, 60) || `${preset.label} · ${model}`;
  const audience = AUDIENCES[data.audience] ? data.audience : "owner", dailyCap = Math.max(0, Math.min(10000, Math.floor(Number(data.dailyCap) || 0)));
  if (!model) throw new HttpsError("invalid-argument", "Enter the model name, e.g. gpt-5-mini.");
  if (preset.format !== "gemini") {
    if (!/^https:\/\//i.test(baseUrl)) throw new HttpsError("invalid-argument", "The API address must start with https://");
    try { await assertPublicUrl(baseUrl, lookup); } catch (error) { throw new HttpsError("invalid-argument", error.message); }
  }
  const ref = data.modelId ? db.collection("models").doc(String(data.modelId)) : db.collection("models").doc();
  const existing = data.modelId ? await ref.get() : null;
  if (data.modelId && !existing.exists) throw new HttpsError("not-found", "That model was not found.");
  const apiKey = String(data.apiKey || "").trim();
  if (!apiKey && !(existing && existing.exists)) throw new HttpsError("invalid-argument", "Paste the API key.");
  const keyEnc = apiKey ? encrypt(apiKey, tokenKey) : existing.data().keyEnc;
  const doc = {label, provider, format: preset.format, baseUrl, model, keyEnc, audience, dailyCap, tools: data.tools !== false, enabled: true, updatedAt: now};
  const test = await testImpl(doc, tokenKey);
  if (!test.ok) throw new HttpsError("failed-precondition", `Test failed: ${test.error}`);
  await ref.set(Object.assign(existing && existing.exists ? {} : {createdAt: now, createdBy: uid}, doc), {merge: true});
  return {id: ref.id, label, reply: test.reply};
}
async function testModel(doc, tokenKey) {
  try {
    const p = customProvider(doc, "test", tokenKey, {question: "Reply with the single word OK.", history: [], system: ""});
    const reply = await p.ask({firstMs: 25000, totalMs: 30000}, {onDelta: () => {}, onEvent: () => {}});
    return {ok: true, reply: cleanLine(reply, 80)};
  } catch (error) { return {ok: false, error: cleanLine(error && error.message, 200) || "no answer"}; }
}
async function listModels(db) {
  const snap = await db.collection("models").orderBy("createdAt", "desc").limit(50).get();
  return snap.docs.map(d => { const m = d.data(); return {id: d.id, label: m.label, provider: m.provider, providerLabel: (PROVIDERS[m.provider] || PROVIDERS.custom).label, baseUrl: m.provider === "custom" ? m.baseUrl : "", model: m.model, audience: m.audience, dailyCap: m.dailyCap || 0, tools: m.tools !== false, enabled: m.enabled === true}; });
}
async function deleteModel(db, id) {
  if (!/^[A-Za-z0-9]{1,40}$/.test(String(id || ""))) throw new HttpsError("invalid-argument", "That model was not found.");
  await db.collection("models").doc(String(id)).delete();
  return {deleted: id};
}
module.exports = {BUILTINS, PROVIDERS, AUDIENCES, customProvider, menu, resolvePick, saveModel, testModel, listModels, deleteModel};
