"use strict";
// Google connectors (Danilo, 26 Sep 2026, step D): Drive, Gmail and Calendar, READ-ONLY.
// OAuth 2.0 web-server flow with PKCE. The refresh token is stored encrypted in
// users/{uid}/connectors/google; access tokens are fetched per request and never stored.
// Needs GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (a "Web application" OAuth client in
// the accaza-ai project with redirect URI REDIRECT_URI). Until those are set, Google shows as
// "not configured".
const crypto = require("crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const {encrypt, decrypt} = require("./crypto");

const REDIRECT_URI = "https://accaza-ai.web.app/oauth/google";
const SERVICES = {
  drive: {label: "Google Drive", scope: "https://www.googleapis.com/auth/drive.readonly"},
  gmail: {label: "Gmail", scope: "https://www.googleapis.com/auth/gmail.readonly"},
  calendar: {label: "Google Calendar", scope: "https://www.googleapis.com/auth/calendar.readonly"},
};
const STATE_TTL_MS = 10 * 60 * 1000;

function configured(clientId, clientSecret) {
  return Boolean(clientId && clientSecret && clientId !== "unset" && clientSecret !== "unset" && /\.apps\.googleusercontent\.com$/.test(clientId));
}
function cleanLine(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

async function startAuth(db, uid, services, clientId, now) {
  const wanted = (Array.isArray(services) ? services : []).filter(s => SERVICES[s]);
  if (!wanted.length) throw new HttpsError("invalid-argument", "Choose at least one Google service.");
  const state = crypto.randomBytes(24).toString("base64url"), verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  await db.collection("oauthStates").doc(state).set({uid, services: wanted, verifier, createdAt: now});
  const params = new URLSearchParams({client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    scope: ["openid", "email", ...wanted.map(s => SERVICES[s].scope)].join(" "), state, code_challenge: challenge, code_challenge_method: "S256"});
  return {url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`};
}

// Handles Google's redirect. Returns the path to send the browser back to.
async function finishAuth(db, query, cfg, now, fetchImpl = fetch) {
  const state = String(query.state || ""), code = String(query.code || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(state)) return "/?connector=google&status=error";
  const ref = db.collection("oauthStates").doc(state), snap = await ref.get();
  if (!snap.exists) return "/?connector=google&status=expired";
  const saved = snap.data();
  await ref.delete(); // one-time use
  if (now - Number(saved.createdAt || 0) > STATE_TTL_MS) return "/?connector=google&status=expired";
  if (query.error || !code) return "/?connector=google&status=cancelled";
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code", code_verifier: saved.verifier}).toString()});
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.refresh_token) return "/?connector=google&status=error";
  const granted = String(token.scope || "").split(" ");
  const services = saved.services.filter(s => granted.includes(SERVICES[s].scope));
  let email = "";
  try { email = JSON.parse(Buffer.from(String(token.id_token || "").split(".")[1] || "", "base64url").toString("utf8")).email || ""; } catch (_error) { email = ""; }
  await db.collection("users").doc(saved.uid).collection("connectors").doc("google").set({type: "google", email: cleanLine(email, 120), services, refreshTokenEnc: encrypt(token.refresh_token, cfg.tokenKey), connectedAt: now, updatedAt: now});
  return `/?connector=google&status=${services.length ? "connected" : "no-access"}`;
}

async function disconnect(db, uid, tokenKey, fetchImpl = fetch) {
  const ref = db.collection("users").doc(uid).collection("connectors").doc("google"), snap = await ref.get();
  if (snap.exists) {
    try { await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(snap.data().refreshTokenEnc, tokenKey))}`, {method: "POST"}); } catch (_error) { /* revoked or unreadable: still remove */ }
    await ref.delete();
  }
  return {disconnected: true};
}

async function accessToken(conn, cfg, fetchImpl = fetch) {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: decrypt(conn.refreshTokenEnc, cfg.tokenKey), grant_type: "refresh_token"}).toString()});
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) throw new Error("Google access expired. Reconnect Google in Settings → Connectors.");
  return token.access_token;
}

function b64urlText(data) { return Buffer.from(String(data || ""), "base64url").toString("utf8"); }
function gmailBody(payload) {
  const parts = [], walk = p => { if (!p) return; if (p.mimeType === "text/plain" && p.body && p.body.data) parts.push(b64urlText(p.body.data)); (p.parts || []).forEach(walk); };
  walk(payload);
  if (!parts.length) { const html = []; const w = p => { if (!p) return; if (p.mimeType === "text/html" && p.body && p.body.data) html.push(b64urlText(p.body.data)); (p.parts || []).forEach(w); }; w(payload); return html.join("\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "); }
  return parts.join("\n");
}
function header(msg, name) { return ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ""; }

