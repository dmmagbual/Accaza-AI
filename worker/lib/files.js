"use strict";
// Host-side file handling for task workspaces: bringing the user's attached files in, and
// collecting the finished files from outputs/. The container can create symlinks in the shared
// folder, so outputs are read with lstat, symlinks are skipped and every path is checked to stay
// inside the workspace.
const fs = require("fs");
const path = require("path");
const {Tasks} = require("./deps");

const OUT = {maxFiles: 20, maxBytes: 20 * 1024 * 1024, maxDepth: 3};

function inside(root, p) { const rel = path.relative(root, p); return rel && !rel.startsWith("..") && !path.isAbsolute(rel); }
function ensureWorkspace(dir) {
  for (const sub of ["", "inputs", "outputs"]) fs.mkdirSync(path.join(dir, sub), {recursive: true});
}
// Files in outputs/ changed since `sinceMs`. Returns {files: [{name, full, size}], skipped: [reason]}.
function collectOutputs(workspaceDir, sinceMs) {
  const root = fs.realpathSync(path.join(workspaceDir, "outputs")), files = [], skipped = [], used = new Set();
  const walk = (dir, depth, prefix) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name), st = fs.lstatSync(full);
      if (st.isSymbolicLink()) { skipped.push(`${prefix}${entry.name}: link skipped`); continue; }
      if (st.isDirectory()) { if (depth < OUT.maxDepth) walk(full, depth + 1, `${prefix}${entry.name}/`); continue; }
      if (!st.isFile() || st.mtimeMs < sinceMs - 2000) continue;
      if (!inside(root, fs.realpathSync(full))) { skipped.push(`${prefix}${entry.name}: outside outputs`); continue; }
      if (st.size > OUT.maxBytes) { skipped.push(`${prefix}${entry.name}: larger than 20 MB`); continue; }
      if (files.length >= OUT.maxFiles) { skipped.push(`${prefix}${entry.name}: more than ${OUT.maxFiles} files`); continue; }
      let name = Tasks().cleanFileName(`${prefix}${entry.name}`.replace(/\//g, " - ")) || `file-${files.length + 1}`;
      for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${n}-${name}`;
      used.add(name.toLowerCase());
      files.push({name, full, size: st.size, mimeType: Tasks().mimeFor(name) || guessMime(name)});
    }
  };
  walk(root, 1, "");
  return {files, skipped};
}
function guessMime(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return {svg: "image/svg+xml", py: "text/x-python", js: "text/javascript", css: "text/css", log: "text/plain", yaml: "text/yaml", yml: "text/yaml"}[ext] || "application/octet-stream";
}
module.exports = {OUT, ensureWorkspace, collectOutputs, inside};
