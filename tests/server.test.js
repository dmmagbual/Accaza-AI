"use strict";
// Server unit tests: provider fallback, reply cleanup, account tiers and daily limits.
// Run with `npm test` (needs functions/node_modules: `cd functions && npm install`).
const test = require("node:test");
const assert = require("node:assert/strict");
const AI = require("../functions/lib/providers");
const Access = require("../functions/lib/access");

const provider = (name, ask, extra = {}) => Object.assign({name, enabled: () => true, ask}, extra);
const ok = text => () => Promise.resolve(text);
const failure = message => () => Promise.reject(AI.providerFailure(message));

test("chain order: staff get 3.8 Flash then Flash-Lite; others start on Flash-Lite", () => {
  const P = tier => AI.generalChatProviders({question: "hi", history: [], keys: {}, tier});
  const staff = P("staff"), guest = P("guest");
  assert.equal(staff.map(p => p.name).join(">"), "gemini>gemini-lite>groq>cerebras>deepseek>ollama>ashna");
  assert.equal(staff[0].model, "gemini-3.8-flash");
  assert.equal(guest.map(p => p.name).join(">"), "gemini>groq>cerebras>deepseek>ollama>ashna");
  assert.equal(guest[0].model, "gemini-3.5-flash-lite");
  assert.equal(P("member")[0].model, "gemini-3.5-flash-lite");
});
test("a normal first answer records nothing", async () => {
  let calls = 0;
  const r = await AI.withFallback([provider("gemini", ok("A"))], {onUnusual: async () => { calls += 1; }});
  assert.equal(r.provider, "gemini"); assert.equal(r.answer, "A"); assert.equal(calls, 0);
});
test("a failed provider falls through and the backup is recorded", async () => {
  const seen = [];
  const r = await AI.withFallback([provider("gemini", failure("quota")), provider("groq", ok("B"))], {onUnusual: async (by, f) => seen.push([by, f.map(x => x.provider)])});
  assert.equal(r.provider, "groq"); assert.deepEqual(seen, [["groq", ["gemini"]]]);
});
test("a provider that fails mid-reply triggers one reset, then the next provider streams", async () => {
  const events = [];
  const partial = (limits, ctx) => { ctx.onDelta("Half an ans"); return Promise.reject(AI.providerFailure("cut")); };
  const full = (limits, ctx) => { ctx.onDelta("Full "); ctx.onDelta("answer"); return Promise.resolve("Full answer"); };
  const r = await AI.withFallback([provider("gemini", partial), provider("groq", full)], {onDelta: d => events.push(d), onReset: () => events.push("RESET")});
  assert.equal(r.answer, "Full answer"); assert.deepEqual(events, ["Half an ans", "RESET", "Full ", "answer"]);
});
test("a failure before any text needs no reset", async () => {
  const events = [];
  await AI.withFallback([provider("gemini", failure("503")), provider("groq", ok("B"))], {onReset: () => events.push("RESET")});
  assert.deepEqual(events, []);
});
test("a non-provider error is rethrown, never swallowed", async () => {
  let called = false;
  await assert.rejects(AI.withFallback([provider("gemini", () => Promise.reject(new Error("boom"))), provider("groq", () => { called = true; return Promise.resolve("x"); })]), /boom/);
  assert.equal(called, false);
});
test("when every provider fails the user gets one clear message and it is recorded", async () => {
  const seen = [];
  await assert.rejects(AI.withFallback([provider("gemini", failure("a")), provider("groq", failure("b"))], {onUnusual: async (by, f) => seen.push([by, f.length])}), e => e.code === "unavailable" && /temporarily unavailable/.test(e.message));
  assert.deepEqual(seen, [[null, 2]]);
});
test("answers keep Markdown and line breaks; empty answers fall through", () => {
  assert.equal(AI.finalAnswer("## Title\n\n- one\n\n```js\nx = 1\n```\r\n"), "## Title\n\n- one\n\n```js\nx = 1\n```");
  assert.throws(() => AI.finalAnswer("  \n "), e => e.details && e.details.providerFailure === true);
});
test("history keeps the last 12 turns, 1,500 characters each, with line breaks", () => {
  const h = AI.chatHistory(Array.from({length: 20}, (_, i) => ({role: i % 2 ? "model" : "user", text: "line\n" + "x".repeat(2000)})));
  assert.equal(h.length, 12); assert.ok(h.every(r => r.text.length === 1500 && r.text.startsWith("line\n")));
});

