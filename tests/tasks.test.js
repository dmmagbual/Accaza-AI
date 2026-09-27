"use strict";
// Laptop tasks: server helpers (functions/lib/tasks.js) and the worker's pure logic (worker/lib).
// Docker, Firestore and the AI APIs are replaced with fakes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Tasks = require("../functions/lib/tasks");
const Chats = require("../functions/lib/chats");
const {sandboxPath, Sandbox, clip} = require("../worker/lib/sandbox");
const {initialState, applyReply, runAgent} = require("../worker/lib/agent");
const Models = require("../worker/lib/models");
const {buildTools} = require("../worker/lib/toolset");
const {collectOutputs, ensureWorkspace} = require("../worker/lib/files");
const {loadConfig} = require("../worker/lib/config");

const b64 = s => Buffer.from(s).toString("base64");

// ---------- Server helpers ----------
test("task files: safe names, allowed types, unique names, size caps", () => {
  assert.equal(Tasks.cleanFileName("../../etc/passwd.csv"), "passwd.csv");
  assert.equal(Tasks.cleanFileName("C:\\Users\\x\\Q3 Sales (final).XLSX"), "Q3 Sales (final).xlsx");
  assert.equal(Tasks.cleanFileName("...hidden.txt"), "hidden.txt");
  assert.equal(Tasks.cleanFileName("..."), "");
  const out = Tasks.validateInputs([{name: "a.csv", data: b64("x,y")}, {name: "a.csv", data: b64("1,2")}]);
  assert.deepEqual(out.map(f => f.name), ["a.csv", "a (2).csv"]);
  assert.equal(out[0].mimeType, "text/csv");
  assert.throws(() => Tasks.validateInputs([{name: "run.exe", data: b64("MZ")}]), /not a supported file type/);
  assert.throws(() => Tasks.validateInputs([{name: "a.txt", data: "%%%"}]), /could not be read/);
  assert.throws(() => Tasks.validateInputs([{name: "a.txt", data: ""}]), /empty/);
  assert.throws(() => Tasks.validateInputs(Array.from({length: 6}, (_, i) => ({name: `f${i}.txt`, data: b64("x")}))), /up to 5/);
  const big = Buffer.alloc(Tasks.INPUT.maxBytes + 1).toString("base64");
  assert.throws(() => Tasks.validateInputs([{name: "big.pdf", data: big}]), /larger than 10 MB/);
});
test("the browser never sees storage paths, and a question only while waiting", () => {
  const t = {status: "running", question: "old?", inputs: [{name: "a.csv", size: 3, mimeType: "text/csv", path: "tasks/x/inputs/a.csv"}], outputs: [{name: "r.docx", size: 9, mimeType: "x", path: "tasks/x/outputs/r.docx"}]};
  const p = Tasks.publicTask("x", t);
  assert.equal(p.question, "");
  assert.ok(!JSON.stringify(p).includes("tasks/x/"));
  assert.equal(Tasks.publicTask("x", Object.assign({}, t, {status: "waiting"})).question, "old?");
});
test("laptop counts as offline 90 seconds after its last heartbeat", () => {
  assert.equal(Tasks.workerState({lastSeen: 1000}, 1000 + 89000).online, true);
  assert.equal(Tasks.workerState({lastSeen: 1000}, 1000 + 91000).online, false);
  assert.equal(Tasks.workerState(null, 5).online, false);
});
test("event ids sort in order", () => {
  assert.ok(Tasks.eventId(9) < Tasks.eventId(10));
  assert.equal(Tasks.eventId(42), "000042");
});
test("a task turn cannot be regenerated or edited as a chat answer", () => {
  const msgs = [{role: "user", text: "make a report", task: {id: "t1"}}, {role: "model", text: "done", task: {id: "t1"}}];
  assert.throws(() => Chats.planTurn(msgs, "regenerate", ""), /can't be regenerated/);
  assert.throws(() => Chats.planTurn(msgs, "edit", "x"), /can't be regenerated/);
  assert.equal(Chats.planTurn(msgs, "new", "next question").question, "next question");
});

// ---------- Sandbox ----------
test("sandbox paths stay inside the workspace or a mounted folder", () => {
  const roots = ["/workspace", "/mnt/Reports"];
  assert.equal(sandboxPath("outputs/a.xlsx", roots), "/workspace/outputs/a.xlsx");
  assert.equal(sandboxPath("/mnt/Reports/q3.csv", roots), "/mnt/Reports/q3.csv");
  assert.throws(() => sandboxPath("../../etc/passwd", roots), /inside/);
  assert.throws(() => sandboxPath("/workspace/../root", roots), /inside/);
  assert.throws(() => sandboxPath("/mnt/ReportsX/a", roots), /inside/);
  assert.throws(() => sandboxPath("", roots), /required/);
});
test("the container runs without network, capabilities, root or secrets", () => {
  const args = Sandbox.runArgs({name: "accaza-task-1", workspaceDir: "C:\\data\\ws", folders: [{name: "R", hostPath: "C:\\R", write: false}, {name: "W", hostPath: "C:\\W", write: true}], limits: {memory: "2g", cpus: 2, pids: 256}}).join(" ");
  for (const flag of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 1000:1000", "--read-only", "--pids-limit 256", "--memory 2g"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("target=/mnt/R,readonly"));
  assert.ok(args.includes("target=/mnt/W ") && !args.includes("target=/mnt/W,readonly"));
  assert.ok(!/KEY|SECRET|TOKEN/i.test(args));
  assert.throws(() => Sandbox.runArgs({name: "n", workspaceDir: "C:\\a,b", folders: [], limits: {memory: "1g", cpus: 1, pids: 10}}), /commas/);
});
test("long output keeps its start and end", () => {
  const out = clip("a".repeat(100) + "b".repeat(100), 50);
  assert.ok(out.startsWith("a".repeat(20)) && out.endsWith("b".repeat(30)) && out.includes("cut"));
});

// ---------- Agent loop ----------
function fakeChain(steps) {
  const seen = [];
  return {seen, step: async args => { seen.push(args); const next = steps.shift(); if (!next) throw new Error("no more steps"); if (next instanceof Error) throw next; return next; }};
}
function fakeTools(results = {}) {
  const ran = [];
  return {ran, declarations: [{name: "run_python"}], label: n => n, detail: () => "", run: async (name, args) => { ran.push([name, args]); return results[name] || {ok: true}; }};
}
function deps(chain, tools, extra = {}) {
  const events = [], saves = [];
  return Object.assign({events, saves, chain, tools, system: "sys", save: async st => { saves.push(st); }, event: async e => { events.push(e); return events.length; }, shouldStop: async () => false}, extra);
}
test("agent: plan, run code, then finish with a summary", async () => {
  const chain = fakeChain([{text: "Starting", calls: [{id: "1", name: "update_plan", args: {steps: [{text: "a", done: false}]}}, {id: "2", name: "run_python", args: {code: "print(1)"}}]}, {text: "All done. Files: report.docx", calls: []}]);
  const tools = fakeTools({run_python: {exit_code: 0, stdout: "1"}});
  const d = deps(chain, tools);
  const out = await runAgent(initialState("Make a report", ["data.csv"]), d);
  assert.equal(out.status, "done"); assert.equal(out.summary, "All done. Files: report.docx");
  assert.equal(tools.ran.length, 2);
  assert.match(chain.seen[0].transcript[0].text, /inputs: data\.csv/);
  const second = chain.seen[1].transcript;
  assert.equal(second[second.length - 1].role, "tool"); assert.equal(second[second.length - 1].results[1].result.stdout, "1");
  assert.ok(d.events.some(e => e.type === "tool" && e.status === "done"));
  assert.equal(out.state.steps, 2);
});
test("agent: a failing script is shown as failed, and the model sees the error", async () => {
  const chain = fakeChain([{text: "", calls: [{id: "1", name: "run_python", args: {code: "boom"}}]}, {text: "Fixed it", calls: []}]);
  const d = deps(chain, fakeTools({run_python: {exit_code: 1, stderr: "NameError"}}));
  await runAgent(initialState("x", []), d);
  assert.ok(d.events.some(e => e.type === "tool" && e.status === "failed"));
  assert.match(JSON.stringify(chain.seen[1].transcript), /NameError/);
});
test("agent: ask_user pauses the task; the answer resumes it in the right order", async () => {
  const chain = fakeChain([{text: "", calls: [{id: "a", name: "run_python", args: {}}, {id: "b", name: "ask_user", args: {question: "Which month?"}}, {id: "c", name: "run_python", args: {}}]}]);
  const d = deps(chain, fakeTools());
  const paused = await runAgent(initialState("x", []), d);
  assert.equal(paused.status, "waiting"); assert.equal(paused.question, "Which month?");
  assert.equal(d.saves[d.saves.length - 1].pending.ask.id, "b");
  const resumed = applyReply(paused.state, "September");
  const last = resumed.transcript[resumed.transcript.length - 1];
  assert.deepEqual(last.results.map(r => r.id), ["a", "b", "c"]);
  assert.deepEqual(last.results[1].result, {answer: "September"});
  assert.equal(resumed.pending, undefined);
  const chain2 = fakeChain([{text: "Used September", calls: []}]);
  const done = await runAgent(resumed, deps(chain2, fakeTools()));
  assert.equal(done.status, "done");
});
test("agent: stop is checked before each step and each tool", async () => {
  let stop = false;
  const chain = fakeChain([{text: "", calls: [{id: "1", name: "run_python", args: {}}, {id: "2", name: "run_python", args: {}}]}]);
  const tools = fakeTools();
  const orig = tools.run; tools.run = async (...a) => { stop = true; return orig(...a); };
  const out = await runAgent(initialState("x", []), deps(chain, tools, {shouldStop: async () => stop}));
  assert.equal(out.status, "stopped"); assert.equal(tools.ran.length, 1);
});
test("agent: the step limit ends with a tool-free summary", async () => {
  const loop = Array.from({length: 3}, (_, i) => ({text: "", calls: [{id: String(i), name: "run_python", args: {}}]}));
  const chain = fakeChain([...loop, {text: "Summary so far", calls: []}]);
  const out = await runAgent(initialState("x", []), deps(chain, fakeTools(), {limits: {maxSteps: 3}}));
  assert.equal(out.status, "done"); assert.match(out.summary, /Summary so far/); assert.match(out.summary, /3-step limit/);
  assert.deepEqual(chain.seen[3].tools, []);
});
test("agent: when every model fails the task fails with the reason", async () => {
  const out = await runAgent(initialState("x", []), deps(fakeChain([new Error("No AI model could continue the task: quota")]), fakeTools()));
  assert.equal(out.status, "failed"); assert.match(out.error, /quota/);
});

// ---------- Models ----------
test("Gemini replay keeps its own parts and marks other providers' calls", () => {
  const raw = [{functionCall: {name: "run_python", args: {}}, thoughtSignature: "sig"}];
  const c = Models.geminiContents([{role: "user", text: "hi"}, {role: "assistant", text: "", calls: [{id: "1", name: "run_python", args: {}}], gemini: raw}, {role: "tool", results: [{id: "1", name: "run_python", result: [1, 2]}]}, {role: "assistant", text: "x", calls: [{id: "2", name: "list_files", args: {}}]}]);
  assert.equal(c[1].parts, raw);
  assert.deepEqual(c[2].parts[0].functionResponse, {name: "run_python", response: {result: [1, 2]}});
  assert.equal(c[3].parts[1].thoughtSignature, Models.SKIP_SIGNATURE);
});
test("OpenAI-style replay links tool results to their calls", () => {
  const m = Models.openAiMessages("sys", [{role: "user", text: "hi"}, {role: "assistant", text: "", calls: [{id: "c1", name: "t", args: {a: 1}}]}, {role: "tool", results: [{id: "c1", name: "t", result: {ok: true}}]}]);
  assert.equal(m[2].tool_calls[0].function.arguments, "{\"a\":1}");
  assert.deepEqual(m[3], {role: "tool", tool_call_id: "c1", content: "{\"ok\":true}"});
});
test("long transcripts shorten old tool results but keep recent ones", () => {
  const big = "x".repeat(50000);
  const t = [{role: "user", text: "go"}];
  for (let i = 0; i < 10; i += 1) t.push({role: "assistant", text: "", calls: [{id: String(i), name: "r", args: {}}]}, {role: "tool", results: [{id: String(i), name: "r", result: {stdout: big}}]});
  const c = Models.compact(t, 240000, 3);
  assert.ok(JSON.stringify(c).length <= 240000);
  assert.equal(c[c.length - 1].results[0].result.stdout, big);
  assert.equal(c[2].results[0].result.shortened, true);
  assert.equal(t[2].results[0].result.stdout, big, "the saved transcript is not changed");
});
test("model chain falls back, then rests models that hit their quota or a rejected key", async () => {
  let now = 0, geminiCalls = 0, status = 429;
  const fetchImpl = async (url) => {
    if (url.includes("generativelanguage")) { geminiCalls += 1; return {ok: false, status, json: async () => ({error: {message: "quota"}})}; }
    return {ok: true, status: 200, json: async () => ({choices: [{message: {content: "hello"}}]})};
  };
  const ask = chain => chain.step({system: "s", transcript: [{role: "user", text: "hi"}], tools: []});
  const chain = new Models.ModelChain({gemini: "g", deepseek: "d", cerebras: ""}, {fetchImpl, now: () => now});
  const r = await ask(chain);
  assert.equal(r.provider, "deepseek"); assert.equal(r.text, "hello"); assert.equal(geminiCalls, 2, "quota is per model: lite is tried too");
  assert.deepEqual(r.failures.map(f => f.provider), ["gemini", "gemini-lite"]);
  await ask(chain); assert.equal(geminiCalls, 2, "both rest for 5 minutes");
  now = 6 * 60 * 1000; await ask(chain); assert.equal(geminiCalls, 4);
  status = 403; geminiCalls = 0;
  const keyed = new Models.ModelChain({gemini: "g", deepseek: "d", cerebras: ""}, {fetchImpl, now: () => now});
  await ask(keyed); assert.equal(geminiCalls, 1, "a rejected key rests every model that uses it");
});
test("model chain: a stop aborts the call in progress", async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const chain = new Models.ModelChain({gemini: "g", deepseek: "", cerebras: ""}, {fetchImpl});
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(chain.step({system: "s", transcript: [{role: "user", text: "hi"}], tools: [], signal: controller.signal}), e => e.stopped === true);
});

// ---------- Tools ----------
test("tools: plan is cleaned, big writes are refused, unknown tools report an error", async () => {
  let plan = null;
  const sandbox = {writeFile: async () => ({ok: true})};
  const t = buildTools({sandbox, webTools: null, skillTools: null, onPlan: async s => { plan = s; }});
  await t.run("update_plan", {steps: [{text: "  Read   data ", done: 1}, {text: ""}]});
  assert.deepEqual(plan, [{text: "Read data", done: true}]);
  assert.match((await t.run("write_file", {path: "a.txt", content: "x".repeat(400001)})).error, /too large/);
  assert.match((await t.run("nope", {})).error, /Unknown tool/);
  const sb = {runPython: async () => { throw new Error("docker gone"); }};
  assert.match((await buildTools({sandbox: sb, onPlan: async () => {}}).run("run_python", {code: "1"})).error, /docker gone/);
});

// ---------- Files and config ----------
test("outputs: only this task's files, no links, safe names", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ws-")); ensureWorkspace(d);
  const old = path.join(d, "outputs", "old.txt"); fs.writeFileSync(old, "x"); fs.utimesSync(old, new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(d, "outputs", "Report Q3.docx"), "d");
  fs.mkdirSync(path.join(d, "outputs", "charts")); fs.writeFileSync(path.join(d, "outputs", "charts", "sales.png"), "p");
  try { fs.symlinkSync(os.homedir(), path.join(d, "outputs", "home")); } catch (_e) { /* symlinks may be unavailable */ }
  const r = collectOutputs(d, Date.now() - 60000);
  assert.deepEqual(r.files.map(f => f.name).sort(), ["Report Q3.docx", "charts - sales.png"]);
});
test("config: folders must be named, exist and not be a whole drive or home", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), share = fs.mkdtempSync(path.join(os.tmpdir(), "share-"));
  const write = obj => { const f = path.join(dir, "config.json"); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const cfg = loadConfig(write({ownerEmail: "O@x.com", folders: [{name: "Share", path: share}]}));
  assert.equal(cfg.ownerEmail, "o@x.com"); assert.equal(cfg.folders[0].write, false); assert.equal(cfg.limits.maxSteps, 40);
  assert.throws(() => loadConfig(write({ownerEmail: "o@x.com", folders: [{name: "bad name", path: share}]})), /letters/);
  assert.throws(() => loadConfig(write({ownerEmail: "o@x.com", folders: [{name: "H", path: os.homedir()}]})), /specific folder/);
  assert.throws(() => loadConfig(write({ownerEmail: "o@x.com", folders: [{name: "X", path: path.join(share, "missing")}]})), /does not exist/);
  assert.throws(() => loadConfig(write({})), /ownerEmail/);
  assert.equal(loadConfig(write({ownerEmail: "o@x.com", limits: {maxSteps: 999}})).limits.maxSteps, 100);
});
test("agent: plan updates get no separate activity line", async () => {
  const chain = fakeChain([{text: "", calls: [{id: "1", name: "update_plan", args: {steps: []}}]}, {text: "ok", calls: []}]);
  const tools = Object.assign(fakeTools(), {silent: ["update_plan"]});
  const d = deps(chain, tools);
  await runAgent(initialState("x", []), d);
  assert.equal(tools.ran.length, 1); assert.equal(d.events.filter(e => e.type === "tool").length, 0);
});
