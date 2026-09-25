"use strict";
// JSON-lines log to the console and to a file that rotates at 5 MB (one old copy kept).
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 5 * 1024 * 1024;
let file = "";
function setLogFile(dir) {
  fs.mkdirSync(dir, {recursive: true});
  file = path.join(dir, "worker.log");
}
function write(level, event, fields) {
  const line = JSON.stringify(Object.assign({at: new Date().toISOString(), level, event}, fields || {}));
  (level === "error" ? console.error : console.log)(line);
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + ".1");
    fs.appendFileSync(file, line + "\n");
  } catch (_error) { /* logging must never stop the worker */ }
}
module.exports = {
  setLogFile,
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
