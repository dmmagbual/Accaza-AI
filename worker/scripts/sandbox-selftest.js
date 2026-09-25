"use strict";
// Checks the sandbox on this laptop: libraries work, files land in the workspace, and the
// container cannot reach the network, the rest of the disk, root, or other containers' files.
//   node worker/scripts/sandbox-selftest.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const {Sandbox} = require("../lib/sandbox");

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "accaza-selftest-"));
  fs.mkdirSync(path.join(ws, "outputs"));
  const sb = new Sandbox({taskId: "selftest", workspaceDir: ws, folders: []});
  const results = [];
  const check = (name, pass, info) => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"} ${name}${info ? ` — ${String(info).trim().slice(0, 200)}` : ""}`); };
  try {
    await sb.start();
    let r = await sb.runPython("import docx, openpyxl, pptx, reportlab, pandas, matplotlib, pdfplumber\nprint('libs ok')");
    check("document and data libraries import", r.stdout.includes("libs ok"), r.stderr);
    r = await sb.runPython("from docx import Document\nd=Document();d.add_heading('Test',0);d.save('outputs/test.docx');print('saved')");
    check("a .docx lands in the laptop workspace", fs.existsSync(path.join(ws, "outputs", "test.docx")), r.stderr);
    r = await sb.runPython("import urllib.request\ntry:\n  urllib.request.urlopen('https://example.com', timeout=5)\n  print('NET OPEN')\nexcept Exception as e:\n  print('blocked', type(e).__name__)");
    check("no network from code", r.stdout.includes("blocked"), r.stdout);
    r = await sb.runShell("id -u; touch /etc/x 2>&1 || echo ro-root; ls /mnt 2>&1; cat /proc/1/cmdline | tr '\\0' ' '");
    check("runs as uid 1000", /^1000/m.test(r.stdout), r.stdout);
    check("system disk is read-only", r.stdout.includes("ro-root"), r.stdout);
    r = await sb.runShell("ls /c /host /mnt/c 2>&1 | head -3; env | grep -iE 'key|secret|token' | grep -v '^GPG_KEY=' || echo no-secrets");
    check("no Windows drives or secrets inside", r.stdout.includes("no-secrets") && !/Users|Program Files/.test(r.stdout), r.stdout);
    r = await sb.runPython("import time\ntime.sleep(30)", 5);
    check("time limit kills long code", Boolean(r.note) && /time limit/.test(r.note), JSON.stringify(r).slice(0, 160));
    r = await sb.runShell(":(){ :|:& };: 2>/dev/null; echo survived", 10);
    r = await sb.runPython("print('still working')");
    check("sandbox recovers after a fork bomb", r.stdout.includes("still working"), r.stderr || r.note);
    r = await sb.runShell("sleep 300 & echo started");
    const left = await sb.processCount();
    check("background processes do not outlive their step", left === 1, `${left} process(es) left`);
    const w = await sb.writeFile("notes/a.md", "# hi");
    check("write_file inside workspace", fs.existsSync(path.join(ws, "notes", "a.md")), w.path);
    let blocked = false; try { await sb.writeFile("/etc/passwd", "x"); } catch (_e) { blocked = true; }
    check("write_file outside workspace is refused", blocked);
  } catch (error) { check("sandbox started", false, error.message); }
  finally { await sb.remove(); }
  const ok = results.every(Boolean);
  console.log(ok ? "\nSandbox OK." : "\nSandbox checks FAILED.");
  process.exit(ok ? 0 : 1);
})();
