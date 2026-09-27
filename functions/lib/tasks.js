"use strict";
// Laptop tasks (Danilo, 26 Sep 2026): Cowork-style long tasks for the owner only.
// The web app queues a task here. The worker on the owner's laptop (worker/ in this repo) claims
// it, runs it step by step in a Docker sandbox and writes progress back. Browsers never read
// Firestore directly: they poll the `tasks` callable.
//
// tasks/{id}                {uid, chatId, userMessageId, modelMessageId, title, prompt, status, plan[],
//                            question, reply, stopRequested, inputs[], outputs[], summary, error,
//                            steps, eventSeq, createdAt, updatedAt, startedAt, finishedAt, workerId,
//                            leaseUntil, attempts}
// tasks/{id}/events/{seq}   {seq, at, type, label, status, detail}
// workers/{id}              {lastSeen, version, host, docker, busy, taskId}
// Files: gs://accaza-ai-task-files/tasks/{id}/inputs|outputs/{name} (bucket deletes after 90 days).
//
// Status: queued -> running -> (waiting -> queued ->) done | failed | stopped.
// A task waiting for the user goes back to "queued" with `reply` set once the user answers, so a
// worker that was offline picks it up the same way as a new task.
const {HttpsError} = require("firebase-functions/v2/https");

const BUCKET = "accaza-ai-task-files";
const ACTIVE = ["queued", "running", "waiting"];
const FINAL = ["done", "failed", "stopped"];
const PROMPT_CHARS = 8000;
const REPLY_CHARS = 2000;
const MAX_ACTIVE = 5;
const WORKER_STALE_MS = 90000;
const EVENTS_PAGE = 200;
// Matches the worker's 20 MB cap per file; base64 of 20 MB stays under the 32 MB callable response limit.
const DOWNLOAD_MAX = 20 * 1024 * 1024;
const INPUT = {maxFiles: 5, maxBytes: 10 * 1024 * 1024, maxTotal: 15 * 1024 * 1024};
const INPUT_TYPES = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml", html: "text/html",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip",
};

function eventId(seq) { return String(seq).padStart(6, "0"); }
function cleanId(value) { const id = String(value || "").trim(); return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : ""; }
// File names become paths inside the sandbox and in the bucket, so only a safe subset is kept.
function cleanFileName(value) {
  const base = String(value || "").split(/[\\/]/).pop().normalize("NFKC").replace(/[^A-Za-z0-9._ ()-]/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
  if (!base) return "";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, 90).trim(), ext = dot > 0 ? base.slice(dot + 1).toLowerCase().slice(0, 10) : "";
  return stem ? (ext ? `${stem}.${ext}` : stem) : "";
}
function mimeFor(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return INPUT_TYPES[ext] || "";
}
// Browser sends [{name, data: base64}]. Returns [{name, mimeType, bytes}], unique names.
function validateInputs(list) {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length > INPUT.maxFiles) throw new HttpsError("invalid-argument", `Attach up to ${INPUT.maxFiles} files to a task.`);
  const used = new Set(), out = [];
  let total = 0;
  for (const row of rows) {
    let name = cleanFileName(row && row.name);
    const mimeType = mimeFor(name);
    if (!name || !mimeType) throw new HttpsError("invalid-argument", `"${String(row && row.name || "file").slice(0, 60)}" is not a supported file type for tasks.`);
    const data = String(row && row.data || "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpsError("invalid-argument", `"${name}" could not be read.`);
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new HttpsError("invalid-argument", `"${name}" is empty.`);
    if (bytes.length > INPUT.maxBytes) throw new HttpsError("invalid-argument", `"${name}" is larger than 10 MB.`);
    total += bytes.length;
    if (total > INPUT.maxTotal) throw new HttpsError("invalid-argument", "Task files can total up to 15 MB.");
    for (let n = 2; used.has(name.toLowerCase()); n += 1) { const dot = name.lastIndexOf("."); name = `${dot > 0 ? name.slice(0, dot) : name} (${n})${dot > 0 ? name.slice(dot) : ""}`; }
    used.add(name.toLowerCase());
    out.push({name, mimeType, bytes});
  }
  return out;
}
function titleFrom(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line || "New task";
}
function cleanPrompt(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, PROMPT_CHARS);
}

