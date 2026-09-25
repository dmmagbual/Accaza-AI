"use strict";
// Accaza AI (standalone): general chat only. Firebase project accaza-ai. It has no access to
// the Accaza Coffee project or its data. Browsers never touch Firestore directly (rules deny
// all); every read and write happens here.
const crypto = require("crypto");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {setGlobalOptions} = require("firebase-functions/v2");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const AI = require("./lib/providers");
const Access = require("./lib/access");
const Chats = require("./lib/chats");
const Files = require("./lib/files");
const Memory = require("./lib/memory");

initializeApp();
setGlobalOptions({region: "asia-southeast1", maxInstances: 10});
const RELEASE_VERSION = "1.3";
const QUESTION_CHARS = 4000;

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GROQ_API_KEY = defineSecret("GROQ_API_KEY");
const CEREBRAS_API_KEY = defineSecret("CEREBRAS_API_KEY");
const DEEPSEEK_API_KEY = defineSecret("DEEPSEEK_API_KEY");
const OLLAMA_ACCESS_CLIENT_ID = defineSecret("OLLAMA_ACCESS_CLIENT_ID");
const OLLAMA_ACCESS_CLIENT_SECRET = defineSecret("OLLAMA_ACCESS_CLIENT_SECRET");
const ASHNA_API_KEY = defineSecret("ASHNA_API_KEY");
const AI_SECRETS = [GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, DEEPSEEK_API_KEY, OLLAMA_ACCESS_CLIENT_ID, OLLAMA_ACCESS_CLIENT_SECRET, ASHNA_API_KEY];
const KEYS = {
  gemini: () => GEMINI_API_KEY.value(), groq: () => GROQ_API_KEY.value(), cerebras: () => CEREBRAS_API_KEY.value(), deepseek: () => DEEPSEEK_API_KEY.value(),
  ollamaId: () => OLLAMA_ACCESS_CLIENT_ID.value(), ollamaSecret: () => OLLAMA_ACCESS_CLIENT_SECRET.value(), ashna: () => ASHNA_API_KEY.value(),
};

// Only unusual outcomes are written (a backup answered, or nothing answered).
async function recordProviderHealth(db, surface, answeredBy, failures) {
  const now = Date.now(), event = {at: now, answeredBy: answeredBy || "none", surface, failures: failures.slice(0, 6).map(row => ({provider: row.provider, reason: AI.cleanText(row.reason, 160)}))};
  console.warn(JSON.stringify({event: answeredBy ? "ai_backup_answered" : "ai_all_providers_failed", severity: answeredBy ? "WARNING" : "ERROR", ...event}));
  try {
    const update = {lastEvent: event, updatedAt: now, failedQuestions: FieldValue.increment(answeredBy ? 0 : 1)};
    failures.forEach(row => { update[`providerFailures.${row.provider}`] = FieldValue.increment(1); });
    if (answeredBy) update[`backupAnswers.${answeredBy}`] = FieldValue.increment(1);
    const ref = db.collection("providerHealth").doc(Access.manilaDay(now));
    await ref.set({}, {merge: true});
    await ref.update(update);
  } catch (_error) { /* monitoring must never block or fail an answer */ }
}

