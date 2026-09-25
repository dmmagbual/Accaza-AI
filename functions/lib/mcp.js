"use strict";
// MCP connectors (Model Context Protocol, Streamable HTTP transport): the same open standard
// Claude and ChatGPT use for connectors. Owner/staff can add a remote MCP server by URL, with an
// optional access token (stored encrypted). Tools are listed once when added (and on refresh).
// Safety: only tools the server marks read-only are offered unless the connector was added with
// "allow actions that change things"; every URL goes through the SSRF guard; results are data.
// users/{uid}/connectors/mcp_{id} {type:"mcp", name, url, tokenEnc?, headerName, allowWrites, tools:[{name, description, inputSchema, readOnly}], updatedAt}
const crypto = require("crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const {safeFetch, assertPublicUrl} = require("./netguard");
const {encrypt, decrypt} = require("./crypto");

const PROTOCOL = "2025-06-18";
const MAX_TOOLS = 30;
const MAX_CONNECTORS = 10;
function cleanLine(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

// Parses a JSON-RPC reply that may come as JSON or as an SSE stream.
function parseRpc(text, contentType, id) {
  const bodies = /event-stream/i.test(contentType)
    ? String(text).split(/\n/).filter(l => l.startsWith("data:")).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch (_e) { return null; } }).filter(Boolean)
    : (() => { try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch (_e) { return []; } })();
  const reply = bodies.find(b => b && b.id === id) || bodies.find(b => b && (b.result || b.error));
  if (!reply) throw new Error("The connector sent an unreadable reply.");
  if (reply.error) throw new Error(cleanLine(reply.error.message, 200) || "The connector returned an error.");
  return reply.result;
}

