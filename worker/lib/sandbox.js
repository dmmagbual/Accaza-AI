"use strict";
// Docker sandbox for one task. AI-written code never runs on Windows itself: it runs in a
// throwaway Linux container that
//   - has no network (--network none), so code cannot download anything or send data out;
//   - sees only the chat's workspace folder (/workspace) plus any folders the owner listed in
//     config.json (read-only unless marked writable);
//   - runs as an unprivileged user with all Linux capabilities dropped, a read-only system disk,
//     and limits on memory, CPU and process count;
//   - never receives API keys or any other secret.
// Web research happens in the worker (web_search/open_url), not inside the container.
const {spawn} = require("child_process");
const path = require("path");

const IMAGE = "accaza-sandbox:1";
const WORKSPACE = "/workspace";
const MAX_OUTPUT = 12000;

function run(cmd, args, {input, timeoutMs = 60000, maxBytes = 4 * 1024 * 1024} = {}) {
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, done = false;
    const child = spawn(cmd, args, {windowsHide: true});
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const add = (which, chunk) => {
      if (which === "out" && stdout.length < maxBytes) stdout = Buffer.concat([stdout, chunk]);
      if (which === "err" && stderr.length < maxBytes) stderr = Buffer.concat([stderr, chunk]);
    };
    child.stdout.on("data", c => add("out", c));
    child.stderr.on("data", c => add("err", c));
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut}); };
    child.on("error", error => { stderr = Buffer.from(String(error.message)); finish(-1); });
    child.on("close", finish);
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
function clip(text, max = MAX_OUTPUT) {
  const t = String(text || "");
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.4), tail = max - head;
  return `${t.slice(0, head)}\n…[${t.length - max} characters cut]…\n${t.slice(-tail)}`;
}

// Paths the AI gives are resolved inside the sandbox and must stay under /workspace or a mounted
// folder. Returns the absolute sandbox path or throws.
function sandboxPath(raw, roots) {
  const value = String(raw || "").trim().replace(/\\/g, "/");
  if (!value) throw new Error("A file path is required.");
  if (/[\u0000-\u001f]/.test(value)) throw new Error("That path is not allowed.");
  const abs = path.posix.normalize(value.startsWith("/") ? value : `${WORKSPACE}/${value}`);
  const ok = roots.some(root => abs === root || abs.startsWith(root + "/"));
  if (!ok) throw new Error(`Paths must be inside ${roots.join(" or ")}.`);
  return abs;
}

class Sandbox {
  // folders: [{name, hostPath, write}] from config.json, mounted at /mnt/<name>.
  constructor({taskId, workspaceDir, folders = [], docker = "docker", limits = {}}) {
    this.name = `accaza-task-${taskId}`;
    this.workspaceDir = workspaceDir;
    this.folders = folders;
    this.docker = docker;
    this.limits = Object.assign({memory: "2g", cpus: "2", pids: 256}, limits);
  }
  readRoots() { return [WORKSPACE, ...this.folders.map(f => `/mnt/${f.name}`)]; }
  writeRoots() { return [WORKSPACE, ...this.folders.filter(f => f.write).map(f => `/mnt/${f.name}`)]; }

