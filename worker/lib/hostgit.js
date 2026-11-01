"use strict";
// Git work the worker runs on the laptop itself, outside the Docker sandbox: the sandbox has no
// network, so it could never reach github.com. Only folders shared with "write": true are used,
// the commands are fixed (never AI-supplied strings), pushes are never forced, and credentials are
// whatever git already uses on this laptop (never a key from Secret Manager).
const {execFile} = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_OUT = 6000;
const TIMEOUT_MS = 180000;
const WIN_GIT = ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"];
const BRANCH_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

function clip(text, max = MAX_OUT) {
  const t = String(text || "");
  return t.length <= max ? t : `${t.slice(0, max)}\n…[${t.length - max} characters cut]…`;
}
function exec(cmd, args, cwd) {
  return new Promise(resolve => {
    execFile(cmd, args, {cwd, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env}, (error, stdout, stderr) => {
      const code = !error ? 0 : (Number.isInteger(error.code) ? error.code : -1);
      resolve({code, stdout: String(stdout || ""), stderr: String(stderr || (error && error.message) || "")});
    });
  });
}
// git may not be on the PATH of the scheduled task, so fall back to the usual install locations.
async function git(args, cwd) {
  // Prefer the real Git for Windows install on Windows: another app's bundled git may be first on
  // PATH and comes with its own credential setup.
  const bins = process.platform === "win32" ? [...WIN_GIT, "git"] : ["git"];
  let last = null;
  for (const bin of bins) {
    const r = await exec(bin, ["--no-pager", ...args], cwd);
    if (r.code !== -1) return r;
    last = r;
  }
  return {code: -1, stdout: "", stderr: `git was not found on this laptop. ${clip((last && last.stderr) || "", 200)}`};
}

function writable(folders) { return (folders || []).filter(f => f && f.write && f.hostPath); }
function resolveFolder(folders, name) {
  const list = writable(folders);
  if (!list.length) throw new Error("No writable folder is shared. Add a folder with \"write\": true to %USERPROFILE%\\.accaza-ai\\config.json on the laptop.");
  const key = String(name || "").trim().toLowerCase();
  if (!key) {
    if (list.length === 1) return list[0];
    throw new Error(`Say which folder: ${list.map(f => f.name).join(", ")}.`);
  }
  const found = list.find(f => f.name.toLowerCase() === key || f.hostPath.toLowerCase() === key);
  if (!found) throw new Error(`"${String(name).slice(0, 60)}" is not a writable shared folder. Writable: ${list.map(f => f.name).join(", ")}.`);
  return found;
}
async function repoRoot(folder) {
  const top = await git(["rev-parse", "--show-toplevel"], folder.hostPath);
  if (top.code !== 0) throw new Error(`${folder.name} is not a git repository (${folder.hostPath}). Point the tool at the folder that contains .git, or clone the repo there first.`);
  return top.stdout.trim() || folder.hostPath;
}
// A shared folder often holds several repositories, so "folder" may name a subfolder:
// "projects/Accaza AI". The path may never climb out of the shared folder.
function resolveTarget(folders, name) {
  const raw = String(name || "").trim();
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const folder = resolveFolder(folders, parts[0]);
  const sub = parts.slice(1).join("/");
  const base = path.resolve(folder.hostPath);
  const dir = sub ? path.resolve(base, sub) : base;
  if (dir !== base) {
    if (!dir.startsWith(base + path.sep)) throw new Error(`"${sub}" is outside the shared folder ${folder.name}.`);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`"${sub}" is not a folder inside ${folder.name}.`);
  }
  return {folder, dir};
}
function cleanPaths(paths) {
  return (Array.isArray(paths) ? paths : []).map(p => String(p || "").trim()).filter(Boolean).slice(0, 20).map(p => {
    if (/^([A-Za-z]:|[\\/])/.test(p)) throw new Error(`Path "${p.slice(0, 60)}" must be relative to the repository.`);
    if (p.split(/[\\/]/).includes("..")) throw new Error(`Path "${p.slice(0, 60)}" may not leave the repository.`);
    if (/[\u0000-\u001f]/.test(p)) throw new Error("That path is not allowed.");
    return p;
  });
}