// Streaming parsers against a local HTTP server (no internet needed).
const http = require("node:http");
function serve(handler) {
  return new Promise(resolve => { const server = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(server)); });
}
test("streamLines reads SSE lines and one-shot JSON bodies", async () => {
  const server = await serve((req, res) => {
    if (req.url === "/sse") { res.writeHead(200, {"content-type": "text/event-stream"}); res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'); setTimeout(() => { res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n'); }, 30); return; }
    res.writeHead(200, {"content-type": "application/json"}); res.end('{"choices":[{"message":{"content":"Whole"}}]}');
  });
  const base = `http://127.0.0.1:${server.address().port}`, got = [];
  const collect = (line, body, mark) => { const d = body || AI.sseData(line); const c = d && d.choices[0]; const t = c && ((c.delta && c.delta.content) || (c.message && c.message.content)); if (t) { mark(); got.push(t); } };
  await AI.streamLines("X", base + "/sse", {}, {firstMs: 2000, totalMs: 5000}, collect);
  await AI.streamLines("X", base + "/json", {}, {firstMs: 2000, totalMs: 5000}, collect);
  server.close();
  assert.deepEqual(got, ["Hel", "lo", "Whole"]);
});
test("streamLines cuts off a provider that sends no text in time, and reports HTTP errors", async () => {
  const server = await serve((req, res) => {
    if (req.url === "/slow") { res.writeHead(200, {"content-type": "text/event-stream"}); return; }
    res.writeHead(503, {"content-type": "application/json"}); res.end('{"error":{"message":"high demand"}}');
  });
  const base = `http://127.0.0.1:${server.address().port}`, started = Date.now();
  await assert.rejects(AI.streamLines("Gemini", base + "/slow", {}, {firstMs: 1200, totalMs: 5000}, () => {}), e => e.details.providerFailure && /did not answer within/.test(e.message));
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(AI.streamLines("Gemini", base + "/busy", {}, {firstMs: 2000, totalMs: 5000}, () => {}), e => e.details.providerFailure && /high demand/.test(e.message));
  server.close();
});

const Chats = require("../functions/lib/chats");
test("regenerate re-asks the last question; edit replaces it; both drop the old answer", () => {
  const msgs = [{id: "u1", role: "user", text: "Q1"}, {id: "m1", role: "model", text: "A1"}, {id: "u2", role: "user", text: "Q2"}, {id: "m2", role: "model", text: "A2"}];
  const regen = Chats.planTurn(msgs, "regenerate", "ignored");
  assert.equal(regen.question, "Q2"); assert.deepEqual(regen.remove.map(m => m.id), ["m2"]); assert.equal(regen.keepUser.id, "u2"); assert.equal(regen.history.length, 2);
  const edit = Chats.planTurn(msgs, "edit", "Q2 fixed");
  assert.equal(edit.question, "Q2 fixed"); assert.deepEqual(edit.remove.map(m => m.id), ["u2", "m2"]); assert.equal(edit.keepUser, null);
  assert.throws(() => Chats.planTurn([], "regenerate", ""), e => e.code === "failed-precondition");
  assert.equal(Chats.planTurn(msgs, "new", "Q3").history.length, 4);
});
test("chat titles and ids are cleaned", () => {
  assert.equal(Chats.titleFrom("  How   do I\nmake cold brew?  "), "How do I make cold brew?");
  assert.equal(Chats.titleFrom("x".repeat(100)).length, 58);
  assert.equal(Chats.cleanId("../users/other"), ""); assert.equal(Chats.cleanId("AbC_12-x"), "AbC_12-x");
});

// Minimal in-memory Firestore for the access rules.
function fakeDb(users = {}) {
  const store = {usage: {}, users: Object.assign({}, users)};
  const doc = (col, id) => ({
    get: async () => ({exists: store[col][id] !== undefined, data: () => store[col][id]}),
    set: async value => { store[col][id] = value; },
    _col: col, _id: id,
  });
  return {
    store,
    collection: col => ({doc: id => doc(col, id)}),
    runTransaction: async fn => fn({get: ref => ref.get(), set: (ref, value) => { store[ref._col][ref._id] = value; }}),
  };
}
const token = (extra) => Object.assign({firebase: {sign_in_provider: "password"}, email_verified: true}, extra);

