"use strict";
// Photo and PDF attachments (Danilo, 26 Sep 2026, step 2).
// The browser sends the file once (base64) to the `upload` callable. The server checks its type
// by its first bytes (not just the name), stores it in the Gemini Files API (Google deletes it
// after 48 hours) and records it in uploads/{id} with the owner's uid. Chat turns refer to files
// only by that id, and the server resolves an id only for the account that uploaded it, so
// nobody can attach someone else's file. Only Gemini can read files; text-only backups are told
// a file was attached so they can say they could not open it.
const {HttpsError} = require("firebase-functions/v2/https");
const {Timestamp} = require("firebase-admin/firestore");

const MAX_BYTES = 7 * 1024 * 1024;
const MAX_PER_MESSAGE = 3;
const DAILY_UPLOADS = {limited: 20, unlimited: 100};
const SAFETY_MS = 10 * 60 * 1000; // treat a file as gone 10 minutes before Google deletes it
const TYPES = {
  "image/png": {label: "image", check: b => b.length > 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG"},
  "image/jpeg": {label: "image", check: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff},
  "image/webp": {label: "image", check: b => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"},
  "image/heic": {label: "image", check: b => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b.toString("ascii", 8, 12))},
  "image/heif": {label: "image", check: b => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b.toString("ascii", 8, 12))},
  "application/pdf": {label: "PDF", check: b => b.length > 5 && b.toString("ascii", 0, 5) === "%PDF-"},
};

function cleanFileName(value) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f\\/<>:"|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || "file";
}
// Returns the decoded bytes or throws a clear, user-facing error.
function validateUpload(data) {
  const mimeType = String(data && data.mimeType || "").toLowerCase();
  const type = TYPES[mimeType];
  if (!type) throw new HttpsError("invalid-argument", "Only photos (JPG, PNG, WebP, HEIC) and PDFs can be attached.");
  const base64 = String(data && data.base64 || "");
  if (!base64 || base64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) throw new HttpsError("invalid-argument", "That file is too large or damaged. The limit is 7 MB.");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new HttpsError("invalid-argument", "That file is empty.");
  if (bytes.length > MAX_BYTES) throw new HttpsError("invalid-argument", "That file is larger than 7 MB.");
  if (!type.check(bytes)) throw new HttpsError("invalid-argument", `That file does not look like a real ${type.label}.`);
  return {bytes, mimeType, displayName: cleanFileName(data.name)};
}

async function claimUpload(db, uid, day, unlimited, now) {
  const ref = db.collection("uploadUsage").doc(day), cap = unlimited ? DAILY_UPLOADS.unlimited : DAILY_UPLOADS.limited;
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref), usage = snap.exists ? snap.data() : {}, users = usage.users && typeof usage.users === "object" ? usage.users : {};
    const mine = Number(users[uid] || 0);
    if (mine >= cap) throw new HttpsError("resource-exhausted", `Upload limit reached (${cap} files today). Try again tomorrow.`);
    tx.set(ref, {updatedAt: now, users: Object.assign({}, users, {[uid]: mine + 1})});
  });
}

async function uploadToGemini(key, file, fetchImpl = fetch) {
  const boundary = "accaza" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({file: {display_name: file.displayName}})}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response = await fetchImpl("https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart", {method: "POST", headers: {"x-goog-api-key": key, "content-type": `multipart/related; boundary=${boundary}`}, body, signal: AbortSignal.timeout(45000)});
  const json = await response.json().catch(() => ({}));
  let stored = json && json.file;
  if (!response.ok || !stored || !stored.uri) throw new HttpsError("unavailable", "The file could not be uploaded right now. Please try again.");
  // PDFs can take a moment to process; wait until the file is usable (up to ~20 s).
  for (let i = 0; i < 20 && stored.state === "PROCESSING"; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const check = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/${stored.name}`, {headers: {"x-goog-api-key": key}});
    if (check.ok) stored = await check.json();
  }
  if (stored.state === "FAILED") throw new HttpsError("invalid-argument", "Google could not read that file. Try a different copy.");
  return {geminiName: stored.name, uri: stored.uri, mimeType: stored.mimeType || file.mimeType, expiresAt: Date.parse(stored.expirationTime || "") || Date.now() + 47 * 3600 * 1000};
}
async function deleteFromGemini(key, geminiName, fetchImpl = fetch) {
  if (!key || !/^files\/[A-Za-z0-9_-]+$/.test(String(geminiName || ""))) return;
  try { await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/${geminiName}`, {method: "DELETE", headers: {"x-goog-api-key": key}}); } catch (_error) { /* Google deletes it after 48 hours anyway */ }
}

async function saveUpload(db, uid, file, stored, now) {
  const ref = db.collection("uploads").doc();
  const record = {uid, displayName: file.displayName, mimeType: stored.mimeType, size: file.bytes.length, uri: stored.uri, geminiName: stored.geminiName, createdAt: now, expiresAt: stored.expiresAt, expireAt: Timestamp.fromMillis(stored.expiresAt)};
  await ref.set(record);
  return {id: ref.id, displayName: record.displayName, mimeType: record.mimeType, size: record.size, expiresAt: record.expiresAt};
}

// Resolves attachment ids for one account. Unknown, foreign or expired ids are refused.
async function resolveAttachments(db, uid, ids, now) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  if (list.length > MAX_PER_MESSAGE) throw new HttpsError("invalid-argument", `Attach up to ${MAX_PER_MESSAGE} files per message.`);
  const out = [];
  for (const id of list) {
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new HttpsError("invalid-argument", "An attachment was not found.");
    const snap = await db.collection("uploads").doc(id).get(), file = snap.exists ? snap.data() : null;
    if (!file || file.uid !== uid) throw new HttpsError("not-found", "An attachment was not found. Attach it again.");
    if (Number(file.expiresAt || 0) - SAFETY_MS < now) throw new HttpsError("failed-precondition", `"${file.displayName}" has expired (files are kept for 48 hours). Attach it again.`);
    out.push({id, displayName: file.displayName, mimeType: file.mimeType, uri: file.uri, expiresAt: file.expiresAt});
  }
  return out;
}
// For history: a file older than 48 hours is no longer readable, so it becomes a text note.
function usableFiles(files, now) {
  return (Array.isArray(files) ? files : []).filter(f => f && f.uri && Number(f.expiresAt || 0) - SAFETY_MS > now);
}
function publicFile(f) {
  return {id: f.id, displayName: f.displayName, mimeType: f.mimeType, expiresAt: f.expiresAt};
}

module.exports = {MAX_BYTES, MAX_PER_MESSAGE, DAILY_UPLOADS, SAFETY_MS, TYPES, cleanFileName, validateUpload, claimUpload, uploadToGemini, deleteFromGemini, saveUpload, resolveAttachments, usableFiles, publicFile};
