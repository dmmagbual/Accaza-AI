"use strict";
// Canvas (Danilo, 26 Sep 2026): ChatGPT-style canvas for pages, apps and long code, with
// versions, targeted AI edits, and publishing to https://accaza-sites.web.app/<slug>.
// users/{uid}/canvases/{id}            {title, kind: "html"|"react", chatId, code, version, published: {slug, at}|null, createdAt, updatedAt}
// users/{uid}/canvases/{id}/versions/N {code, at, by: "ai"|"user", note}
// sites/{slug}                         {uid, canvasId, title, html, publishedAt, updatedAt}
// siteAssets/{id}                      {uid, mimeType, data (bytes), createdAt}
// Published pages are served from a different site (origin) than the app and with a strict
// Content-Security-Policy: they cannot send data anywhere (no fetch, no form posts).
const crypto = require("crypto");
const {HttpsError} = require("firebase-functions/v2/https");

const SITES_ORIGIN = "https://accaza-sites.web.app";
const MAX_CODE = 400000;
const MAX_VERSIONS_KEPT = 50;
const PUBLISH_TIERS = ["owner", "staff"];
const RESERVED = new Set(["a", "api", "admin", "assets", "static", "login", "app", "www", "index", "favicon.ico", "robots.txt", "sitemap.xml"]);
const LIBS = {
  react: "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
  reactDom: "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js",
  babel: "https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js",
  tailwind: "https://cdn.tailwindcss.com/3.4.16",
};
// CSP for published sites: scripts/styles/images/fonts from https CDNs, nothing can be sent out.
const SITE_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; frame-src https://www.google.com https://www.youtube.com https://www.youtube-nocookie.com https://maps.google.com";