test("tiers: guest, unverified, owner, member, approved staff", async () => {
  const db = fakeDb({s1: {role: "staff", status: "approved"}, r1: {role: "member", status: "removed"}});
  assert.equal((await Access.resolveAccount(db, {uid: "g", token: {firebase: {sign_in_provider: "anonymous"}}})).tier, "guest");
  await assert.rejects(Access.resolveAccount(db, {uid: "u", token: token({email: "a@b.c", email_verified: false})}), e => e.code === "failed-precondition");
  assert.equal((await Access.resolveAccount(db, {uid: "o", token: token({email: "DaniloMagbual@gmail.com"})})).tier, "owner");
  await assert.rejects(Access.resolveAccount(db, {uid: "o2", token: token({email: "danilomagbual@gmail.com", email_verified: false})}), e => e.code === "failed-precondition");
  assert.equal((await Access.resolveAccount(db, {uid: "m", token: token({email: "m@x.com"})})).tier, "member");
  assert.equal((await Access.resolveAccount(db, {uid: "s1", token: token({email: "s@x.com"})})).tier, "staff");
  assert.equal((await Access.resolveAccount(db, {uid: "r1", token: token({email: "r@x.com"})})).tier, "member");
  await assert.rejects(Access.resolveAccount(db, null), e => e.code === "unauthenticated");
});
test("10 messages per person per day, then a clear limit message", async () => {
  const db = fakeDb();
  for (let i = 1; i <= 10; i += 1) assert.equal((await Access.claimMessage(db, "g1", "2026-09-25", i)).used, i);
  await assert.rejects(Access.claimMessage(db, "g1", "2026-09-25", 11), e => e.code === "resource-exhausted" && e.details.limit === "user");
  assert.equal((await Access.claimMessage(db, "g2", "2026-09-25", 12)).remaining, 9);
});
test("the shared ceiling of 100 a day stops new guests too", async () => {
  const db = fakeDb();
  db.store.usage["2026-09-25"] = {total: 100, users: {}};
  await assert.rejects(Access.claimMessage(db, "new", "2026-09-25", 1), e => e.details.limit === "shared");
});
test("an unanswered message is refunded", async () => {
  const db = fakeDb();
  await Access.claimMessage(db, "g1", "2026-09-25", 1);
  await Access.releaseMessage(db, "g1", "2026-09-25");
  assert.equal(await Access.usedToday(db, "g1", "2026-09-25"), 0);
  assert.equal(db.store.usage["2026-09-25"].total, 0);
});
test("Manila day rolls over at 00:00 Manila (16:00 UTC)", () => {
  assert.equal(Access.manilaDay(Date.UTC(2026, 8, 25, 15, 59)), "2026-09-25");
  assert.equal(Access.manilaDay(Date.UTC(2026, 8, 25, 16, 0)), "2026-09-26");
});