async function status(folders, args = {}) {
  const {folder, dir} = resolveTarget(folders, args.folder);
  const root = await repoRoot({name: folder.name, hostPath: dir});
  const [branchR, remoteR, stateR, upstreamR] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    git(["remote"], root),
    git(["status", "--porcelain=v1", "--branch"], root),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root),
  ]);
  const branch = branchR.stdout.trim() || "(detached)";
  const remotes = [...new Set(remoteR.stdout.split("\n").map(s => s.trim()).filter(Boolean))];
  const lines = stateR.stdout.split("\n").filter(Boolean);
  const head = (lines.find(l => l.startsWith("##")) || "").replace(/^##\s*/, "");
  const changes = lines.filter(l => !l.startsWith("##")).slice(0, 40);
  const text = [
    `folder ${folder.name} (${root})`,
    `branch ${branch}${upstreamR.code === 0 ? ` -> ${upstreamR.stdout.trim()}` : " (no upstream)"}`,
    `remotes ${remotes.length ? remotes.join(", ") : "none"}`,
    head ? `state ${head}` : "",
    changes.length ? `uncommitted:\n${changes.join("\n")}` : "working tree clean",
  ].filter(Boolean).join("\n");
  return {ok: true, text: clip(text), folder: folder.name, root, branch, remotes, clean: !changes.length, changes: changes.length};
}

async function publish(folders, args = {}) {
  const {folder, dir} = resolveTarget(folders, args.folder);
  const root = await repoRoot({name: folder.name, hostPath: dir});
  const message = String(args.message || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (message.length < 3) throw new Error("A commit message of at least 3 characters is required.");
  const paths = cleanPaths(args.paths);
  const targets = paths.length ? paths : ["."];
  const remoteR = await git(["remote"], root);
  const remotes = remoteR.stdout.split("\n").map(s => s.trim()).filter(Boolean);
  if (!remotes.includes("origin")) throw new Error(remotes.length ? `This repository has no "origin" remote (found: ${remotes.join(", ")}).` : "This repository has no remote. Add one first: git remote add origin <url>");

  const add = await git(["add", "-A", "--", ...targets], root);
  if (add.code !== 0) throw new Error(`git add failed: ${clip(add.stderr || add.stdout, 800)}`);
  const staged = await git(["diff", "--cached", "--name-only"], root);
  const files = staged.stdout.split("\n").map(s => s.trim()).filter(Boolean);
  let committed = false, commitLine = "";
  if (files.length) {
    const commit = await git(["commit", "-m", message], root);
    if (commit.code !== 0) throw new Error(`git commit failed: ${clip(commit.stderr || commit.stdout, 900)}`);
    committed = true;
    commitLine = (commit.stdout || "").trim().split("\n")[0] || "commit created";
  } else {
    const ahead = await git(["rev-list", "--count", "@{u}..HEAD"], root);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) === 0) {
      return {ok: true, text: `Nothing to publish: no changes and nothing unpushed in ${folder.name}.`, committed: false, pushed: false, files: 0};
    }
  }

  const target = String(args.branch || "").trim();
  if (target && !BRANCH_OK.test(target)) throw new Error("That branch name is not allowed.");
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  let pushArgs;
  if (target) pushArgs = upstream.code === 0 && upstream.stdout.trim() === `origin/${target}` ? ["push", "origin", target] : ["push", "-u", "origin", target];
  else if (upstream.code === 0) pushArgs = ["push"];
  else {
    const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
    if (!BRANCH_OK.test(current)) throw new Error("This repository is on a detached HEAD. Pass the branch name to push to.");
    pushArgs = ["push", "-u", "origin", current];
  }
  const push = await git(pushArgs, root);
  if (push.code !== 0) throw new Error(`Committed locally but the push failed: ${clip(push.stderr || push.stdout, 1200)}`);
  const text = [
    `folder ${folder.name}`,
    committed ? commitLine : "no new commit (pushing earlier commits)",
    `${files.length} file(s) staged`,
    `pushed ${clip((push.stderr || push.stdout).trim(), 500)}`,
  ].join("\n");
  return {ok: true, text: clip(text), committed, pushed: true, files: files.length};
}

module.exports = {status, publish, resolveFolder, resolveTarget, repoRoot};