// A tiny MCP client: initialize (keeping the session id), then any number of requests.
function client(conn, tokenKey, fetchImpl = safeFetch) {
  let session = null, nextId = 1;
  const headers = () => {
    const h = {"content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL};
    if (conn.tokenEnc) { const token = decrypt(conn.tokenEnc, tokenKey); h[(conn.headerName || "authorization").toLowerCase()] = /^authorization$/i.test(conn.headerName || "authorization") && !/^bearer /i.test(token) ? `Bearer ${token}` : token; }
    if (session) h["mcp-session-id"] = session;
    return h;
  };
  const rpc = async (method, params, notify = false) => {
    const id = notify ? undefined : nextId++;
    const res = await fetchImpl(conn.url, {method: "POST", headers: headers(), body: JSON.stringify(notify ? {jsonrpc: "2.0", method, params} : {jsonrpc: "2.0", id, method, params}), timeoutMs: 20000, maxBytes: 1024 * 1024});
    if (res.status === 401 || res.status === 403) throw new Error("The connector refused the access token. Update it in Settings → Connectors.");
    if (res.status >= 400) throw new Error(`The connector returned HTTP ${res.status}.`);
    const sid = res.headers && res.headers.get && res.headers.get("mcp-session-id");
    if (sid) session = sid;
    return notify ? null : parseRpc(res.text, res.contentType, id);
  };
  return {
    async init() {
      const result = await rpc("initialize", {protocolVersion: PROTOCOL, capabilities: {}, clientInfo: {name: "Accaza AI", version: "1.0"}});
      await rpc("notifications/initialized", {}, true).catch(() => null);
      return result;
    },
    listTools: async () => (await rpc("tools/list", {})).tools || [],
    callTool: async (name, args) => rpc("tools/call", {name, arguments: args || {}}),
  };
}

function toolSummary(t) {
  const readOnly = Boolean(t.annotations && t.annotations.readOnlyHint === true);
  return {name: cleanLine(t.name, 64), description: cleanLine(t.description || t.title || t.name, 500), inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {type: "object", properties: {}}, readOnly};
}

async function addConnector(db, uid, data, tokenKey, now, fetchImpl) {
  const name = cleanLine(data.name, 40), url = String(data.url || "").trim();
  if (!name) throw new HttpsError("invalid-argument", "Give the connector a name.");
  try { await assertPublicUrl(url); } catch (error) { throw new HttpsError("invalid-argument", error.message); }
  if (!/^https:/i.test(url)) throw new HttpsError("invalid-argument", "Connector addresses must start with https://");
  const col = db.collection("users").doc(uid).collection("connectors");
  const count = (await col.where("type", "==", "mcp").get()).size;
  if (count >= MAX_CONNECTORS) throw new HttpsError("resource-exhausted", `Up to ${MAX_CONNECTORS} connectors.`);
  const token = String(data.token || "").trim();
  const conn = {type: "mcp", name, url, headerName: cleanLine(data.headerName, 60) || "authorization", allowWrites: data.allowWrites === true, tokenEnc: token ? encrypt(token, tokenKey) : null};
  let tools;
  try { const c = client(conn, tokenKey, fetchImpl); await c.init(); tools = (await c.listTools()).slice(0, MAX_TOOLS).map(toolSummary); }
  catch (error) { throw new HttpsError("failed-precondition", `Could not connect: ${cleanLine(error.message, 200)}`); }
  const id = "mcp_" + crypto.randomBytes(5).toString("hex");
  await col.doc(id).set(Object.assign(conn, {tools, createdAt: now, updatedAt: now}));
  return {id, name, tools: tools.map(t => ({name: t.name, readOnly: t.readOnly}))};
}

// Tools offered to the model for one account's MCP connectors. Names are made unique and safe:
// <connector-slug>__<tool> (letters, digits, underscore; max 64 chars).
function mcpTools(conns, tokenKey, fetchImpl) {
  const map = new Map(), declarations = [];
  for (const conn of conns) {
    const slug = conn.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 20) || "mcp";
    for (const t of conn.tools || []) {
      if (!t.readOnly && !conn.allowWrites) continue;
      const toolName = `${slug}__${t.name.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 64);
      if (map.has(toolName)) continue;
      map.set(toolName, {conn, tool: t});
      declarations.push({name: toolName, description: `[${conn.name}] ${t.description}`.slice(0, 900), parameters: sanitizeSchema(t.inputSchema)});
    }
  }
  if (!declarations.length) return null;
  const clients = new Map();
  return {
    declarations,
    labels: Object.fromEntries([...map.entries()].map(([n, v]) => [n, () => `Using ${v.conn.name}: ${v.tool.name}`])),
    run: async (name, args) => {
      const hit = map.get(name);
      if (!hit) return {error: "Unknown connector tool."};
      try {
        let c = clients.get(hit.conn);
        if (!c) { c = client(hit.conn, tokenKey, fetchImpl); await c.init(); clients.set(hit.conn, c); }
        const result = await c.callTool(hit.tool.name, args);
        const text = (result && result.content || []).map(part => part.type === "text" ? part.text : part.type === "resource" && part.resource && part.resource.text ? part.resource.text : `[${part.type}]`).join("\n");
        return {connector: hit.conn.name, isError: result && result.isError === true, text: text.slice(0, 11000), structured: result && result.structuredContent ? result.structuredContent : undefined};
      } catch (error) { return {error: cleanLine(error.message, 300)}; }
    },
  };
}
// Gemini accepts a subset of JSON Schema; drop keywords it rejects.
function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 6) return {type: "object", properties: {}};
  const allowed = ["type", "description", "properties", "required", "items", "enum", "format", "minimum", "maximum", "nullable"];
  const out = {};
  for (const key of allowed) if (schema[key] !== undefined) out[key] = schema[key];
  if (Array.isArray(out.type)) out.type = out.type.find(t => t !== "null") || "string";
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).slice(0, 40).map(([k, v]) => [k, sanitizeSchema(v, depth + 1)]));
  if (out.items) out.items = sanitizeSchema(out.items, depth + 1);
  if (!out.type) out.type = out.properties ? "object" : "string";
  return out;
}
module.exports = {PROTOCOL, MAX_TOOLS, parseRpc, client, toolSummary, addConnector, mcpTools, sanitizeSchema};