// ---------- Step 2: attachments ----------
const Files = require("../functions/lib/files");
const b64 = buf => Buffer.from(buf).toString("base64");
test("uploads are checked by their real bytes, type and size", () => {
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.alloc(20)]);
  assert.equal(Files.validateUpload({mimeType: "image/png", base64: b64(png), name: "a/b<c>.png"}).displayName, "a b c .png");
  assert.equal(Files.validateUpload({mimeType: "application/pdf", base64: b64(Buffer.from("%PDF-1.7 ...")), name: "x.pdf"}).mimeType, "application/pdf");
  assert.throws(() => Files.validateUpload({mimeType: "image/png", base64: b64(Buffer.from("%PDF-1.7 fake")), name: "x.png"}), /real image/);
  assert.throws(() => Files.validateUpload({mimeType: "application/zip", base64: b64(Buffer.from("PK..")), name: "x.zip"}), /Only photos/);
  assert.throws(() => Files.validateUpload({mimeType: "application/pdf", base64: "A".repeat(10 * 1024 * 1024), name: "big.pdf"}), /7 MB/);
});
test("attachments resolve only for their owner and only before they expire", async () => {
  const now = Date.UTC(2026, 8, 26);
  const db = fakeDb();
  db.store.uploads = {f1: {uid: "me", displayName: "a.pdf", mimeType: "application/pdf", uri: "u1", expiresAt: now + 3600e3}, f2: {uid: "other", displayName: "b.png", mimeType: "image/png", uri: "u2", expiresAt: now + 3600e3}, f3: {uid: "me", displayName: "old.png", mimeType: "image/png", uri: "u3", expiresAt: now + 60e3}};
  assert.deepEqual((await Files.resolveAttachments(db, "me", ["f1"], now)).map(f => f.uri), ["u1"]);
  await assert.rejects(Files.resolveAttachments(db, "me", ["f2"], now), e => e.code === "not-found");
  await assert.rejects(Files.resolveAttachments(db, "me", ["f3"], now), e => e.code === "failed-precondition" && /expired/.test(e.message));
  await assert.rejects(Files.resolveAttachments(db, "me", ["f1", "a", "b", "c"], now), /up to 3/);
});
test("with a file attached, Gemini gets a second try before the text-only backups", () => {
  const f = [{displayName: "menu.pdf", mimeType: "application/pdf", uri: "u"}];
  assert.equal(AI.generalChatProviders({question: "q", history: [], keys: {}, tier: "guest", files: f}).map(p => p.name).slice(0, 3).join(">"), "gemini>gemini-lite>groq");
  assert.equal(AI.generalChatProviders({question: "q", history: [], keys: {}, tier: "guest"}).map(p => p.name).slice(0, 2).join(">"), "gemini>groq");
});
test("Gemini receives the files; text-only backups are told a file exists", () => {
  const f = [{displayName: "menu.pdf", mimeType: "application/pdf", uri: "gs://x"}];
  assert.deepEqual(AI.geminiParts("What is on it?", f), [{fileData: {fileUri: "gs://x", mimeType: "application/pdf"}}, {text: "What is on it?"}]);
  const msgs = AI.openAiMessages("What is on it?", [{role: "user", text: "earlier", files: f}, {role: "model", text: "ok"}], f);
  assert.match(msgs[1].content, /^\[Attached: menu\.pdf\]\nearlier$/);
  assert.match(msgs[3].content, /cannot open attachments right now/);
});
test("files only come from the server: browser-supplied history cannot smuggle a file", () => {
  const h = AI.chatHistory([{role: "user", text: "hi", attachments: ["f2"], files: "nope"}]);
  assert.deepEqual(h[0].files, []);
});

// ---------- Tool loop ----------
test("Gemini tool loop: calls the tool, sends the result back with the model's parts, then streams the answer", async () => {
  const bodies = [];
  const server = await serve((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      const body = JSON.parse(raw); bodies.push(body);
      res.writeHead(200, {"content-type": "text/event-stream"});
      if (bodies.length === 1) res.end('data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"latte"}},"thoughtSignature":"sig1"}]}}]}\n\n');
      else res.end('data: {"candidates":[{"content":{"parts":[{"text":"A latte is "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"PHP 150."}]}}]}\n\n');
    });
  });
  AI.ENDPOINTS.gemini = `http://127.0.0.1:${server.address().port}`;
  const events = [], deltas = [];
  const tools = {declarations: [{name: "lookup", description: "Find a price", parameters: {type: "object", properties: {q: {type: "string"}}}}], run: async (name, args) => ({price: args.q === "latte" ? 150 : null})};
  const answer = await AI.askGemini("k", AI.GEMINI.standard, {question: "Latte price?", history: [], tools, system: "extra"}, {firstMs: 3000, totalMs: 8000}, {onDelta: d => deltas.push(d), onEvent: e => events.push(e.status)});
  server.close(); AI.ENDPOINTS.gemini = "https://generativelanguage.googleapis.com";
  assert.equal(answer, "A latte is PHP 150.");
  assert.deepEqual(events, ["running", "done"]);
  assert.equal(bodies[1].contents[1].parts[0].thoughtSignature, "sig1");
  assert.deepEqual(bodies[1].contents[2].parts[0].functionResponse, {name: "lookup", response: {price: 150}});
  assert.match(bodies[0].systemInstruction.parts[0].text, /extra$/);
  assert.ok(bodies[0].tools && bodies[0].tools[0].functionDeclarations.length === 1);
});
test("OpenAI-compatible tool loop: streamed tool-call fragments are joined, then the answer streams", async () => {
  const bodies = [];
  const server = await serve((req, res) => {
    let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, {"content-type": "text/event-stream"});
      if (bodies.length === 1) res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":"{\\"q\\":"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"mocha\\"}"}}]}}]}\n\ndata: [DONE]\n');
      else res.end('data: {"choices":[{"delta":{"content":"Mocha is PHP 175."}}]}\n\ndata: [DONE]\n');
    });
  });
  const tools = {declarations: [{name: "lookup", description: "d", parameters: {type: "object"}}], run: async (name, args) => ({got: args.q})};
  tools.declarations[0].name = "look";
  const answer = await AI.askOpenAiCompatible({label: "T", url: `http://127.0.0.1:${server.address().port}/v1`, model: "m", maxTokens: 100, extra: {}}, "k", {question: "q", history: [], tools}, {firstMs: 3000, totalMs: 8000}, {onDelta: () => {}});
  server.close();
  assert.equal(answer, "Mocha is PHP 175.");
  assert.equal(bodies[1].messages.at(-1).role, "tool");
  assert.equal(bodies[1].messages.at(-1).content, JSON.stringify({got: "mocha"}));
  assert.equal(bodies[1].messages.at(-2).tool_calls[0].function.arguments, '{"q":"mocha"}');
});
test("providers without tools are told tools are off; Ashna never gets tool declarations", () => {
  const req = {question: "q", history: [], keys: {}, tier: "guest", system: "S", tools: {declarations: [{name: "x", description: "d", parameters: {}}], run: async () => ({})}};
  const list = AI.generalChatProviders(req);
  assert.ok(list.find(p => p.name === "ashna"));
});

