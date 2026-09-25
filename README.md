# Accaza AI

A standalone general-chat AI app. It has its own Firebase project (`accaza-ai`), its own logins and its own server. It is **separate from the Accaza Coffee project** and has no access to Accaza Coffee data.

Live at **https://accaza-ai.web.app**.

## What it does

- A ChatGPT-style chat:
  - Replies stream in live, and a **Stop** button halts them.
  - Replies are formatted with Markdown: headings, lists, tables, and code blocks with a copy button.
  - There's **Copy** and **Regenerate** on answers, **Edit** on your last question, and dark mode.
- **Photo and PDF attachments** (JPG, PNG, WebP, HEIC, PDF; up to 3 per message, 7 MB each). You can pick, paste or drag-drop them, and photos are shrunk to 2048 px before upload.
  - The server checks each file's real type from its first bytes and stores it in the Gemini Files API, which Google deletes after 48 hours. The record lives in `uploads/{id}` with the owner's uid (Firestore TTL on `expireAt`).
  - A message can only use its own account's files.
  - Only Gemini can read files. When a file is attached, Gemini gets a second try, and then the text-only backups are told a file exists.
  - Daily upload cap: 20 for members/guests, 100 for owner/staff.
  - Deleting a chat, or all chats, also deletes its files.
- **Saved chats** in a sidebar for registered users (owner, staff, members), with rename, delete and delete all. Guests' chats stay in their browser tab only.
- Models:
  - Owner and staff start on **Gemini 3.8 Flash**, then **Flash-Lite**.
  - Members and guests start on **Flash-Lite**.
  - Then everyone falls back through Groq → Cerebras → DeepSeek → Qwen (Ollama on SUPERDAD) → Ashna. If one AI fails or times out, the next one answers. If it fails part-way through a reply, the partial reply is cleared and the next one starts over.
- Who can chat:

  | Who | How they get in | Daily limit |
  |---|---|---|
  | Owner | Registers with an owner email (`functions/lib/access.js`), verified | Unlimited, approves staff |
  | Staff | Registers, verifies email, owner approves | Unlimited |
  | Member | Registers and verifies email | 10 a day |
  | Guest | "Continue as guest" | 10 a day |

  Members and guests also share a ceiling of 100 messages a day in total.

## Layout

- `public/`: the web app (`index.html`), manifest, service worker and icons, served by Firebase Hosting.
- `functions/index.js`: the callables `chat`, `upload` and `account` (region asia-southeast1, App Check enforced).
- `functions/lib/providers.js`: the AI chain, timeouts and reply cleanup.
- `functions/lib/access.js`: tiers, owner emails and daily limits.
- `functions/lib/files.js`: attachment checks, the upload cap, the Gemini Files API, owner-bound resolution.
- `functions/lib/chats.js`: saved chats (create, regenerate, edit, list, rename, delete).
- `firestore.rules`: browsers get no direct database access. Everything goes through the functions.
- `tests/server.test.js`: unit tests.

## Data (Firestore, asia-southeast1)

- `users/{uid}`: email, name, role (owner/staff/member), status, approval stamps.
- `users/{uid}/chats/{chatId}` and `.../messages/{id}`: saved chats. Only the server reads or writes them, always under the caller's own uid.
- `uploads/{id}` (TTL `expireAt`) and `uploadUsage/{day}`: attachments and the daily upload cap.
- `usage/{day}`: per-person and total message counts for members and guests (Manila day).
- `chatLog/{id}`: analytics (who asked, which AI answered, and a SHA-256 hash of the question). The question text is not stored here.
- `providerHealth/{day}`: backup answers and provider failures.
- `adminLog/{id}`: staff approvals and removals.

## AI keys

The keys are stored as Secret Manager secrets in `accaza-ai`: GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, DEEPSEEK_API_KEY, OLLAMA_ACCESS_CLIENT_ID, OLLAMA_ACCESS_CLIENT_SECRET, ASHNA_API_KEY. They never go in this repository. To change one:

```powershell
firebase functions:secrets:set GEMINI_API_KEY --project accaza-ai
```

## Test and deploy

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`). The login is keyless: GitHub OIDC uses Workload Identity Federation to act as the `github-deploy@accaza-ai` service account, and it only accepts `dmmagbual/Accaza-AI` on `main`. Pull requests run the tests only.

To test locally, or deploy by hand in an emergency:

```powershell
cd functions; npm install; cd ..
npm test
firebase deploy --project accaza-ai --account danilomagbual@gmail.com
```