// Guests keep their history in the browser; any attachment ids in it are re-checked here so a
// guest can only ever reference their own, unexpired uploads. Missing ones become a text note.
async function guestHistoryWithFiles(db, uid, rows, now) {
  const history = Array.isArray(rows) ? rows.slice(-AI.HISTORY_ENTRIES) : [];
  const ids = [...new Set(history.flatMap(row => Array.isArray(row && row.attachments) ? row.attachments.slice(0, Files.MAX_PER_MESSAGE).map(String) : []).filter(id => /^[A-Za-z0-9]{1,40}$/.test(id)))].slice(0, 20);
  const found = {};
  await Promise.all(ids.map(async id => { const snap = await db.collection("uploads").doc(id).get(); if (snap.exists && snap.data().uid === uid) found[id] = Object.assign({id}, snap.data()); }));
  return history.map(row => {
    const own = (Array.isArray(row && row.attachments) ? row.attachments : []).map(id => found[String(id)]).filter(Boolean);
    const usable = Files.usableFiles(own, now);
    return {role: row && row.role, text: row && row.text, files: usable, fileNames: own.filter(f => !usable.includes(f)).map(f => `${f.displayName} (expired)`)};
  });
}
function savedHistoryWithFiles(messages, now) {
  return messages.map(message => {
    const all = message.attachments || [], usable = Files.usableFiles(all, now);
    return {role: message.role, text: message.text, files: usable, fileNames: all.filter(f => !usable.includes(f)).map(f => `${f.displayName} (expired)`)};
  });
}
// Deletes upload records and their Gemini copies for one owner (all of them when ids is null).
async function purgeUploads(db, uid, ids) {
  const docs = ids === null
    ? (await db.collection("uploads").where("uid", "==", uid).limit(500).get()).docs
    : (await Promise.all((ids || []).filter(id => /^[A-Za-z0-9]{1,40}$/.test(id)).map(id => db.collection("uploads").doc(id).get()))).filter(doc => doc.exists && doc.data().uid === uid);
  const key = AI.headerValue(GEMINI_API_KEY.value());
  await Promise.all(docs.map(async doc => { await Files.deleteFromGemini(key, doc.data().geminiName); await doc.ref.delete(); }));
  return docs.length;
}

// Photo/PDF upload. Counts toward a daily upload cap, not toward chat messages.
exports.upload = onCall({enforceAppCheck: true, timeoutSeconds: 90, memory: "512MiB", secrets: [GEMINI_API_KEY]}, async request => {
  const db = getFirestore(), account = await Access.resolveAccount(db, request.auth), now = Date.now();
  const file = Files.validateUpload(request.data || {});
  await Files.claimUpload(db, account.uid, Access.manilaDay(now), Access.unlimited(account.tier), now);
  const key = AI.headerValue(GEMINI_API_KEY.value());
  if (!key) throw new HttpsError("failed-precondition", "File uploads are not configured.");
  const stored = await Files.uploadToGemini(key, file);
  return Files.saveUpload(db, account.uid, file, stored, now);
});