const DECLARATIONS = {
  drive: [
    {name: "drive_search", description: "Search the user's Google Drive by words in file names or contents. Returns file ids, names, types and links.", parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}},
    {name: "drive_read", description: "Read the text of one Google Drive file (Docs, Sheets as CSV, Slides, text files).", parameters: {type: "object", properties: {fileId: {type: "string"}}, required: ["fileId"]}},
  ],
  gmail: [
    {name: "gmail_search", description: "Search the user's Gmail using Gmail search syntax (e.g. from:supplier newer_than:30d). Returns subject, sender, date and snippet.", parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}},
    {name: "gmail_read", description: "Read one Gmail message's full text.", parameters: {type: "object", properties: {messageId: {type: "string"}}, required: ["messageId"]}},
  ],
  calendar: [
    {name: "calendar_events", description: "List events on the user's primary Google Calendar between two dates (YYYY-MM-DD), optionally matching words.", parameters: {type: "object", properties: {from: {type: "string"}, to: {type: "string"}, query: {type: "string"}}, required: ["from", "to"]}},
  ],
};

// Tools for one request. conn = the stored connector document.
function googleTools(conn, cfg, fetchImpl = fetch) {
  const services = (conn && conn.services) || [];
  const declarations = services.flatMap(s => DECLARATIONS[s] || []);
  if (!declarations.length) return null;
  let token = null;
  const api = async (url, asText = false) => {
    token = token || await accessToken(conn, cfg, fetchImpl);
    const response = await fetchImpl(url, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(cleanLine(body.error && body.error.message, 200) || `Google returned ${response.status}.`); }
    return asText ? response.text() : response.json();
  };
  return {
    declarations,
    labels: {drive_search: a => `Searching Google Drive: ${cleanLine(a.query, 60)}`, drive_read: () => "Reading a Drive file", gmail_search: a => `Searching Gmail: ${cleanLine(a.query, 60)}`, gmail_read: () => "Reading an email", calendar_events: a => `Checking your calendar ${cleanLine(a.from, 10)} to ${cleanLine(a.to, 10)}`},
    run: async (name, args) => {
      if (name === "drive_search") {
        const q = cleanLine(args.query, 200).replace(/['\\]/g, " ");
        const data = await api(`https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(`(name contains '${q}' or fullText contains '${q}') and trashed = false`)}`);
        return {files: (data.files || []).map(f => ({id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink}))};
      }
      if (name === "drive_read") {
        const id = String(args.fileId || "");
        if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return {error: "Invalid file id."};
        const meta = await api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,webViewLink`);
        const exportAs = {"application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain"}[meta.mimeType];
        let text;
        if (exportAs) text = await api(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`, true);
        else if (/^text\/|json|csv|xml/.test(meta.mimeType) && Number(meta.size || 0) < 1000000) text = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, true);
        else return {name: meta.name, link: meta.webViewLink, error: `This ${meta.mimeType} file cannot be read as text here. Ask the user to attach it to the chat instead.`};
        return {name: meta.name, link: meta.webViewLink, text: String(text).slice(0, 11000)};
      }
      if (name === "gmail_search") {
        const list = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(cleanLine(args.query, 200))}`);
        const msgs = await Promise.all((list.messages || []).slice(0, 10).map(m => api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)));
        return {messages: msgs.map(m => ({id: m.id, subject: header(m, "Subject"), from: header(m, "From"), date: header(m, "Date"), snippet: m.snippet}))};
      }
      if (name === "gmail_read") {
        const id = String(args.messageId || "");
        if (!/^[A-Za-z0-9]{6,}$/.test(id)) return {error: "Invalid message id."};
        const m = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
        return {subject: header(m, "Subject"), from: header(m, "From"), to: header(m, "To"), date: header(m, "Date"), text: gmailBody(m.payload).slice(0, 11000)};
      }
      if (name === "calendar_events") {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from) ? args.from : new Date().toISOString().slice(0, 10);
        const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to) ? args.to : from;
        const params = new URLSearchParams({timeMin: `${from}T00:00:00+08:00`, timeMax: `${to}T23:59:59+08:00`, singleEvents: "true", orderBy: "startTime", maxResults: "50"});
        if (args.query) params.set("q", cleanLine(args.query, 100));
        const data = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
        return {events: (data.items || []).map(e => ({title: e.summary || "(no title)", start: e.start && (e.start.dateTime || e.start.date), end: e.end && (e.end.dateTime || e.end.date), location: e.location || "", attendees: (e.attendees || []).length}))};
      }
      return {error: "Unknown Google tool."};
    },
  };
}
module.exports = {REDIRECT_URI, SERVICES, configured, startAuth, finishAuth, disconnect, googleTools, gmailBody};
