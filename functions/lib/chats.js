"use strict";
// Saved chats for registered users (Danilo, 25 Sep 2026): owner, staff and members keep their
// chats on any device. Guests' chats stay only in their browser tab.
// users/{uid}/chats/{chatId}               {title, createdAt, updatedAt, messageCount}
// users/{uid}/chats/{chatId}/messages/{id} {role: "user"|"model", text, at, provider?, model?,
//                                           attachments?: [{id, displayName, mimeType, uri, expiresAt}]}
// Only the server reads or writes these (Firestore rules deny browsers), and every path is built
// from the caller's own uid, so nobody can read another person's chats.
const {HttpsError} = require("firebase-functions/v2/https");

const CONTEXT_MESSAGES = 40;
const LIST_CHATS = 100;
const LIST_MESSAGES = 300;

function chatsRef(db, uid) { return db.collection("users").doc(uid).collection("chats"); }
function cleanId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}
function titleFrom(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line || "New chat";
}
async function requireChat(db, uid, chatId) {
  const id = cleanId(chatId);
  if (!id) throw new HttpsError("invalid-argument", "That chat was not found.");
  const ref = chatsRef(db, uid).doc(id), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "That chat was not found. It may have been deleted.");
  return {ref, data: snap.data()};
}
async function recentMessages(chatRef) {
  const snap = await chatRef.collection("messages").orderBy("at", "desc").limit(CONTEXT_MESSAGES).get();
  return snap.docs.map(doc => Object.assign({id: doc.id, ref: doc.ref}, doc.data())).reverse();
}

// Works out what to send to the AI and what to change afterwards, for the three modes:
// new (ask), regenerate (answer the last question again) and edit (replace the last question).
function planTurn(messages, mode, question) {
  const last = messages[messages.length - 1], before = messages[messages.length - 2];
  if (mode === "regenerate" || mode === "edit") {
    if (!last || last.role !== "model" || !before || before.role !== "user") throw new HttpsError("failed-precondition", "There is no answer to redo in this chat.");
    if (mode === "regenerate") return {question: before.text, history: messages.slice(0, -2), remove: [last], keepUser: before, attachments: before.attachments || []};
    return {question, history: messages.slice(0, -2), remove: [before, last], keepUser: null, attachments: before.attachments || []};
  }
  return {question, history: messages, remove: [], keepUser: null, attachments: []};
}

async function saveTurn(db, uid, chat, plan, result, now) {
  const batch = db.batch();
  let chatRef = chat && chat.ref, created = false, title = chat && chat.data && chat.data.title;
  if (!chatRef) { chatRef = chatsRef(db, uid).doc(); created = true; title = titleFrom(plan.question); }
  plan.remove.forEach(message => batch.delete(message.ref));
  let userMessageId = plan.keepUser ? plan.keepUser.id : null;
  if (!plan.keepUser) {
    const userRef = chatRef.collection("messages").doc();
    userMessageId = userRef.id;
    const attachments = (plan.attachments || []).map(f => ({id: f.id, displayName: f.displayName, mimeType: f.mimeType, uri: f.uri, expiresAt: f.expiresAt}));
    batch.set(userRef, attachments.length ? {role: "user", text: plan.question, at: now, attachments} : {role: "user", text: plan.question, at: now});
  }
  const modelRef = chatRef.collection("messages").doc();
  batch.set(modelRef, {role: "model", text: result.answer, at: now + 1, provider: result.provider, model: result.model});
  const count = (chat && Number(chat.data.messageCount || 0) || 0) - plan.remove.length + (plan.keepUser ? 1 : 2);
  batch.set(chatRef, created ? {title, createdAt: now, updatedAt: now, messageCount: count} : {updatedAt: now, messageCount: Math.max(0, count)}, {merge: true});
  await batch.commit();
  return {chatId: chatRef.id, title, userMessageId, modelMessageId: modelRef.id, created};
}

async function listChats(db, uid) {
  const snap = await chatsRef(db, uid).orderBy("updatedAt", "desc").limit(LIST_CHATS).get();
  return snap.docs.map(doc => ({id: doc.id, title: doc.data().title || "New chat", updatedAt: doc.data().updatedAt || 0}));
}
async function listMessages(db, uid, chatId) {
  const {ref, data} = await requireChat(db, uid, chatId);
  const snap = await ref.collection("messages").orderBy("at", "desc").limit(LIST_MESSAGES).get();
  return {chat: {id: ref.id, title: data.title || "New chat"}, messages: snap.docs.map(doc => { const m = doc.data(); return {id: doc.id, role: m.role, text: m.text || "", at: m.at || 0, attachments: (m.attachments || []).map(f => ({id: f.id, displayName: f.displayName, mimeType: f.mimeType, expiresAt: f.expiresAt}))}; }).reverse()};
}
async function renameChat(db, uid, chatId, title) {
  const {ref} = await requireChat(db, uid, chatId);
  const clean = String(title || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) throw new HttpsError("invalid-argument", "Type a name for the chat.");
  await ref.set({title: clean}, {merge: true});
  return {id: ref.id, title: clean};
}
// Returns the attachment ids the chat used, so the caller can delete those files too.
async function deleteChat(db, uid, chatId) {
  const {ref} = await requireChat(db, uid, chatId);
  const snap = await ref.collection("messages").where("role", "==", "user").get();
  const fileIds = [...new Set(snap.docs.flatMap(doc => (doc.data().attachments || []).map(f => f.id)).filter(Boolean))];
  await db.recursiveDelete(ref);
  return {deleted: ref.id, fileIds};
}
async function deleteAllChats(db, uid) {
  await db.recursiveDelete(chatsRef(db, uid));
  return {deletedAll: true};
}

module.exports = {CONTEXT_MESSAGES, cleanId, titleFrom, requireChat, recentMessages, planTurn, saveTurn, listChats, listMessages, renameChat, deleteChat, deleteAllChats};
