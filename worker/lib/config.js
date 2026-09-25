"use strict";
// Worker settings live on the laptop, outside the repo (never committed):
//   %USERPROFILE%\.accaza-ai\config.json   (or the file named by ACCAZA_WORKER_CONFIG)
// Not under AppData: apps installed from the Microsoft Store (such as the Claude app) see a private
// copy of AppData, so files written there by one program can be invisible to another.
// Only the owner, sitting at the laptop, can change which folders tasks may see. Nothing from the
// web app can add a folder.
const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultDataDir() {
  return process.env.ACCAZA_WORKER_HOME || path.join(os.homedir(), ".accaza-ai");
}
function configPath() { return process.env.ACCAZA_WORKER_CONFIG || path.join(defaultDataDir(), "config.json"); }

function loadConfig(file = configPath()) {
  if (!fs.existsSync(file)) throw new Error(`Worker config not found at ${file}. Copy worker/config.example.json there and fill it in.`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const dataDir = raw.dataDir || path.dirname(file);
  const cfg = {
    file, dataDir,
    workerId: String(raw.workerId || os.hostname()).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40),
    projectId: raw.projectId || "accaza-ai",
    serviceAccountFile: raw.serviceAccountFile || path.join(dataDir, "worker-key.json"),
    ownerEmail: String(raw.ownerEmail || "").trim().toLowerCase(),
    docker: raw.docker || "docker",
    limits: Object.assign({maxSteps: 40, maxMinutes: 30}, raw.limits || {}),
    sandbox: Object.assign({memory: "2g", cpus: 2, pids: 256}, raw.sandbox || {}),
    folders: [],
    keepAwake: raw.keepAwake !== false,
  };
  if (!cfg.ownerEmail) throw new Error("config.json needs ownerEmail.");
  cfg.limits.maxSteps = Math.max(5, Math.min(100, Number(cfg.limits.maxSteps) || 40));
  cfg.limits.maxMinutes = Math.max(5, Math.min(180, Number(cfg.limits.maxMinutes) || 30));
  const names = new Set();
  for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
    const name = String(f && f.name || "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`Folder name "${name}" must be letters, numbers, - or _.`);
    if (names.has(name.toLowerCase())) throw new Error(`Folder name "${name}" is used twice.`);
    const hostPath = path.resolve(String(f.path || ""));
    if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) throw new Error(`Folder "${name}" does not exist: ${hostPath}`);
    if (hostPath.includes(",")) throw new Error(`Folder "${name}": paths with commas are not supported.`);
    const home = path.resolve(os.homedir()), root = path.parse(hostPath).root;
    if (hostPath === root || hostPath === home) throw new Error(`Folder "${name}": share a specific folder, not the whole drive or home folder.`);
    names.add(name.toLowerCase());
    cfg.folders.push({name, hostPath, write: f.write === true});
  }
  return cfg;
}
module.exports = {loadConfig, configPath, defaultDataDir};