// One chat turn. Streams the reply (chunks {delta} and, when a provider fails mid-reply and the
// next one takes over, {reset}) and returns the finished answer. Registered users' turns are
// saved to their chats; guests send their own short history from the browser tab.
exports.chat = onCall({enforceAppCheck: true, timeoutSeconds: 120, memory: "256MiB", secrets: AI_SECRETS}, async (request, response) => {
  const db = getFirestore(), account = await Access.resolveAccount(db, request.auth), data = request.data || {};
  const mode = ["regenerate", "edit"].includes(data.mode) ? data.mode : "new", saves = account.tier !== "guest";
  let question = AI.cleanMultiline(data.question, QUESTION_CHARS), chat = null, plan;
  if (saves) {
    if (data.chatId) chat = await Chats.requireChat(db, account.uid, data.chatId);
    else if (mode !== "new") throw new HttpsError("failed-precondition", "There is no answer to redo in this chat.");
    const messages = chat ? await Chats.recentMessages(chat.ref) : [];
    plan = Chats.planTurn(messages, mode, question);
    plan.history = savedHistoryWithFiles(plan.history, Date.now());
  } else {
    if (mode !== "new") throw new HttpsError("failed-precondition", "Sign in to regenerate or edit answers.");
    plan = {question, history: await guestHistoryWithFiles(db, account.uid, data.history, Date.now()), remove: [], keepUser: null, attachments: []};
  }
  // New files on this turn replace any carried over from the question being edited/regenerated.
  const newFiles = Array.isArray(data.attachments) && data.attachments.length ? await Files.resolveAttachments(db, account.uid, data.attachments, Date.now()) : null;
  if (newFiles && mode === "regenerate") throw new HttpsError("invalid-argument", "Regenerate reuses the question's own files.");
  if (newFiles) plan.attachments = newFiles;
  const files = Files.usableFiles(plan.attachments, Date.now());
  if (plan.attachments.length && files.length < plan.attachments.length) throw new HttpsError("failed-precondition", "An attached file has expired (files are kept for 48 hours). Attach it again in a new message.");
  question = plan.question || (files.length ? "Please look at the attached file" + (files.length > 1 ? "s." : ".") : "");
  plan.question = question;
  if (question.length < 2) throw new HttpsError("invalid-argument", "Type a question first.");
  const now = Date.now(), day = Access.manilaDay(now), limited = !Access.unlimited(account.tier);
  const allowance = limited ? await Access.claimMessage(db, account.uid, day, now) : null;
  const history = plan.history;
  // Personalisation for registered users: "About me", reply preferences and saved memories.
  const [settings, memories] = saves ? await Promise.all([Memory.loadSettings(db, account.uid), Memory.listMemories(db, account.uid)]) : [Memory.DEFAULT_SETTINGS, []];
  const system = saves ? Memory.personalBlock(settings, memories) : "";
  let result;
  try {
    result = await AI.withFallback(AI.generalChatProviders({question, history, keys: KEYS, tier: account.tier, files, system}), {
      onDelta: piece => { response.sendChunk({delta: piece}).catch(() => {}); },
      onReset: () => { response.sendChunk({reset: true}).catch(() => {}); },
      onUnusual: (answeredBy, failures) => recordProviderHealth(db, account.tier, answeredBy, failures),
    });
  } catch (error) {
    if (limited) await Access.releaseMessage(db, account.uid, day);
    throw error;
  }
  const saved = saves ? await Chats.saveTurn(db, account.uid, chat, plan, result, now) : null;
  // Learn from this exchange (never blocks or fails the answer).
  let memory = null;
  if (saves) {
    try { memory = await Memory.learnFromTurn({db, uid: account.uid, settings, memories, question, answer: result.answer, chatId: saved && saved.chatId, key: AI.headerValue(GEMINI_API_KEY.value()), now, extract: AI.geminiJson}); }
    catch (error) { console.warn(JSON.stringify({event: "memory_learn_failed", message: String(error && error.message || error).slice(0, 200)})); }
  }
  // The analytics log keeps who asked, which AI answered and a hash of the question, never the text.
  await db.collection("chatLog").add({at: now, day, uid: account.uid, tier: account.tier, mode, files: files.length, provider: result.provider, model: result.model, backupsTried: result.failures.length, questionHash: crypto.createHash("sha256").update(question).digest("hex"), used: allowance ? allowance.used : null});
  return {answer: result.answer, provider: result.provider, model: result.model, tier: account.tier, allowance, attachments: files.map(Files.publicFile), memory, chatId: saved && saved.chatId, title: saved && saved.title, userMessageId: saved && saved.userMessageId, modelMessageId: saved && saved.modelMessageId, releaseVersion: RELEASE_VERSION};
});