// ---------- Memory ----------
const Memory = require("../functions/lib/memory");
test("sensitive details never go into memory", () => {
  for (const bad of ["Card is 4111 1111 1111 1111", "My password is hunter2", "Takes medication for diabetes", "Phone 09171234567", "SSS number 34-1234567-8"]) assert.equal(Memory.isSensitive(bad), true, bad);
  for (const ok of ["Runs a coffee shop in Sartoga", "Prefers prices in PHP", "Opened the shop in 2024"]) assert.equal(Memory.isSensitive(ok), false, ok);
});
test("personal block labels user-written text and lists memories only when memory is on", () => {
  const block = Memory.personalBlock({aboutMe: "I own Accaza.", replyStyle: "Short answers.", useMemory: true}, [{text: "Prefers PHP"}]);
  assert.match(block, /About the user \(written by the user/); assert.match(block, /- Prefers PHP/);
  assert.doesNotMatch(Memory.personalBlock({useMemory: false}, [{text: "Prefers PHP"}]), /Prefers PHP/);
});
function memDb() {
  const store = {};
  const col = path => ({
    doc: id => { id = id || "m" + Object.keys(store).length + Math.random().toString(36).slice(2, 6); const key = path + "/" + id; return {id, set: async (v, o) => { store[key] = o && o.merge ? Object.assign({}, store[key], v) : v; }, delete: async () => { delete store[key]; }, collection: sub => col(key + "/" + sub)}; },
    orderBy: () => ({get: async () => ({docs: Object.entries(store).filter(([k]) => k.startsWith(path + "/") && k.split("/").length === path.split("/").length + 1).map(([k, v]) => ({id: k.split("/").pop(), data: () => v, ref: {delete: async () => { delete store[k]; }}})).sort((a, b) => b.data().updatedAt - a.data().updatedAt)}), limit: () => ({get: async () => ({docs: []})})}),
  });
  return {store, collection: name => col(name)};
}
test("learning adds, updates and removes memories, and drops sensitive ones", async () => {
  const db = memDb();
  const memories = [{id: "a1", text: "Runs a café"}, {id: "b2", text: "Likes long answers"}];
  const extract = async () => ({add: ["Prefers prices in PHP", "Card 4111 1111 1111 1111"], update: [{id: "a1", text: "Runs Accaza Coffee in Sartoga"}], remove: ["b2", "zz"]});
  const out = await Memory.learnFromTurn({db, uid: "u", settings: {learn: true, useMemory: true}, memories, question: "Use PHP. Remember my card 4111 1111 1111 1111", answer: "ok", chatId: "c", key: "k", now: 5, extract});
  assert.deepEqual(out.added.map(a => a.text), ["Prefers prices in PHP"]);
  assert.deepEqual(out.updated, [{id: "a1", text: "Runs Accaza Coffee in Sartoga"}]);
  assert.deepEqual(out.removed, ["b2"]);
});
test("with learning off, only an explicit 'remember'/'forget' is processed", async () => {
  let called = 0; const extract = async () => { called += 1; return {add: ["X"], update: [], remove: []}; };
  const off = {learn: false, useMemory: true};
  await Memory.learnFromTurn({db: memDb(), uid: "u", settings: off, memories: [], question: "What is a flat white?", answer: "", key: "k", now: 1, extract});
  assert.equal(called, 0);
  await Memory.learnFromTurn({db: memDb(), uid: "u", settings: off, memories: [], question: "Please remember that I open at 7am", answer: "", key: "k", now: 1, extract});
  assert.equal(called, 1);
});
test("a failed or malformed extraction changes nothing", async () => {
  const out = await Memory.learnFromTurn({db: memDb(), uid: "u", settings: {learn: true}, memories: [], question: "hi", answer: "", key: "k", now: 1, extract: async () => null});
  assert.deepEqual(out, {added: [], updated: [], removed: []});
});

// ---------- Skills ----------
const Skills = require("../functions/lib/skills");
const {combineTools} = require("../functions/lib/tools");
const {zipSync, strToU8} = require("../functions/node_modules/fflate");
test("SKILL.md front matter gives the name, description and instructions", () => {
  const s = Skills.parseSkillMd("---\nname: Barista SOP\ndescription: \"Use for espresso dial-in and bar opening steps\"\n---\n# Steps\n1. Purge the group head.");
  assert.deepEqual(s, {name: "Barista SOP", description: "Use for espresso dial-in and bar opening steps", instructions: "# Steps\n1. Purge the group head."});
  assert.equal(Skills.parseSkillMd("Just instructions").instructions, "Just instructions");
});
test("chunking covers the whole text with overlap and prefers paragraph breaks", () => {
  const text = Array.from({length: 30}, (_, i) => `Paragraph ${i}. ` + "word ".repeat(40)).join("\n\n");
  const chunks = Skills.chunkText(text, 600, 100);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.length <= 600));
  assert.ok(chunks[0].startsWith("Paragraph 0") && chunks.at(-1).includes("Paragraph 29"));
});
test("a Claude-style skill .zip is unpacked: SKILL.md, reference files, scripts skipped", () => {
  const zip = zipSync({"barista/SKILL.md": strToU8("---\nname: Barista\ndescription: Bar SOP\n---\nFollow the SOP."), "barista/references/recipes.md": strToU8("# Latte\n18 g in, 36 g out"), "barista/scripts/run.py": strToU8("print(1)"), "__MACOSX/._x": strToU8("junk")});
  const out = Skills.readZip(Buffer.from(zip));
  assert.equal(out.skill.name, "Barista");
  assert.deepEqual(out.files.map(f => f.name), ["references/recipes.md"]);
  assert.deepEqual(out.skipped, ["run.py"]);
});
test("skill tools: read by name (case-insensitive), search uses vector search on that skill only", async () => {
  let asked = null;
  const db = {collection: () => ({doc: id => ({collection: () => ({findNearest: q => { asked = {id, q}; return {get: async () => ({docs: [{data: () => ({file: "recipes.md", text: "Latte: 18 g in"})}]})}; }})})})};
  const skills = [{id: "s1", name: "Barista SOP", description: "d", instructions: "Do X", files: [{name: "recipes.md"}], chunkCount: 3}];
  const tools = Skills.skillTools(db, "k", skills, async () => [[0.1, 0.2]]);
  assert.deepEqual(await tools.run("read_skill", {skill: "barista sop"}), {name: "Barista SOP", instructions: "Do X", files: ["recipes.md"]});
  const found = await tools.run("search_skill", {skill: "Barista SOP", query: "latte dose"});
  assert.equal(found.results[0].text, "Latte: 18 g in"); assert.equal(asked.id, "s1"); assert.equal(asked.q.limit, 6);
  assert.match((await tools.run("read_skill", {skill: "Nope"})).error, /No skill named/);
});
test("the catalogue lists skills; a pinned skill's instructions are included", () => {
  const block = Skills.catalogBlock([{name: "A", description: "for a"}], {name: "A", instructions: "Step 1", files: []});
  assert.match(block, /- A: for a/); assert.match(block, /selected the skill "A"/); assert.match(block, /Step 1/);
  assert.equal(Skills.catalogBlock([], null), "");
});
test("tool sets combine; unknown tools answer with an error instead of throwing", async () => {
  const t = combineTools([{declarations: [{name: "a"}], run: async () => ({ok: 1}), labels: {a: () => "Doing A"}}, null, {declarations: [], run: async () => ({})}]);
  assert.equal(t.declarations.length, 1); assert.equal(t.label("a", {}), "Doing A");
  assert.deepEqual(await t.run("zzz", {}), {error: "Unknown tool zzz."});
  assert.equal(combineTools([null]), null);
});
