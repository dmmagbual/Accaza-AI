# Accaza AI laptop worker

Runs **tasks** for the owner on the owner's laptop (SUPERDAD): long, multi-step jobs where the AI plans, writes and runs code, builds files (Word, Excel, PowerPoint, PDF, charts) and researches the web, then hands back the files. You start a task in the web app with **⚙ Task** in the chat box.

## How it fits together

```
Browser (accaza-ai.web.app)  --tasks callable-->  Firestore  tasks/{id}, tasks/{id}/events
                                                   Storage    gs://accaza-ai-task-files/tasks/{id}/…
                                                        ^
                                                        |  (outbound only: Firestore listener,
Laptop: worker/index.js  --------------------------------+   Storage, Secret Manager, AI APIs)
   └─ Docker container per task: accaza-sandbox:1
        /workspace   = %USERPROFILE%\.accaza-ai\workspaces\<chatId>  (inputs/, outputs/)
        /mnt/<name>  = folders you list in config.json (read-only unless "write": true)
```

- The laptop opens **no ports**. It only connects out.
- Status: `queued → running → (waiting → queued →) done | failed | stopped`. A task that asks you a question pauses. Your answer puts it back in the queue, and it carries on from its saved state (`tasks\<id>\state.json`).
- One task runs at a time. Limits: 40 steps and 30 minutes per task (see `config.json`), 2 minutes per code run by default (10 at most), and 20 files of up to 20 MB each delivered from `outputs/`.
- Models: Gemini (3.8 Flash, then Flash-Lite), then DeepSeek, then Cerebras. A model that returns a quota or server error rests for 5 minutes.

## Security

- AI-written code only runs inside the container. The container has no network (`--network none`), runs as uid 1000 with every capability dropped, has a read-only system disk, has memory, CPU and process limits, and receives no keys.
- Web research (`web_search`, `open_url`) runs in the worker and uses the same caps and SSRF guard as the chat.
- Leftover processes are killed after every step. If the sandbox jams, it is recreated, and the workspace on disk is kept.
- Finished files are collected with symlinks skipped and paths checked to stay inside `outputs/`.
- The worker's service account (`laptop-worker@accaza-ai`) can only reach Firestore, the task files bucket and 4 secrets (Gemini, web search, DeepSeek, Cerebras). API keys stay in memory and are never written to disk.
- Only the owner can create tasks (the `tasks` callable), and the worker refuses tasks from any other uid.
- Shared folders can only be set in `config.json` on the laptop, never from the web app.

## Setup (once)

1. **Docker Desktop** (WSL2 backend). Leave "Start Docker Desktop when you sign in" on.
2. `cd functions; npm ci; cd ..`. The worker uses the same packages as the Cloud Functions.
3. `powershell -ExecutionPolicy Bypass -File worker\setup-gcp.ps1`. This creates the bucket, the service account, its permissions, and the key in `%USERPROFILE%\.accaza-ai\worker-key.json`.
4. Copy `worker\config.example.json` to `%USERPROFILE%\.accaza-ai\config.json` and edit it. Remove the example folder, or point it at a real folder.
5. `node worker\index.js --check`. Every line should say OK. On first run it builds the sandbox image (a few minutes).
6. `node worker\scripts\sandbox-selftest.js`. This checks that the sandbox isolation holds on this machine.
7. `powershell -ExecutionPolicy Bypass -File worker\install-startup.ps1`. This starts the worker hidden now and each time you sign in. Remove it with `-Remove`.

Keep the data folder outside AppData. The Claude desktop app (and other Microsoft Store apps) sees a private copy of AppData, so files written there by one program can be invisible to another.

## Day to day

| What | How |
|---|---|
| Is it running? | Web app → **Tasks** shows "Laptop online · Docker ready". The heartbeat is every 30 s, and the laptop counts as offline after 90 s. |
| Logs | `%USERPROFILE%\.accaza-ai\logs\worker.log` (JSON lines, rotates at 5 MB) and `console.log` |
| Queue a task from the laptop | `node worker\scripts\enqueue.js "what to do" [file …]` |
| Inspect a task | `node worker\scripts\task-status.js [taskId] [-v]` |
| Share a folder | Add `{"name": "Reports", "path": "C:\\…\\Reports", "write": false}` to `folders` in `config.json`, then restart the worker |
| Restart the worker | `Stop-ScheduledTask "Accaza AI laptop worker"; Start-ScheduledTask "Accaza AI laptop worker"` |
| Change sandbox libraries | Edit `sandbox/requirements.txt`, bump `IMAGE` in `lib/sandbox.js` (e.g. `accaza-sandbox:2`), restart. The worker builds the new image. |
| Rotate the key | `gcloud iam service-accounts keys list --iam-account laptop-worker@accaza-ai.iam.gserviceaccount.com`, create a new one, delete the old one |
| Clean up disk | Workspaces live in `%USERPROFILE%\.accaza-ai\workspaces\<chatId>`. Delete the folders of chats you no longer need. |

While a task runs, the worker keeps Windows awake (`keepAwake` in config). If the laptop sleeps or restarts mid-task anyway, the task goes back to the queue and continues when the worker is back.
