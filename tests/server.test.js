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

test("chain order is Gemini > Groq > Cerebras > DeepSeek > Qwen > Ashna", () => {
  const names = AI.generalChatProviders("hi", [], {}).map(p => p.name).join(">");
  assert.equal(names, "gemini>groq>cerebras>deepseek>ollama>ashna");
});
test("a normal first answer records nothing", async () => {
  let calls = 0;
  const r = await AI.withFallback([provider("gemini", ok("A"))], async () => { calls += 1; });
  assert.equal(r.provider, "gemini"); assert.equal(r.answer, "A"); assert.equal(calls, 0);
});
test("a failed provider falls through and the backup is recorded", async () => {
  const seen = [];
  const r = await AI.withFallback([provider("gemini", failure("quota")), provider("groq", ok("B"))], async (by, f) => seen.push([by, f.map(x => x.provider)]));
  assert.equal(r.provider, "groq"); assert.deepEqual(seen, [["groq", ["gemini"]]]);
});
test("a hung provider is cut off at its own limit", async () => {
  const started = Date.now();
  const hang = t => AI.fetchJson("Gemini", "https://10.255.255.1/", {}, t);
  const r = await AI.withFallback([provider("gemini", hang, {maxMs: 8200}), provider("groq", ok("C"))], null);
  assert.equal(r.provider, "groq"); assert.ok(Date.now() - started < 12000);
});
test("a non-provider error is rethrown, never swallowed", async () => {
  let called = false;
  await assert.rejects(AI.withFallback([provider("gemini", () => Promise.reject(new Error("boom"))), provider("groq", () => { called = true; return Promise.resolve("x"); })], null), /boom/);
  assert.equal(called, false);
});
test("when every provider fails the user gets one clear message and it is recorded", async () => {
  const seen = [];
  await assert.rejects(AI.withFallback([provider("gemini", failure("a")), provider("groq", failure("b"))], async (by, f) => seen.push([by, f.length])), e => e.code === "unavailable" && /temporarily unavailable/.test(e.message));
  assert.deepEqual(seen, [[null, 2]]);
});
test("replies are cleaned into plain paragraphs and lists", () => {
  const out = AI.proseAnswer("## Title\n**Bold** text\n- one\n* two\n1) first\n2*3*4 stays");
  assert.equal(out, "Title\nBold text\n\n• one\n• two\n1. first\n\n2*3*4 stays");
  assert.throws(() => AI.proseAnswer("   "), e => e.details && e.details.providerFailure === true);
});
test("history keeps the last 8 turns and trims each to 800 characters", () => {
  const h = AI.chatHistory(Array.from({length: 12}, (_, i) => ({role: i % 2 ? "model" : "user", text: "x".repeat(900)})));
  assert.equal(h.length, 8); assert.ok(h.every(r => r.text.length === 800));
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
