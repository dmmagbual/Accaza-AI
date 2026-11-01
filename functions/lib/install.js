"use strict";
// Install from a link (1 Nov 2026): a skill or a plugin package is fetched once, unpacked and
// installed into the caller's skills, so people do not have to build a .zip by hand.
//   - a skill: a .zip with a SKILL.md, a bare SKILL.md, or a GitHub repo/folder holding one.
//   - a plugin: a .zip (or repo) with .claude-plugin/plugin.json or plugin.json, which lists the
//     skills it bundles. Every skill it declares is installed under its own entry.
// Safety: the link goes through the SSRF guard (netguard.safeFetch), sizes are capped, nothing is
// written outside Firestore, and scripts are never run: only SKILL.md text and reference files are
// kept. A plugin's MCP servers are reported, never connected on the user's behalf.
const {HttpsError} = require("firebase-functions/v2/https");
const {unzipSync} = require("fflate");
const {safeFetch} = require("./netguard");
const Skills = require("./skills");
const Catalog = require("./catalog");

const LIMITS = {
  bytes: 25 * 1024 * 1024,
  unpacked: 40 * 1024 * 1024,
  skills: 20,
  filesPerSkill: 20,
};
const TEXT_EXT = /\.(md|markdown|txt|csv|json|html?|xml|ya?ml)$/i;

function clean(value, max) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}
function cleanLine(value, max) { return clean(value, max).replace(/\s+/g, " "); }

