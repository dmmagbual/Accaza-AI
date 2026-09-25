"use strict";
// Memory (Danilo, 26 Sep 2026): like ChatGPT's memory, for registered users only.
// users/{uid}/settings/profile  {aboutMe, replyStyle, useMemory, learn, updatedAt}
// users/{uid}/memories/{id}     {text, createdAt, updatedAt, source: "auto"|"manual", chatId?}
// After each reply a small Flash-Lite call looks ONLY at that exchange and the current memory list
// and proposes add/update/remove. "remember that…" / "forget…" work even when learning is off.
// Card, bank and ID numbers, passwords/PINs and health details are never stored: the extraction
// prompt forbids them and isSensitive() drops anything that slips through.
const {HttpsError} = require("firebase-functions/v2/https");

const MAX_MEMORIES = 50;
const MAX_MEMORY_CHARS = 200;
const MAX_PROFILE_CHARS = 1500;
const EXTRACT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_SETTINGS = {aboutMe: "", replyStyle: "", useMemory: true, learn: true};

function cleanLine(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function cleanBlock(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}
const SENSITIVE_WORDS = /\b(password|passcode|passwd|pin code|\bpin\b|cvv|cvc|otp|one-time code|secret key|api key|seed phrase|sss|tin number|passport (?:no|number)|driver'?s licen[cs]e (?:no|number)|diagnos\w*|medication|prescri\w*|illness|disease|disorder|pregnan\w*|therapy|therapist|depress\w*|anxiety|hiv|cancer|diabet\w*|surgery|mental health)\b/i;
// True when a proposed memory must not be stored.
function isSensitive(text) {
  const value = String(text || "");
  if (SENSITIVE_WORDS.test(value)) return true;
  // Any run of 9+ digits (card, bank, ID or phone numbers) stays out of memory.
  const runs = value.match(/(?:\d[ -]?){9,}/g) || [];
  return runs.some(run => run.replace(/\D/g, "").length >= 9);
}
const EXPLICIT = /\b(remember|don'?t forget|forget|stop remembering|no longer)\b/i;

async function loadSettings(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("settings").doc("profile").get();
  return Object.assign({}, DEFAULT_SETTINGS, snap.exists ? snap.data() : {});
}
async function saveSettings(db, uid, data, now) {
  const patch = {updatedAt: now};
  if (data.aboutMe !== undefined) patch.aboutMe = cleanBlock(data.aboutMe, MAX_PROFILE_CHARS);
  if (data.replyStyle !== undefined) patch.replyStyle = cleanBlock(data.replyStyle, MAX_PROFILE_CHARS);
  if (data.useMemory !== undefined) patch.useMemory = data.useMemory === true;
  if (data.learn !== undefined) patch.learn = data.learn === true;
  await db.collection("users").doc(uid).collection("settings").doc("profile").set(patch, {merge: true});
  return loadSettings(db, uid);
}
async function listMemories(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("memories").orderBy("updatedAt", "desc").limit(MAX_MEMORIES + 20).get();
  return snap.docs.map(doc => ({id: doc.id, text: doc.data().text || "", source: doc.data().source || "auto", updatedAt: doc.data().updatedAt || 0}));
}
async function addMemory(db, uid, text, now, source = "manual", chatId = null) {
  const clean = cleanLine(text, MAX_MEMORY_CHARS);
  if (!clean) throw new HttpsError("invalid-argument", "Type something to remember.");
  if (isSensitive(clean)) throw new HttpsError("invalid-argument", "For your safety, card or ID numbers, passwords and health details are not saved to memory.");
  const ref = db.collection("users").doc(uid).collection("memories").doc();
  await ref.set({text: clean, createdAt: now, updatedAt: now, source, chatId});
  await enforceCap(db, uid);
  return {id: ref.id, text: clean};
}
async function deleteMemory(db, uid, id) {
  if (!/^[A-Za-z0-9]{1,40}$/.test(String(id || ""))) throw new HttpsError("invalid-argument", "That memory was not found.");
  await db.collection("users").doc(uid).collection("memories").doc(String(id)).delete();
  return {deleted: id};
}
async function deleteAllMemories(db, uid) {
  await db.recursiveDelete(db.collection("users").doc(uid).collection("memories"));
  return {deletedAll: true};
}
async function enforceCap(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("memories").orderBy("updatedAt", "desc").get();
  const extra = snap.docs.slice(MAX_MEMORIES);
  await Promise.all(extra.map(doc => doc.ref.delete()));
}

// The block added to the AI's instructions. User-written text is labelled as such so it is used
// as preference/context, never as instructions that override safety or honesty.
function personalBlock(settings, memories) {
  const parts = [];
  if (settings.aboutMe) parts.push(`About the user (written by the user; treat as context):\n"""\n${settings.aboutMe}\n"""`);
  if (settings.replyStyle) parts.push(`How the user wants replies (their preference; follow it unless it conflicts with accuracy or safety):\n"""\n${settings.replyStyle}\n"""`);
  if (settings.useMemory !== false && memories.length) parts.push(`Things you remember about the user from earlier chats (use only when relevant; do not list them unless asked what you remember):\n${memories.slice(0, MAX_MEMORIES).map(m => `- ${m.text}`).join("\n")}`);
  return parts.join("\n\n");
}

const EXTRACT_SYSTEM = [
  "You maintain a short list of durable facts and preferences about ONE user of a chat assistant, so future chats feel personal.",
  "You see the current memory list (with ids) and ONE new exchange. Decide what to change. Return JSON only: {\"add\": [string], \"update\": [{\"id\": string, \"text\": string}], \"remove\": [string]}.",
  "Save only what the USER stated about themselves, their work, goals, projects, people they mention by role, or how they want answers. Never save facts about the assistant, one-off tasks, questions, or things that expire soon.",
  "Each memory is one short third-person sentence under 150 characters, e.g. \"Runs a coffee shop in Sartoga\" or \"Prefers prices in PHP\".",
  "If the user explicitly says to remember something, add it. If they say to forget or that something is no longer true, remove or update the matching memory.",
  "Prefer updating an existing memory over adding a near-duplicate.",
  "NEVER save: card, bank or ID numbers; passwords, PINs or codes; health, medical or mental-health details; sexual matters; religion or politics; crimes; anything about children's ages. If asked to remember such things, do not.",
  "If nothing should change, return {\"add\": [], \"update\": [], \"remove\": []}.",
].join(" ");

// Returns {added:[{id,text}], updated:[{id,text}], removed:[id]} (all empty when nothing changed).
async function learnFromTurn({db, uid, settings, memories, question, answer, chatId, key, now, extract}) {
  const none = {added: [], updated: [], removed: []};
  const explicit = EXPLICIT.test(question || "");
  if (!explicit && (settings.learn === false || settings.useMemory === false)) return none;
  const list = memories.map(m => ({id: m.id, text: m.text}));
  const prompt = `CURRENT MEMORIES:\n${JSON.stringify(list)}\n\nNEW EXCHANGE:\nUser: ${String(question || "").slice(0, 3000)}\nAssistant: ${String(answer || "").slice(0, 1500)}`;
  const plan = await extract(key, EXTRACT_MODEL, EXTRACT_SYSTEM, prompt);
  if (!plan || typeof plan !== "object") return none;
  const known = new Set(list.map(m => m.id)), out = {added: [], updated: [], removed: []};
  const col = db.collection("users").doc(uid).collection("memories");
  for (const id of (Array.isArray(plan.remove) ? plan.remove : []).slice(0, 10)) {
    if (!known.has(String(id))) continue;
    await col.doc(String(id)).delete(); out.removed.push(String(id));
  }
  for (const row of (Array.isArray(plan.update) ? plan.update : []).slice(0, 10)) {
    const id = String(row && row.id || ""), text = cleanLine(row && row.text, MAX_MEMORY_CHARS);
    if (!known.has(id) || !text || isSensitive(text) || out.removed.includes(id)) continue;
    await col.doc(id).set({text, updatedAt: now}, {merge: true}); out.updated.push({id, text});
  }
  const existing = new Set(list.map(m => m.text.toLowerCase()));
  for (const raw of (Array.isArray(plan.add) ? plan.add : []).slice(0, 5)) {
    const text = cleanLine(raw, MAX_MEMORY_CHARS);
    if (!text || isSensitive(text) || existing.has(text.toLowerCase())) continue;
    const ref = col.doc();
    await ref.set({text, createdAt: now, updatedAt: now, source: explicit ? "chat" : "auto", chatId: chatId || null});
    existing.add(text.toLowerCase()); out.added.push({id: ref.id, text});
  }
  if (out.added.length) await enforceCap(db, uid);
  return out;
}

module.exports = {MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_PROFILE_CHARS, DEFAULT_SETTINGS, EXTRACT_MODEL, isSensitive, loadSettings, saveSettings, listMemories, addMemory, deleteMemory, deleteAllMemories, personalBlock, learnFromTurn, EXPLICIT};