function clean(value, max) { return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max); }
function cleanLine(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function slugify(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}
function validSlug(slug) { return /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(slug) && !RESERVED.has(slug); }

// Turns canvas code into a full HTML document. React canvases are one component file
// (`export default function App() {...}`), compiled in the browser with Babel, styled with Tailwind.
function buildDocument(kind, code, {errorHook = false} = {}) {
  const hook = errorHook ? `<script>(function(){function send(m){try{parent.postMessage({type:"canvas-error",message:String(m).slice(0,500)},"*")}catch(e){}}window.addEventListener("error",function(e){send(e.message+(e.lineno?" (line "+e.lineno+")":""))});window.addEventListener("unhandledrejection",function(e){send(e.reason&&e.reason.message||e.reason)});var ce=console.error;console.error=function(){send([].slice.call(arguments).join(" "));ce.apply(console,arguments)}})();</script>` : "";
  if (kind === "react") {
    const body = String(code || "")
      .replace(/^\s*import\s+React[^;\n]*;?\s*$/gm, "")
      .replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]react['"];?\s*$/gm, (m, names) => `const {${names}} = React;`)
      .replace(/^\s*import\s+[^;\n]*from\s+['"][^'"]+['"];?\s*$/gm, "")
      .replace(/export\s+default\s+function\s+([A-Za-z0-9_]+)/, "function $1")
      .replace(/export\s+default\s+([A-Za-z0-9_]+)\s*;?/, "window.__App = $1;");
    const name = (String(code).match(/export\s+default\s+function\s+([A-Za-z0-9_]+)/) || [])[1];
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${hook}<script src="${LIBS.tailwind}"></script><script src="${LIBS.react}"></script><script src="${LIBS.reactDom}"></script><script src="${LIBS.babel}"></script></head><body><div id="root"></div><script type="text/babel" data-presets="react">const {useState,useEffect,useMemo,useRef,useCallback,useReducer,Fragment} = React;\n${body}\n${name ? `window.__App = ${name};` : ""}\nReactDOM.createRoot(document.getElementById("root")).render(React.createElement(window.__App || (() => React.createElement("p", null, "No component exported."))));</script></body></html>`;
  }
  const html = String(code || "");
  if (!hook) return html;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + hook) : hook + html;
}

// Applies exact find/replace edits. Every `find` must appear exactly once, so an edit can never
// silently change the wrong place; the AI is told which edit failed and can retry.
function applyEdits(code, edits) {
  let out = String(code || "");
  const list = Array.isArray(edits) ? edits.slice(0, 30) : [];
  if (!list.length) return {error: "No edits given."};
  for (let i = 0; i < list.length; i += 1) {
    const find = String(list[i] && list[i].find || ""), replace = String(list[i] && list[i].replace || "");
    if (!find) return {error: `Edit ${i + 1}: "find" is empty.`};
    const first = out.indexOf(find);
    if (first < 0) return {error: `Edit ${i + 1}: the text to find was not found. Copy it exactly from the current canvas.`};
    if (out.indexOf(find, first + find.length) >= 0) return {error: `Edit ${i + 1}: the text to find appears more than once. Include more surrounding lines.`};
    out = out.slice(0, first) + replace + out.slice(first + find.length);
  }
  if (out.length > MAX_CODE) return {error: "The canvas would be too large."};
  return {code: out};
}

function canvasCol(db, uid) { return db.collection("users").doc(uid).collection("canvases"); }
async function getCanvas(db, uid, id) {
  if (!/^[A-Za-z0-9]{1,40}$/.test(String(id || ""))) throw new HttpsError("not-found", "That canvas was not found.");
  const ref = canvasCol(db, uid).doc(String(id)), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "That canvas was not found.");
  return {id: ref.id, ref, data: snap.data()};
}
async function saveVersion(db, canvas, code, by, note, now) {
  const version = Number(canvas.data.version || 0) + 1;
  const batch = db.batch();
  batch.set(canvas.ref.collection("versions").doc(String(version)), {code, at: now, by, note: cleanLine(note, 200)});
  batch.set(canvas.ref, {code, version, updatedAt: now}, {merge: true});
  const old = version - MAX_VERSIONS_KEPT;
  if (old > 1) batch.delete(canvas.ref.collection("versions").doc(String(old)));
  await batch.commit();
  canvas.data.code = code; canvas.data.version = version;
  return version;
}
async function createCanvas(db, uid, {title, kind, code, chatId}, now) {
  const body = clean(code, MAX_CODE + 1);
  if (!body.trim()) return {error: "The canvas code is empty."};
  if (body.length > MAX_CODE) return {error: "The canvas is too large (400,000 characters max)."};
  const ref = canvasCol(db, uid).doc();
  const data = {title: cleanLine(title, 80) || "Untitled", kind: kind === "react" ? "react" : "html", chatId: chatId || null, code: body, version: 1, published: null, createdAt: now, updatedAt: now};
  const batch = db.batch();
  batch.set(ref, data);
  batch.set(ref.collection("versions").doc("1"), {code: body, at: now, by: "ai", note: "Created"});
  await batch.commit();
  return {id: ref.id, title: data.title, kind: data.kind, version: 1};
}

// The block describing the open canvas for the AI (current code included, capped).
function canvasBlock(canvas, selection) {
  const parts = [
    "Canvas: when the user asks for a web page, website, landing page, app, game, component, dashboard or any long piece of code, put it in a canvas instead of the chat. Use create_canvas with kind \"html\" (one complete self-contained HTML document with inline CSS and JS; it may load libraries from https://cdn.jsdelivr.net or https://unpkg.com) or kind \"react\" (one file exporting a default function component; Tailwind classes available; React hooks are global). Make pages responsive, accessible and good-looking, with real content, not lorem ipsum. For images use the user's site images if given, otherwise https://picsum.photos/seed/<word>/<w>/<h>. Published pages cannot send data anywhere, so do not build login, payment or data-collection forms. The preview runs sandboxed, so wrap any localStorage use in try/catch. To change the open canvas prefer edit_canvas with exact find/replace snippets copied from the current code; use rewrite_canvas only for large changes. After a canvas tool succeeds, reply in 1-3 sentences describing what you built or changed. Never paste the code into the chat.",
  ];
  if (canvas) {
    const code = String(canvas.data.code || "");
    parts.push(`The open canvas is "${canvas.data.title}" (${canvas.data.kind}, version ${canvas.data.version}). Its current code:\n<<<CANVAS\n${code.length > 120000 ? code.slice(0, 120000) + "\n…(truncated)" : code}\nCANVAS>>>`);
  }
  if (selection) parts.push(`The user selected this part of the canvas and their message is about it:\n<<<SELECTION\n${clean(selection, 8000)}\nSELECTION>>>`);
  return parts.join("\n\n");
}
const TOOL_DECLARATIONS = [
  {name: "create_canvas", description: "Create a new canvas (web page or React component) and show it beside the chat.", parameters: {type: "object", properties: {title: {type: "string", description: "Short title, e.g. \"Accaza landing page\"."}, kind: {type: "string", enum: ["html", "react"]}, code: {type: "string", description: "The complete code."}}, required: ["title", "kind", "code"]}},
  {name: "edit_canvas", description: "Make targeted changes to the open canvas. Each edit replaces one exact snippet that appears once in the current code.", parameters: {type: "object", properties: {edits: {type: "array", items: {type: "object", properties: {find: {type: "string"}, replace: {type: "string"}}, required: ["find", "replace"]}}, summary: {type: "string", description: "What changed, in a few words."}}, required: ["edits"]}},
  {name: "rewrite_canvas", description: "Replace the open canvas's whole code (for large changes).", parameters: {type: "object", properties: {code: {type: "string"}, summary: {type: "string"}}, required: ["code"]}},
];
// Canvas tools for one request. state.canvas is the open canvas (or null) and is updated as tools run.
function canvasTools(db, uid, state, now, onChange) {
  return {
    declarations: TOOL_DECLARATIONS,
    labels: {create_canvas: a => `Building “${cleanLine(a.title, 60) || "canvas"}”`, edit_canvas: () => "Editing the canvas", rewrite_canvas: () => "Rewriting the canvas"},
    run: async (name, args) => {
      if (name === "create_canvas") {
        const made = await createCanvas(db, uid, {title: args.title, kind: args.kind, code: args.code, chatId: state.chatId}, now);
        if (made.error) return made;
        state.canvas = await getCanvas(db, uid, made.id);
        onChange({id: made.id, title: made.title, kind: made.kind, version: 1, action: "created"});
        return {ok: true, canvasId: made.id, version: 1};
      }
      if (!state.canvas) return {error: "No canvas is open. Use create_canvas first."};
      let code;
      if (name === "edit_canvas") { const r = applyEdits(state.canvas.data.code, args.edits); if (r.error) return r; code = r.code; }
      else if (name === "rewrite_canvas") { code = clean(args.code, MAX_CODE + 1); if (!code.trim()) return {error: "The new code is empty."}; if (code.length > MAX_CODE) return {error: "Too large."}; }
      else return {error: "Unknown canvas tool."};
      const version = await saveVersion(db, state.canvas, code, "ai", args.summary || (name === "edit_canvas" ? "AI edit" : "AI rewrite"), now);
      onChange({id: state.canvas.id, title: state.canvas.data.title, kind: state.canvas.data.kind, version, action: "updated"});
      return {ok: true, version};
    },
  };
}
// Should this turn run in canvas mode (canvas tools, long outputs, longer time budget)?
const CANVAS_INTENT = /\b(website|web ?site|web ?page|landing page|homepage|home page|html|css|javascript|react|component|app\b|web app|game|dashboard|portfolio|template|canvas|ui|mock ?up|prototype|calculator|form|page for)\b/i;
function canvasMode(question, hasOpenCanvas) { return Boolean(hasOpenCanvas) || CANVAS_INTENT.test(String(question || "")); }

// ---------- Publishing ----------
async function publish(db, uid, canvasId, wantedSlug, now) {
  const canvas = await getCanvas(db, uid, canvasId);
  let slug = slugify(wantedSlug || (canvas.data.published && canvas.data.published.slug) || canvas.data.title);
  if (!validSlug(slug)) slug = `site-${crypto.randomBytes(3).toString("hex")}`;
  const ref = db.collection("sites").doc(slug);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && !(snap.data().uid === uid && snap.data().canvasId === canvasId)) throw new HttpsError("already-exists", `The address "${slug}" is taken. Choose another name.`);
    tx.set(ref, {uid, canvasId, title: canvas.data.title, html: buildDocument(canvas.data.kind, canvas.data.code), version: canvas.data.version, publishedAt: snap.exists ? snap.data().publishedAt : now, updatedAt: now});
  });
  const previous = canvas.data.published && canvas.data.published.slug;
  if (previous && previous !== slug) { const old = await db.collection("sites").doc(previous).get(); if (old.exists && old.data().uid === uid) await old.ref.delete(); }
  await canvas.ref.set({published: {slug, at: now, version: canvas.data.version}}, {merge: true});
  return {slug, url: `${SITES_ORIGIN}/${slug}`};
}
async function unpublish(db, uid, canvasId) {
  const canvas = await getCanvas(db, uid, canvasId);
  const slug = canvas.data.published && canvas.data.published.slug;
  if (slug) { const s = await db.collection("sites").doc(slug).get(); if (s.exists && s.data().uid === uid) await s.ref.delete(); }
  await canvas.ref.set({published: null}, {merge: true});
  return {unpublished: true};
}
function publicCanvas(id, c) {
  return {id, title: c.title, kind: c.kind, version: c.version, chatId: c.chatId || null, updatedAt: c.updatedAt, published: c.published ? {slug: c.published.slug, url: `${SITES_ORIGIN}/${c.published.slug}`, version: c.published.version} : null};
}

// Serves published sites and site images (runs behind the accaza-sites Hosting site).
async function serveSite(db, path) {
  const parts = String(path || "/").split("?")[0].split("/").filter(Boolean);
  if (parts[0] === "a" && /^[A-Za-z0-9]{1,40}$/.test(parts[1] || "")) {
    const snap = await db.collection("siteAssets").doc(parts[1]).get();
    if (!snap.exists) return {status: 404, type: "text/plain", body: "Not found"};
    return {status: 200, type: snap.data().mimeType, body: Buffer.from(snap.data().data), cache: "public, max-age=31536000, immutable"};
  }
  const slug = (parts[0] || "").toLowerCase();
  if (!slug) return {status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><title>Accaza Sites</title><p style=\"font-family:sans-serif;padding:2rem\">Sites made with Accaza AI.</p>", cache: "public, max-age=300"};
  if (!validSlug(slug)) return {status: 404, type: "text/html; charset=utf-8", body: "<!doctype html><title>Not found</title><p style=\"font-family:sans-serif;padding:2rem\">This page does not exist.</p>"};
  const snap = await db.collection("sites").doc(slug).get();
  if (!snap.exists) return {status: 404, type: "text/html; charset=utf-8", body: "<!doctype html><title>Not found</title><p style=\"font-family:sans-serif;padding:2rem\">This page does not exist or was unpublished.</p>"};
  return {status: 200, type: "text/html; charset=utf-8", body: snap.data().html, cache: "public, max-age=60, s-maxage=60", csp: SITE_CSP};
}
async function saveAsset(db, uid, file, now) {
  const ref = db.collection("siteAssets").doc();
  await ref.set({uid, mimeType: file.mimeType, data: file.bytes, size: file.bytes.length, createdAt: now});
  return {id: ref.id, url: `${SITES_ORIGIN}/a/${ref.id}`};
}

module.exports = {SITES_ORIGIN, SITE_CSP, MAX_CODE, PUBLISH_TIERS, slugify, validSlug, buildDocument, applyEdits, getCanvas, saveVersion, createCanvas, canvasBlock, canvasTools, canvasMode, publish, unpublish, publicCanvas, serveSite, saveAsset, canvasCol, TOOL_DECLARATIONS};
