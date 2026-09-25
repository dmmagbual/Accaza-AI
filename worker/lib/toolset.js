"use strict";
// Tools a laptop task can use. Code and file tools act inside the Docker sandbox; web tools and
// skills reuse the chat's own implementations (functions/lib), so caps and SSRF guards match.
const {clip} = require("./sandbox");

const MAX_WRITE_CHARS = 400000;
const CODE_TIMEOUT = {default: 120, max: 600};

const DECLARATIONS = [
  {name: "update_plan", description: "Show the user your plan as a checklist and keep it current. Call it at the start of any multi-step task and whenever a step is done or the plan changes. Send the whole list each time.",
    parameters: {type: "object", properties: {steps: {type: "array", items: {type: "object", properties: {text: {type: "string"}, done: {type: "boolean"}}, required: ["text", "done"]}}}, required: ["steps"]}},
  {name: "run_python", description: "Run Python 3.12 code in the sandbox (working directory /workspace). Print what you need to see. Libraries: pandas, numpy, matplotlib, openpyxl, xlsxwriter, python-docx, python-pptx, reportlab, pypdf, pdfplumber, pillow, bs4, lxml, jinja2, markdown, tabulate. There is no internet access and pip install does not work.",
    parameters: {type: "object", properties: {code: {type: "string", description: "Python source code."}, timeout_seconds: {type: "integer", description: "Default 120, max 600."}}, required: ["code"]}},
  {name: "run_shell", description: "Run a bash script in the sandbox (Debian, working directory /workspace). Tools include ls, cat, grep, sed, awk, zip, unzip, file, jq, pdftotext. No internet access.",
    parameters: {type: "object", properties: {command: {type: "string"}, timeout_seconds: {type: "integer"}}, required: ["command"]}},
  {name: "write_file", description: "Create or overwrite a text file (code, Markdown, CSV, HTML, JSON…). Paths are relative to /workspace. Put files the user should receive in outputs/. For Word, Excel, PowerPoint or PDF files, write a Python script that builds them and run it.",
    parameters: {type: "object", properties: {path: {type: "string"}, content: {type: "string"}}, required: ["path", "content"]}},
  {name: "read_file", description: "Read a text file from /workspace or a mounted folder (up to 20,000 characters). For binary files (xlsx, docx, pdf, images) use run_python with the right library.",
    parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}},
  {name: "list_files", description: "List files under a folder (default /workspace), up to 3 levels deep.",
    parameters: {type: "object", properties: {path: {type: "string"}}}},
  {name: "ask_user", description: "Ask the user a question and pause until they answer. Only use this when you cannot continue without a decision or a fact only they have; otherwise make a sensible assumption, state it, and carry on.",
    parameters: {type: "object", properties: {question: {type: "string"}}, required: ["question"]}},
];

function firstLine(text, max = 90) { return String(text || "").split("\n").map(s => s.trim()).find(Boolean)?.slice(0, max) || ""; }
function shortPath(p) { return String(p || "").replace(/^\/workspace\/?/, "") || "workspace"; }

function labelFor(name, args, extraLabel) {
  const a = args || {};
  switch (name) {
    case "update_plan": return "Updated the plan";
    case "run_python": return `Running Python${firstLine(a.code) ? `: ${firstLine(a.code, 70)}` : ""}`;
    case "run_shell": return `Running: ${firstLine(a.command, 80)}`;
    case "write_file": return `Writing ${shortPath(a.path)}`;
    case "read_file": return `Reading ${shortPath(a.path)}`;
    case "list_files": return `Listing ${shortPath(a.path || "/workspace")}`;
    case "ask_user": return "Asked you a question";
    default: return extraLabel ? extraLabel(name, a) : name.replace(/_/g, " ");
  }
}
// What the activity log shows under a step (never the full file contents).
function detailFor(name, args, result) {
  const a = args || {}, r = result || {};
  if (r.error) return clip(`Error: ${r.error}`, 1500);
  switch (name) {
    case "run_python": return clip(`${String(a.code || "").slice(0, 700)}\n--- output ---\n${r.stdout || ""}${r.stderr ? `\n--- errors ---\n${r.stderr}` : ""}${r.note ? `\n${r.note}` : ""}`, 1800);
    case "run_shell": return clip(`$ ${String(a.command || "").slice(0, 500)}\n${r.stdout || ""}${r.stderr ? `\n${r.stderr}` : ""}${r.note ? `\n${r.note}` : ""}`, 1800);
    case "write_file": return `${r.bytes || 0} bytes`;
    case "list_files": return clip((r.files || []).map(f => `${shortPath(f.path)} (${f.size} B)`).join("\n"), 1500);
    case "web_search": return clip(r.summary || "", 1200);
    default: return "";
  }
}

// ctx: {sandbox, webTools, skillTools, onPlan(steps)}. Returns {declarations, run, label, detail}.
function buildTools({sandbox, webTools, skillTools, onPlan}) {
  const extra = [webTools, skillTools].filter(t => t && t.declarations && t.declarations.length);
  const extraOwner = new Map();
  extra.forEach(set => set.declarations.forEach(d => { if (!extraOwner.has(d.name)) extraOwner.set(d.name, set); }));
  const declarations = [...DECLARATIONS, ...[...extraOwner.keys()].map(n => extraOwner.get(n).declarations.find(d => d.name === n))];
  const extraLabel = (name, args) => { const set = extraOwner.get(name), fn = set && set.labels && set.labels[name]; try { return fn ? fn(args) : name.replace(/_/g, " "); } catch (_error) { return name; } };
  const timeout = v => Math.max(5, Math.min(CODE_TIMEOUT.max, Number(v) || CODE_TIMEOUT.default));
  async function run(name, args) {
    const a = args && typeof args === "object" ? args : {};
    try {
      switch (name) {
        case "update_plan": {
          const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 30).map(s => ({text: String(s && s.text || "").replace(/\s+/g, " ").trim().slice(0, 160), done: Boolean(s && s.done)})).filter(s => s.text);
          await onPlan(steps);
          return {ok: true, steps: steps.length};
        }
        case "run_python": return await sandbox.runPython(a.code, timeout(a.timeout_seconds));
        case "run_shell": return await sandbox.runShell(a.command, timeout(a.timeout_seconds));
        case "write_file": {
          const content = typeof a.content === "string" ? a.content : JSON.stringify(a.content ?? "", null, 2);
          if (content.length > MAX_WRITE_CHARS) return {error: "That file is too large to write in one call. Write it in parts with run_python."};
          return await sandbox.writeFile(a.path, content);
        }
        case "read_file": return await sandbox.readFile(a.path);
        case "list_files": return await sandbox.listFiles(a.path);
        default: {
          const set = extraOwner.get(name);
          if (!set) return {error: `Unknown tool ${String(name).slice(0, 40)}.`};
          return await set.run(name, a, {});
        }
      }
    } catch (error) { return {error: String(error && error.message || error).slice(0, 500)}; }
  }
  // update_plan reports itself through the plan event, so it gets no separate activity line.
  return {declarations, run, label: (n, a) => labelFor(n, a, extraLabel), detail: detailFor, silent: ["update_plan"]};
}

module.exports = {DECLARATIONS, buildTools, labelFor, detailFor, CODE_TIMEOUT};
