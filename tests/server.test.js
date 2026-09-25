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
  const staff = AI.generalChatProviders("hi", [], {}, "staff"), guest = AI.generalChatProviders("hi", [], {}, "guest");
  assert.equal(staff.map(p => p.name).join(">"), "gemini>gemini-lite>groq>cerebras>deepseek>ollama>ashna");
  assert.equal(staff[0].model, "gemini-3.8-flash");
  assert.equal(guest.map(p => p.name).join(">"), "gemini>groq>cerebras>deepseek>ollama>ashna");
  assert.equal(guest[0].model, "gemini-3.5-flash-lite");
  assert.equal(AI.generalChatProviders("hi", [], {}, "member")[0].model, "gemini-3.5-flash-lite");
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
  assert.equal(AI.generalChatProviders("q", [], {}, "guest", f).map(p => p.name).slice(0, 3).join(">"), "gemini>gemini-lite>groq");
  assert.equal(AI.generalChatProviders("q", [], {}, "guest").map(p => p.name).slice(0, 2).join(">"), "gemini>groq");
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
