"use strict";
// Queue a task from the laptop's command line (handy for testing without the web app):
//   node worker/scripts/enqueue.js "Make a one-page Word summary of the attached CSV" C:\path\data.csv
// Uses the worker's own key and the same createTask code as the web app, so the task shows up in
// the app (in a new chat) like any other.
const fs = require("fs");
const path = require("path");
const deps = require("../lib/deps");
const {loadConfig} = require("../lib/config");

(async () => {
  const [prompt, ...files] = process.argv.slice(2);
  if (!prompt) { console.error("Usage: node worker/scripts/enqueue.js \"what to do\" [file ...]"); process.exit(2); }
  const cfg = loadConfig();
  const {initializeApp, cert} = deps.adminApp();
  const Tasks = deps.Tasks();
  const app = initializeApp({credential: cert(JSON.parse(fs.readFileSync(cfg.serviceAccountFile, "utf8"))), projectId: cfg.projectId});
  const db = deps.adminFirestore().getFirestore(app), bucket = deps.adminStorage().getStorage(app).bucket(Tasks.BUCKET);
  const owner = (await db.collection("users").where("email", "==", cfg.ownerEmail).limit(5).get()).docs.find(d => d.data().role === "owner");
  if (!owner) throw new Error("Owner account not found.");
  const inputs = files.map(f => ({name: path.basename(f), data: fs.readFileSync(f).toString("base64")}));
  const Chats = require(path.join(deps.FUNCTIONS_DIR, "lib", "chats"));
  const out = await Tasks.createTask({db, bucket, account: {uid: owner.id, tier: "owner"}, data: {prompt, inputs}, now: Date.now(), Chats});
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
