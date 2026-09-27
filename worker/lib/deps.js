"use strict";
// The worker shares code and packages with the Cloud Functions (functions/): the same Firestore
// client, web tools, skills and task helpers. Everything is loaded from functions/node_modules so
// there is exactly one copy of firebase-admin (sentinels like FieldValue must come from the same
// copy as the Firestore client). Run `npm ci` in functions/ before starting the worker.
const path = require("path");
const {createRequire} = require("module");

const FUNCTIONS_DIR = path.join(__dirname, "..", "..", "functions");
const req = createRequire(path.join(FUNCTIONS_DIR, "package.json"));

module.exports = {
  FUNCTIONS_DIR,
  adminApp: () => req("firebase-admin/app"),
  adminFirestore: () => req("firebase-admin/firestore"),
  adminStorage: () => req("firebase-admin/storage"),
  Tasks: () => req("./lib/tasks"),
  AI: () => req("./lib/providers"),
  Web: () => req("./lib/websearch"),
  Skills: () => req("./lib/skills"),
  Access: () => req("./lib/access"),
  Memory: () => req("./lib/memory"),
};
