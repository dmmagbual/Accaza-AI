"use strict";
// Print a task's status and activity log from the laptop:  node worker/scripts/task-status.js <taskId>
// With no id, lists the 10 newest tasks.
const fs = require("fs");
const deps = require("../lib/deps");
const {loadConfig} = require("../lib/config");

(async () => {
  const cfg = loadConfig(), {initializeApp, cert} = deps.adminApp();
  const app = initializeApp({credential: cert(JSON.parse(fs.readFileSync(cfg.serviceAccountFile, "utf8"))), projectId: cfg.projectId});
  const db = deps.adminFirestore().getFirestore(app), id = process.argv[2];
  if (!id) {
    const snap = await db.collection("tasks").orderBy("createdAt", "desc").limit(10).get();
    snap.docs.forEach(d => { const t = d.data(); console.log(`${d.id}  ${t.status.padEnd(8)} ${new Date(t.createdAt).toISOString()}  ${t.title}`); });
    process.exit(0);
  }
  const ref = db.collection("tasks").doc(id), t = (await ref.get()).data();
  console.log(`status: ${t.status}  steps: ${t.steps}  outputs: ${(t.outputs || []).map(f => `${f.name} (${f.size} B)`).join(", ") || "-"}`);
  if (t.plan && t.plan.length) console.log("plan:\n" + t.plan.map(s => `  ${s.done ? "✓" : "○"} ${s.text}`).join("\n"));
  if (t.question) console.log(`question: ${t.question}`);
  if (t.error) console.log(`error: ${t.error}`);
  const ev = await ref.collection("events").orderBy("seq").get();
  ev.docs.forEach(d => { const e = d.data(); console.log(`${String(e.seq).padStart(3)} ${e.type.padEnd(8)} ${String(e.status).padEnd(8)} ${e.label}${e.ms ? ` (${e.ms} ms)` : ""}${process.argv.includes("-v") && e.detail ? `\n      ${e.detail.replace(/\n/g, "\n      ")}` : ""}`); });
  if (t.summary) console.log(`\nsummary:\n${t.summary}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