// Account actions. "me" registers the caller on first use and reports their tier and today's
// allowance. The owner can list accounts and approve or remove staff.
exports.account = onCall({enforceAppCheck: true, timeoutSeconds: 60, memory: "256MiB", secrets: [GEMINI_API_KEY]}, async request => {
  const db = getFirestore(), auth = request.auth, data = request.data || {}, action = AI.cleanText(data.action, 20), now = Date.now(), day = Access.manilaDay(now);
  if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Sign in first.");
  if (action === "me") {
    if (Access.isAnonymous(auth)) {
      const used = await Access.usedToday(db, auth.uid, day);
      return {tier: "guest", emailVerified: false, limit: Access.DAILY_LIMIT, remaining: Math.max(0, Access.DAILY_LIMIT - used)};
    }
    const email = Access.normalEmail(auth.token && auth.token.email), verified = auth.token && auth.token.email_verified === true;
    const ref = db.collection("users").doc(auth.uid), snap = await ref.get(), user = snap.exists ? snap.data() : null;
    const owner = verified && Access.isOwnerEmail(email), name = Access.cleanName(data.name) || (user && user.name) || Access.cleanName(auth.token.name) || "";
    if (!user) await ref.set({email, name, role: owner ? "owner" : "member", status: owner ? "approved" : "pending", createdAt: now, updatedAt: now});
    else {
      const patch = {email, updatedAt: now, lastSeenAt: now};
      if (Access.cleanName(data.name)) patch.name = name;
      if (owner && user.role !== "owner") Object.assign(patch, {role: "owner", status: "approved"});
      await ref.set(patch, {merge: true});
    }
    if (!verified) return {tier: "unverified", emailVerified: false, email, name};
    const account = await Access.resolveAccount(db, auth);
    if (Access.unlimited(account.tier)) return {tier: account.tier, emailVerified: true, email, name, limit: null, remaining: null, model: AI.GEMINI.strong.model};
    const used = await Access.usedToday(db, auth.uid, day);
    return {tier: account.tier, emailVerified: true, email, name, limit: Access.DAILY_LIMIT, remaining: Math.max(0, Access.DAILY_LIMIT - used), pendingApproval: true};
  }
  const actor = await Access.resolveAccount(db, auth);
  // Saved chats: any registered, verified account, always scoped to the caller's own uid.
  const chatActions = {
    chats: async () => ({chats: await Chats.listChats(db, actor.uid)}),
    messages: () => Chats.listMessages(db, actor.uid, data.chatId),
    renameChat: () => Chats.renameChat(db, actor.uid, data.chatId, data.title),
    deleteChat: async () => { const out = await Chats.deleteChat(db, actor.uid, data.chatId); out.filesDeleted = await purgeUploads(db, actor.uid, out.fileIds); delete out.fileIds; return out; },
    deleteAllChats: async () => { const out = await Chats.deleteAllChats(db, actor.uid); out.filesDeleted = await purgeUploads(db, actor.uid, null); return out; },
    getSettings: async () => ({settings: await Memory.loadSettings(db, actor.uid), memories: await Memory.listMemories(db, actor.uid)}),
    saveSettings: async () => ({settings: await Memory.saveSettings(db, actor.uid, data.settings || {}, now)}),
    addMemory: () => Memory.addMemory(db, actor.uid, data.text, now),
    deleteMemory: () => Memory.deleteMemory(db, actor.uid, data.memoryId),
    deleteAllMemories: () => Memory.deleteAllMemories(db, actor.uid),
  };
  if (chatActions[action]) {
    if (actor.tier === "guest") throw new HttpsError("failed-precondition", "Sign in to save chats and use memory.");
    return chatActions[action]();
  }
  if (actor.tier !== "owner") throw new HttpsError("permission-denied", "Only the owner can manage staff.");
  if (action === "list") {
    const [usersSnap, usageSnap, healthSnap] = await Promise.all([db.collection("users").orderBy("createdAt", "desc").limit(200).get(), db.collection("usage").doc(day).get(), db.collection("providerHealth").doc(day).get()]);
    const usage = usageSnap.exists ? usageSnap.data() : {}, health = healthSnap.exists ? healthSnap.data() : {};
    return {
      users: usersSnap.docs.map(doc => { const u = doc.data(); return {uid: doc.id, email: u.email || "", name: u.name || "", role: u.role || "member", status: u.status || "pending", createdAt: u.createdAt || 0, lastSeenAt: u.lastSeenAt || 0}; }),
      today: {day, limitedMessages: Number(usage.total || 0), sharedLimit: Access.SHARED_DAILY_LIMIT, backupAnswers: health.backupAnswers || {}, providerFailures: health.providerFailures || {}, failedQuestions: Number(health.failedQuestions || 0)},
    };
  }
  if (action === "approve" || action === "remove") {
    const uid = AI.cleanText(data.uid, 128);
    if (!uid || uid === actor.uid) throw new HttpsError("invalid-argument", "Choose another account.");
    const ref = db.collection("users").doc(uid), snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That account was not found.");
    if (snap.data().role === "owner") throw new HttpsError("failed-precondition", "The owner account cannot be changed here.");
    const patch = action === "approve" ? {role: "staff", status: "approved", approvedAt: now, approvedBy: actor.uid} : {role: "member", status: "removed", removedAt: now, removedBy: actor.uid};
    await ref.set(Object.assign(patch, {updatedAt: now}), {merge: true});
    await db.collection("adminLog").add({at: now, action, uid, by: actor.uid, email: snap.data().email || ""});
    return {ok: true, uid, role: patch.role, status: patch.status};
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