  static async available(docker = "docker") {
    const r = await run(docker, ["version", "--format", "{{.Server.Version}}"], {timeoutMs: 15000});
    return r.code === 0 ? r.stdout.trim() : "";
  }
  static async ensureImage(docker, contextDir, log) {
    const has = await run(docker, ["image", "inspect", IMAGE], {timeoutMs: 20000});
    if (has.code === 0) return true;
    if (log) log.info("sandbox_image_build", {image: IMAGE});
    const built = await run(docker, ["build", "-t", IMAGE, contextDir], {timeoutMs: 30 * 60 * 1000});
    if (built.code !== 0) throw new Error(`Could not build the sandbox image: ${clip(built.stderr, 600)}`);
    return true;
  }
  static runArgs({name, workspaceDir, folders, limits}) {
    const mount = (src, dst, readonly) => {
      if (/,/.test(src)) throw new Error(`Folder paths cannot contain commas: ${src}`);
      return ["--mount", `type=bind,source=${src},target=${dst}${readonly ? ",readonly" : ""}`];
    };
    return [
      "run", "-d", "--name", name, "--label", "accaza=task", "--hostname", "sandbox",
      "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "1000:1000", "--read-only", "--tmpfs", "/tmp:rw,exec,size=768m",
      "--memory", limits.memory, "--memory-swap", limits.memory, "--cpus", String(limits.cpus), "--pids-limit", String(limits.pids),
      "-e", "HOME=/tmp", "-e", "MPLCONFIGDIR=/tmp/mpl", "-e", "PYTHONDONTWRITEBYTECODE=1", "-e", "PYTHONUNBUFFERED=1",
      "-w", WORKSPACE,
      ...mount(workspaceDir, WORKSPACE, false),
      ...folders.flatMap(f => mount(f.hostPath, `/mnt/${f.name}`, !f.write)),
      IMAGE, "python3", "-c", REAPER,
    ];
  }
  async start() {
    const state = await run(this.docker, ["inspect", "-f", "{{.State.Running}}", this.name], {timeoutMs: 15000});
    if (state.code === 0 && state.stdout.trim() === "true") return;
    await run(this.docker, ["rm", "-f", this.name], {timeoutMs: 30000});
    const r = await run(this.docker, Sandbox.runArgs({name: this.name, workspaceDir: this.workspaceDir, folders: this.folders, limits: this.limits}), {timeoutMs: 60000});
    if (r.code !== 0) throw new Error(`Could not start the sandbox: ${clip(r.stderr, 600)}`);
  }
  // Kills and deletes the container, and waits until Docker confirms it is gone (a jammed
  // container can take a while to die).
  async remove() {
    await run(this.docker, ["kill", this.name], {timeoutMs: 30000});
    await run(this.docker, ["rm", "-f", this.name], {timeoutMs: 90000});
    for (let i = 0; i < 30; i += 1) {
      const r = await run(this.docker, ["inspect", "-f", "{{.State.Status}}", this.name], {timeoutMs: 10000});
      if (r.code !== 0) return;
      await new Promise(res => setTimeout(res, 1000));
    }
    throw new Error("Docker could not remove the old sandbox. Restart Docker Desktop.");
  }