// Turns a pasted link into the address we actually download, plus the folder to read inside it.
// github.com/owner/repo -> the repo's zipball; /tree/<branch>/<path> -> that branch's zipball,
// scoped to <path>; /blob/<branch>/<file> -> the raw file.
function sourceUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch (_error) { throw new HttpsError("invalid-argument", "Paste a full link that starts with https://"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new HttpsError("invalid-argument", "Paste a public https:// link.");
  const host = url.hostname.toLowerCase().replace(/^www\./, ""), parts = url.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 2) {
    const owner = parts[0], repo = parts[1].replace(/\.git$/i, ""), kind = parts[2], rest = parts.slice(3);
    if ((kind === "blob" || kind === "raw") && rest.length >= 2) return {url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`, subpath: "", label: `${owner}/${repo}`};
    if (kind === "tree" && rest.length) return {url: `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${rest[0]}`, subpath: rest.slice(1).join("/"), label: `${owner}/${repo}`};
    if (!kind) return {url: `https://codeload.github.com/${owner}/${repo}/zip/HEAD`, subpath: "", label: `${owner}/${repo}`};
  }
  return {url: url.toString(), subpath: "", label: host};
}

function isSkipped(name) {
  return name.split("/").some(part => part === "__MACOSX" || part.startsWith("._") || (part.startsWith(".") && part !== ".claude-plugin"));
}

// Unpacks an archive in memory, capped, dropping scripts and system folders.
function readArchive(bytes) {
  let total = 0;
  const entries = unzipSync(new Uint8Array(bytes), {filter: file => {
    total += file.originalSize || 0;
    if (total > LIMITS.unpacked) throw new HttpsError("invalid-argument", "That archive unpacks to more than 40 MB.");
    return !file.name.endsWith("/") && !isSkipped(file.name);
  }});
  return stripRoot(entries);
}
// GitHub zipballs wrap everything in one <repo>-<branch>/ folder; remove it.
function stripRoot(entries) {
  const names = Object.keys(entries);
  if (!names.length) return entries;
  const roots = new Set(names.map(name => (name.includes("/") ? name.split("/")[0] : "")));
  if (roots.size !== 1 || roots.has("")) return entries;
  const root = [...roots][0];
  return Object.fromEntries(names.map(name => [name.slice(root.length + 1), entries[name]]));
}
function onlyUnder(entries, subpath) {
  const prefix = String(subpath || "").replace(/^\.?\/*|\/+$/g, "");
  if (!prefix) return entries;
  const out = {};
  for (const [name, bytes] of Object.entries(entries)) if (name === prefix || name.startsWith(prefix + "/")) out[name === prefix ? "" : name.slice(prefix.length + 1)] = bytes;
  return out;
}

// Every folder in the archive that holds a SKILL.md, shallowest first.
function skillDirs(entries) {
  return [...new Set(Object.keys(entries).filter(name => /(^|\/)SKILL\.md$/i.test(name)).map(name => name.replace(/\/?SKILL\.md$/i, "")))]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
function findKey(entries, path) {
  const wanted = String(path || "").toLowerCase();
  return Object.keys(entries).find(name => name.toLowerCase() === wanted);
}
// One skill folder: the parsed SKILL.md plus its reference files (text inline, PDFs as bytes).
function readSkill(entries, dir) {
  const key = findKey(entries, (dir ? dir + "/" : "") + "SKILL.md");
  if (!key) return null;
  const parsed = Skills.parseSkillMd(Buffer.from(entries[key]).toString("utf8"));
  const prefix = dir ? dir + "/" : "", files = [], skipped = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith(prefix) || name === key) continue;
    const rel = name.slice(prefix.length);
    if (TEXT_EXT.test(name)) files.push({name: rel, text: Buffer.from(bytes).toString("utf8")});
    else if (/\.pdf$/i.test(name)) files.push({name: rel, pdf: Buffer.from(bytes)});
    else skipped.push(rel.split("/").pop());
  }
  const fallbackName = cleanLine(dir.split("/").filter(Boolean).pop(), 60) || "Installed skill";
  const name = cleanLine(parsed.name, 60) || fallbackName;
  const firstLine = cleanLine(String(parsed.instructions || "").split("\n").find(line => line.trim() && !/^#/.test(line.trim())) || "", 200);
  const description = cleanLine(parsed.description, 400) || firstLine || `Reference material installed from a link (${name}).`;
  return {
    name,
    description,
    instructions: parsed.instructions || "",
    files: files.slice(0, LIMITS.filesPerSkill),
    notes: skipped.length ? [`Skipped files that cannot run here: ${skipped.slice(0, 10).join(", ")}`] : [],
  };
}

// A plugin manifest, if the package carries one (Claude plugin layout).
function pluginManifest(entries) {
  for (const path of [".claude-plugin/plugin.json", "plugin.json"]) {
    const key = findKey(entries, path);
    if (!key) continue;
    try { return JSON.parse(Buffer.from(entries[key]).toString("utf8")); }
    catch (_error) { throw new HttpsError("invalid-argument", "The plugin.json in that package could not be read."); }
  }
  return null;
}
// The skills a manifest points at, e.g. "skills": ["./skills/barista"] (or [{path}]).
function declaredDirs(manifest, entries) {
  const declared = manifest && Array.isArray(manifest.skills) ? manifest.skills : [];
  const dirs = [];
  for (const entry of declared) {
    const raw = typeof entry === "string" ? entry : entry && (entry.path || entry.dir || entry.source) || "";
    const path = String(raw).trim().replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/SKILL\.md$/i, "").replace(/^\.$/, "");
    if (path || raw === ".") dirs.push(path);
  }
  return dirs.filter(dir => findKey(entries, (dir ? dir + "/" : "") + "SKILL.md"));
}

// A .zip package: a plugin (manifest or several skills) or a single skill.
function packageFromEntries(entries) {
  const all = skillDirs(entries);
  if (!all.length) throw new HttpsError("invalid-argument", "That package has no SKILL.md, so there is nothing to install.");
  const manifest = pluginManifest(entries);
  const selected = manifest ? declaredDirs(manifest, entries) : all;
  const dirs = (selected.length ? selected : all).slice(0, LIMITS.skills);
  if (!manifest && !selected.length) throw new HttpsError("invalid-argument", "That plugin does not declare any skills that exist in the package.");
  const skills = dirs.map(dir => readSkill(entries, dir)).filter(Boolean);
  if (!skills.length) throw new HttpsError("invalid-argument", "That package has no readable SKILL.md.");
  const mcpServers = manifest && manifest.mcpServers && typeof manifest.mcpServers === "object" ? Object.keys(manifest.mcpServers) : [];
  const kind = manifest || skills.length > 1 ? "plugin" : "skill";
  return {
    kind,
    plugin: kind === "plugin" ? {name: cleanLine(manifest && manifest.name, 60), description: cleanLine(manifest && manifest.description, 300), version: cleanLine(manifest && manifest.version, 20), mcpServers} : null,
    skills,
    notes: skills.flatMap(skill => skill.notes),
  };
}
// A bare SKILL.md.
function packageFromText(text) {
  const parsed = Skills.parseSkillMd(String(text || ""));
  if (!parsed.instructions && !parsed.description) throw new HttpsError("invalid-argument", "That link does not contain a skill (no SKILL.md text).");
  const name = parsed.name || "Installed skill";
  return {
    kind: "skill",
    plugin: null,
    skills: [{
      name,
      description: parsed.description || cleanLine(parsed.instructions.split("\n").find(line => line.trim() && !/^#/.test(line.trim())) || "", 200) || `Installed from a link (${name}).`,
      instructions: parsed.instructions || "",
      files: [],
      notes: [],
    }],
    notes: [],
  };
}

function looksLikeZip(bytes) { return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07); }
function looksLikeSkillMd(text) { return /^\uFEFF?---\s*\n[\s\S]*?name\s*:/i.test(text) || /^\uFEFF?---\s*\n/i.test(text) || /^\s*#\s+\S/m.test(text); }

// Downloads and reads a skill or plugin package. `fetchImpl` is only for tests; production always
// goes through the SSRF-guarded safeFetch.
async function loadPackage(raw, options = {}) {
  const source = sourceUrl(raw);
  const get = options.fetchImpl || safeFetch;
  let res;
  try { res = await get(source.url, {timeoutMs: 30000, maxBytes: LIMITS.bytes, lookup: options.lookup}); }
  catch (error) { throw new HttpsError("failed-precondition", `Could not download that link: ${cleanLine(error && error.message, 160)}`); }
  if (!res || res.status >= 400) throw new HttpsError("failed-precondition", `That link returned HTTP ${res && res.status}. Check that it is public.`);
  const bytes = res.bytes ? Buffer.from(res.bytes) : Buffer.from(String(res.text || ""), "utf8");
  if (!bytes.length) throw new HttpsError("invalid-argument", "That link returned nothing.");
  const notes = [];
  let pkg;
  if (looksLikeZip(bytes)) {
    let entries;
    try { entries = onlyUnder(readArchive(bytes), source.subpath); } catch (error) { if (error instanceof HttpsError) throw error; throw new HttpsError("invalid-argument", "That .zip could not be opened."); }
    pkg = packageFromEntries(entries);
  } else {
    const text = bytes.toString("utf8"), contentType = String(res.contentType || "").toLowerCase();
    if (contentType.includes("html") || /^\s*<(!doctype|html)/i.test(text)) throw new HttpsError("invalid-argument", "That link is a web page. Use a GitHub repo, a skill .zip or a raw SKILL.md link.");
    if (contentType.includes("json") || /^\s*\{/.test(text)) throw new HttpsError("invalid-argument", "That is a plugin.json on its own. Open the plugin's folder or paste its .zip / repo link instead.");
    if (!looksLikeSkillMd(text)) throw new HttpsError("invalid-argument", "That link is not a skill. Paste a GitHub repo, a skill .zip or a raw SKILL.md link.");
    pkg = packageFromText(text);
  }
  if (pkg.plugin && !pkg.plugin.name) pkg.plugin.name = source.label;
  return Object.assign(pkg, {source, notes: [...notes, ...pkg.notes]});
}

// One-tap install of a built-in catalogue entry (a single skill or a pack of skills).
async function installTemplate(db, key, actor, data, now) {
  const template = Catalog.findTemplate(data && data.templateId);
  if (!template) throw new HttpsError("invalid-argument", "That skill or pack was not found.");
  const source = {kind: "catalog", template: template.id, plugin: template.kind === "plugin" ? template.name : "", host: "Accaza AI", installedAt: now};
  const installed = [];
  for (const skill of Catalog.templateSkills(template)) installed.push(await Skills.installSkill(db, key, actor, skill, source, now));
  return {template: template.id, kind: template.kind, name: template.name, skills: installed};
}

// Installs everything a link contains. Returns what was installed so the app can show it.
async function installFromUrl(db, key, actor, data, now, options = {}) {
  const raw = String((data && data.url) || "").trim();
  if (!raw) throw new HttpsError("invalid-argument", "Paste a skill or plugin link.");
  if (raw.length > 500) throw new HttpsError("invalid-argument", "That link is too long.");
  const pkg = await loadPackage(raw, options);
  const source = {kind: pkg.kind, url: raw, downloadUrl: pkg.source.url, host: pkg.source.label || "", plugin: (pkg.plugin && pkg.plugin.name) || "", installedAt: now};
  const installed = [];
  for (const skill of pkg.skills) installed.push(await Skills.installSkill(db, key, actor, skill, source, now));
  const notes = [...pkg.notes, ...installed.flatMap(skill => skill.notes)];
  if (pkg.plugin && pkg.plugin.mcpServers.length) notes.push(`This plugin also offers MCP servers (${pkg.plugin.mcpServers.join(", ")}). Add them under Settings → Connectors if you want them.`);
  return {kind: pkg.kind, plugin: pkg.plugin, skills: installed, notes};
}

// The chat tool: the assistant installs a link the user handed it, the way a real AI app does it
// for you. It only fires when the model decides to; the description keeps that to explicit asks.
function installTool({db, key, actor, now, options}) {
  return {
    declarations: [{
      name: "install_skill",
      description: "Install a skill or plugin from a link the user gave you: a GitHub repo or folder, a skill .zip, or a raw SKILL.md. Call this only when the user explicitly asks to install that link. It is added to their skills immediately and applies from the next message.",
      parameters: {type: "object", properties: {url: {type: "string", description: "The exact link the user pasted."}}, required: ["url"]},
    }],
    labels: {install_skill: args => `Installing ${cleanLine(args && args.url, 80)}`},
    run: async (name, args) => {
      if (name !== "install_skill") return {error: "Unknown tool."};
      try {
        const out = await installFromUrl(db, key, actor, {url: args && args.url}, now, options);
        return {installed: out.skills.map(s => ({name: s.name, files: s.files.length, updated: s.updated})), kind: out.kind, plugin: (out.plugin && out.plugin.name) || "", notes: out.notes.slice(0, 6)};
      } catch (error) { return {error: cleanLine(error && error.message, 300)}; }
    },
  };
}

module.exports = {LIMITS, sourceUrl, readArchive, onlyUnder, skillDirs, readSkill, pluginManifest, declaredDirs, packageFromEntries, packageFromText, looksLikeZip, loadPackage, installFromUrl, installTemplate, installTool, templates: Catalog.listTemplates};