function publicTask(id, t) {
  return {
    id, chatId: t.chatId || null, title: t.title || "Task", prompt: t.prompt || "", status: t.status, plan: (t.plan || []).slice(0, 30),
    question: t.status === "waiting" ? t.question || "" : "", summary: t.summary || "", error: t.error || "", steps: Number(t.steps || 0),
    stopRequested: t.stopRequested === true, inputs: (t.inputs || []).map(f => ({name: f.name, size: f.size, mimeType: f.mimeType})),
    outputs: (t.outputs || []).map(f => ({name: f.name, size: f.size, mimeType: f.mimeType})),
    createdAt: t.createdAt || 0, updatedAt: t.updatedAt || 0, startedAt: t.startedAt || 0, finishedAt: t.finishedAt || 0,
  };
}
function workerState(doc, now) {
  if (!doc) return {online: false, lastSeen: 0};
  const lastSeen = Number(doc.lastSeen || 0);
  return {online: now - lastSeen < WORKER_STALE_MS, lastSeen, busy: doc.busy === true, docker: doc.docker === true, host: doc.host || ""};
}
async function workerStatus(db, now) {
  const snap = await db.collection("workers").orderBy("lastSeen", "desc").limit(1).get();
  return workerState(snap.empty ? null : snap.docs[0].data(), now);
}
async function requireTask(db, uid, taskId) {
  const id = cleanId(taskId);
  if (!id) throw new HttpsError("invalid-argument", "That task was not found.");
  const ref = db.collection("tasks").doc(id), snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) throw new HttpsError("not-found", "That task was not found. It may have been deleted.");
  return {id, ref, data: snap.data()};
}
async function addEvent(db, taskRef, event, now) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return 0;
    const seq = Number(snap.data().eventSeq || 0) + 1;
    tx.update(taskRef, {eventSeq: seq, updatedAt: now});
    tx.set(taskRef.collection("events").doc(eventId(seq)), Object.assign({seq, at: now}, event));
    return seq;
  });
}

// Creates the task, its chat messages and uploads its files. Files go first: if an upload fails,
// nothing is written.
async function createTask({db, bucket, account, data, now, Chats}) {
  const prompt = cleanPrompt(data.prompt), inputs = validateInputs(data.inputs);
  if (prompt.length < 2 && !inputs.length) throw new HttpsError("invalid-argument", "Describe the task first.");
  const active = await db.collection("tasks").where("uid", "==", account.uid).where("status", "in", ACTIVE).limit(MAX_ACTIVE + 1).get();
  if (active.size >= MAX_ACTIVE) throw new HttpsError("resource-exhausted", `You already have ${MAX_ACTIVE} tasks queued or running. Stop one or wait for it to finish.`);
  const chat = data.chatId ? await Chats.requireChat(db, account.uid, data.chatId) : null;
  const chatRef = chat ? chat.ref : db.collection("users").doc(account.uid).collection("chats").doc();
  const taskRef = db.collection("tasks").doc();
  const text = prompt || `Please work with the attached file${inputs.length > 1 ? "s" : ""}.`;
  const stored = [];
  for (const file of inputs) {
    const path = `tasks/${taskRef.id}/inputs/${file.name}`;
    await bucket.file(path).save(file.bytes, {resumable: false, contentType: file.mimeType, metadata: {cacheControl: "private, no-store"}});
    stored.push({name: file.name, mimeType: file.mimeType, size: file.bytes.length, path});
  }
  const userRef = chatRef.collection("messages").doc(), modelRef = chatRef.collection("messages").doc();
  const title = titleFrom(text), batch = db.batch();
  batch.set(taskRef, {uid: account.uid, chatId: chatRef.id, userMessageId: userRef.id, modelMessageId: modelRef.id, title, prompt: text, status: "queued", plan: [], question: "", reply: null,
    stopRequested: false, inputs: stored, outputs: [], summary: "", error: "", steps: 0, eventSeq: 1, attempts: 0, createdAt: now, updatedAt: now, startedAt: 0, finishedAt: 0, workerId: "", leaseUntil: 0});
  batch.set(taskRef.collection("events").doc(eventId(1)), {seq: 1, at: now, type: "status", label: "Queued for your laptop", status: "queued", detail: ""});
  const taskRefLite = {id: taskRef.id, status: "queued"};
  batch.set(userRef, stored.length ? {role: "user", text, at: now, task: taskRefLite, taskFiles: stored.map(f => f.name)} : {role: "user", text, at: now, task: taskRefLite});
  batch.set(modelRef, {role: "model", text: "", at: now + 1, task: taskRefLite, provider: "laptop", model: "task"});
  const count = (chat ? Number(chat.data.messageCount || 0) : 0) + 2;
  batch.set(chatRef, chat ? {updatedAt: now, messageCount: count} : {title, createdAt: now, updatedAt: now, messageCount: count}, {merge: true});
  await batch.commit();
  return {taskId: taskRef.id, chatId: chatRef.id, title: chat ? chat.data.title || title : title, userMessageId: userRef.id, modelMessageId: modelRef.id};
}