  // Runs argv inside the container with a hard kill after timeoutSec (the inner `timeout` kills
  // the process in the container; the outer timer only stops the docker CLI).
  async exec(argv, {input, timeoutSec = 120, cwd = WORKSPACE} = {}) {
    const t = Math.max(5, Math.min(600, Math.floor(timeoutSec)));
    const r = await run(this.docker, ["exec", "-i", "-w", cwd, this.name, "timeout", "-s", "KILL", String(t), ...argv], {input, timeoutMs: (t + 20) * 1000});
    return {exitCode: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut || r.code === 137};
  }
  async runPython(code, timeoutSec) {
    const r = await this.exec(["python3", "-"], {input: String(code || ""), timeoutSec});
    return this.afterRun(shape(r, timeoutSec));
  }
  async runShell(command, timeoutSec) {
    const r = await this.exec(["bash", "-s"], {input: String(command || ""), timeoutSec});
    return this.afterRun(shape(r, timeoutSec));
  }
  // Nothing keeps running between steps: every leftover process (background jobs, a runaway fork)
  // is killed. PID 1 (the container's `sleep`) is immune to this. If the container is too jammed
  // to even do that, it is recreated; the workspace is on the laptop's disk, so no files are lost.
  async afterRun(result) {
    await run(this.docker, ["exec", this.name, "sh", "-c", "for i in 1 2 3 4 5; do kill -9 -1 2>/dev/null; done; exit 0"], {timeoutMs: 20000});
    if ((await this.processCount()) > 1) {
      await this.remove();
      await this.start();
      result.note = `${result.note ? result.note + " " : ""}The sandbox was restarted because leftover processes would not stop; files in /workspace are kept, /tmp was cleared.`;
    }
    return result;
  }
  // Processes in the container, counted from the host (works even when the container is jammed).
  async processCount() {
    const r = await run(this.docker, ["top", this.name, "-o", "pid"], {timeoutMs: 20000});
    if (r.code !== 0) return Infinity;
    return Math.max(0, r.stdout.trim().split("\n").length - 1);
  }
  async writeFile(rawPath, content) {
    const abs = sandboxPath(rawPath, this.writeRoots());
    const r = await this.exec(["sh", "-c", "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1\"", "sh", abs], {input: String(content === undefined ? "" : content), timeoutSec: 60});
    if (r.exitCode !== 0) throw new Error(clip(r.stderr || "Could not write the file.", 400));
    return {path: abs, bytes: Buffer.byteLength(String(content || ""))};
  }
  async readFile(rawPath, maxChars = 20000) {
    const abs = sandboxPath(rawPath, this.readRoots());
    const r = await this.exec(["python3", "-c", READ_SCRIPT, abs, String(maxChars)], {timeoutSec: 60});
    if (r.exitCode !== 0) throw new Error(clip(r.stderr || "Could not read the file.", 400));
    return JSON.parse(r.stdout);
  }
  async listFiles(rawPath) {
    const abs = sandboxPath(rawPath || WORKSPACE, this.readRoots());
    const r = await this.exec(["python3", "-c", LIST_SCRIPT, abs], {timeoutSec: 60});
    if (r.exitCode !== 0) throw new Error(clip(r.stderr || "Could not list files.", 400));
    return JSON.parse(r.stdout);
  }
  async workspaceBytes() {
    const r = await this.exec(["du", "-sb", WORKSPACE], {timeoutSec: 60});
    return Number(String(r.stdout).split(/\s+/)[0]) || 0;
  }
}
function shape(r, timeoutSec) {
  const out = {exit_code: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr, 6000)};
  if (r.timedOut) out.note = `Stopped after ${timeoutSec || 120} seconds (time limit).`;
  return out;
}

// PID 1 of the container: waits forever and reaps finished processes. Leftover processes are
// killed after every step (kill -9 -1 spares PID 1); without a reaper their zombies would keep
// using the process limit and the sandbox would stop being able to start anything.
const REAPER = "import os,signal,time\nsignal.signal(signal.SIGTERM,lambda *a:os._exit(0))\nwhile True:\n    try:\n        os.waitpid(-1,0)\n    except ChildProcessError:\n        time.sleep(1)\n";

const READ_SCRIPT = `
import json, os, sys
p, limit = sys.argv[1], int(sys.argv[2])
size = os.path.getsize(p)
with open(p, 'rb') as f:
    raw = f.read(min(size, limit * 4))
binary = b'\\x00' in raw[:8192]
if binary:
    print(json.dumps({"path": p, "size": size, "binary": True, "note": "Binary file. Use run_python with a suitable library (openpyxl, python-docx, pdfplumber, PIL, pandas) to read it."}))
else:
    text = raw.decode('utf-8', errors='replace')
    print(json.dumps({"path": p, "size": size, "binary": False, "truncated": len(text) > limit or size > len(raw), "text": text[:limit]}))
`;
const LIST_SCRIPT = `
import json, os, sys
root = sys.argv[1]
out = []
for dirpath, dirs, files in os.walk(root):
    depth = dirpath[len(root):].count('/')
    dirs[:] = [d for d in sorted(dirs) if not d.startswith('.') and d not in ('__pycache__', 'node_modules')][:50] if depth < 3 else []
    for name in sorted(files)[:200]:
        full = os.path.join(dirpath, name)
        try: size = os.path.getsize(full)
        except OSError: size = -1
        out.append({"path": full, "size": size})
        if len(out) >= 300: break
    if len(out) >= 300: break
print(json.dumps({"root": root, "files": out, "truncated": len(out) >= 300}))
`;

module.exports = {IMAGE, WORKSPACE, Sandbox, sandboxPath, clip, run};