async function listTasks(db, uid, now) {
  const [snap, worker] = await Promise.all([db.collection("tasks").where("uid", "==", uid).orderBy("createdAt", "desc").limit(100).get(), workerStatus(db, now)]);
  return {tasks: snap.docs.map(doc => publicTask(doc.id, doc.data())), worker};
}
async function getTask(db, uid, taskId, since, now) {
  const task = await requireTask(db, uid, taskId);
  const after = Math.max(0, Math.floor(Number(since) || 0));
  const [events, worker] = await Promise.all([
    task.ref.collection("events").where("seq", ">", after).orderBy("seq").limit(EVENTS_PAGE).get(),
    workerStatus(db, now),
  ]);
  return {task: publicTask(task.id, task.data), events: events.docs.map(d => { const e = d.data(); return {seq: e.seq, at: e.at, type: e.type, label: e.label || "", status: e.status || "", detail: e.detail || "", of: e.of || 0, ms: e.ms || 0}; }), worker};
}
// A queued task stops at once; a running one is flagged and the worker stops it between steps
// (and kills any code it is running).
async function stopTask(db, uid, taskId, now) {
  const task = await requireTask(db, uid, taskId);
  const out = await db.runTransaction(async tx => {
    const snap = await tx.get(task.ref), t = snap.data();
    if (!ACTIVE.includes(t.status)) return {status: t.status};
    if (t.status === "running") { tx.update(task.ref, {stopRequested: true, updatedAt: now}); return {status: "running", stopRequested: true}; }
    tx.update(task.ref, {status: "stopped", stopRequested: true, finishedAt: now, updatedAt: now, error: "Stopped by you."});
    return {status: "stopped"};
  });
  if (out.status === "stopped" || out.stopRequested) await addEvent(db, task.ref, {type: "status", label: out.stopRequested ? "Stopping…" : "Stopped", status: out.stopRequested ? "stopping" : "stopped", detail: ""}, now);
  if (out.status === "stopped") await syncChatMessage(db, uid, task.data, "stopped", "*Task stopped.*");
  return out;
}
// The user's answer to a question from the task. The task goes back to the queue.
async function replyTask(db, uid, taskId, text, now) {
  const task = await requireTask(db, uid, taskId), answer = cleanPrompt(text).slice(0, REPLY_CHARS);
  if (!answer) throw new HttpsError("invalid-argument", "Type your answer first.");
  await db.runTransaction(async tx => {
    const snap = await tx.get(task.ref);
    if (snap.data().status !== "waiting") throw new HttpsError("failed-precondition", "This task is not waiting for an answer.");
    tx.update(task.ref, {status: "queued", reply: {text: answer, at: now}, question: "", updatedAt: now});
  });
  await addEvent(db, task.ref, {type: "reply", label: "You answered", status: "done", detail: answer.slice(0, 2000)}, now);
  return {status: "queued"};
}
async function downloadFile(db, bucket, uid, taskId, which, name) {
  const task = await requireTask(db, uid, taskId);
  const list = which === "inputs" ? task.data.inputs || [] : task.data.outputs || [];
  const file = list.find(f => f.name === String(name || ""));
  if (!file) throw new HttpsError("not-found", "That file was not found.");
  if (Number(file.size) > DOWNLOAD_MAX) throw new HttpsError("failed-precondition", "That file is too large to download here.");
  const [bytes] = await bucket.file(file.path).download().catch(() => { throw new HttpsError("not-found", "That file is no longer stored (files are kept for 90 days)."); });
  return {name: file.name, mimeType: file.mimeType, size: bytes.length, data: bytes.toString("base64")};
}
// Keeps the chat's placeholder message in step with the task (worker does the same on finish).
async function syncChatMessage(db, uid, t, status, text) {
  if (!t.chatId || !t.modelMessageId) return;
  const chatRef = db.collection("users").doc(uid).collection("chats").doc(t.chatId);
  try { await chatRef.collection("messages").doc(t.modelMessageId).update({text, "task.status": status}); } catch (_error) { /* chat deleted */ }
}
// Deletes tasks (all of the user's, or one chat's): stops running ones, removes events and files.
async function deleteTasks(db, bucket, uid, chatId) {
  let query = db.collection("tasks").where("uid", "==", uid);
  if (chatId) query = query.where("chatId", "==", chatId);
  const snap = await query.limit(500).get();
  await Promise.all(snap.docs.map(async doc => {
    await bucket.deleteFiles({prefix: `tasks/${doc.id}/`}).catch(() => {});
    await db.recursiveDelete(doc.ref);
  }));
  return snap.size;
}
async function deleteTask(db, bucket, uid, taskId) {
  const task = await requireTask(db, uid, taskId);
  if (ACTIVE.includes(task.data.status)) throw new HttpsError("failed-precondition", "Stop the task before deleting it.");
  await bucket.deleteFiles({prefix: `tasks/${task.id}/`}).catch(() => {});
  await db.recursiveDelete(task.ref);
  return {deleted: task.id};
}

module.exports = {
  BUCKET, ACTIVE, FINAL, PROMPT_CHARS, REPLY_CHARS, MAX_ACTIVE, WORKER_STALE_MS, INPUT, INPUT_TYPES,
  eventId, cleanId, cleanFileName, mimeFor, validateInputs, titleFrom, cleanPrompt, publicTask, workerState, workerStatus, requireTask, addEvent,
  createTask, listTasks, getTask, stopTask, replyTask, downloadFile, syncChatMessage, deleteTasks, deleteTask,
};
