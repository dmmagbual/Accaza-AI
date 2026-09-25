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
- **Memory** (registered users):
  - Settings → Personalise has "About you" and "How should Accaza AI reply?", plus switches for Use memory and Learn from chats.
  - After each reply, Flash-Lite looks at that one exchange and adds, updates or removes short memories. The answer shows "Memory updated ✓" when something changed.
  - "remember that…" and "forget…" work even with learning off.
  - Up to 50 memories. Card, bank, ID and phone numbers, passwords and health details are never stored (prompt rule plus a server-side filter).
  - Settings → Memory lists every memory, with delete and delete all.
- **Skills** (registered users), like Claude Skills or custom GPTs: a name, a "when to use" description, instructions, and reference files (.md/.txt/.csv/.json/.pdf).
  - Claude-style skill **.zip** or **SKILL.md** files can be imported. Front matter gives the name and description, and scripts are skipped.
  - Files are read once (PDFs through Gemini), chunked and embedded with `gemini-embedding-001` (768-d), and searched with Firestore vector search.
  - In chat, the AI sees the skill catalogue and calls `read_skill` / `search_skill` tools. Typing **/** pins a skill for the message.
  - The owner can share a skill with everyone. Members can create up to 5 skills; staff 50.
- **Web search and links** (everyone):
  - The AI calls `web_search` for anything current. It uses Gemini Google Search grounding with the `WEB_SEARCH_KEY` secret (a key from the accaza-ai project), then the chat key, then Wikipedia's free API as a last resort.
  - `open_url` reads a link. It's SSRF-guarded: no private addresses, and every redirect is re-checked.
  - Sources show under the answer and are saved with the chat.
  - Daily caps: 5 searches per member/guest, 60 per owner/staff, 150 in total, to stay inside the 5,000-a-month free allowance.
- **Connectors** (owner and approved staff), under Settings → Connectors:
  - **Google Drive, Gmail and Calendar, read-only.**
    - Sign-in uses OAuth with PKCE. The refresh token is stored AES-256-GCM encrypted with the `CONNECTOR_TOKEN_KEY` secret.
    - Tools: `drive_search`, `drive_read`, `gmail_search`, `gmail_read`, `calendar_events`.
    - Needs a Google OAuth client (see "Google connector setup").
  - **MCP servers** (Streamable HTTP), added by URL plus an optional token (stored encrypted).
    - Only tools marked read-only are used, unless "Allow actions that change things" is ticked.
    - SSRF-guarded.
  - Content from connected apps is treated as data, never as instructions.
- **Model menu** next to the message box. **Auto** is the normal chain, or pick a model:
  - Owner/staff can pick any built-in model. Members and guests can pick Flash-Lite, Groq, Cerebras or DeepSeek.
  - The picked model goes first, with the Auto chain behind it. A note appears when a backup answered, or when the picked model can't read an attached file.
  - The choice is remembered per chat.
- **Owner-added models** (Settings → Models):
  - Supported: any OpenAI-compatible provider (OpenAI, OpenRouter, Mistral, xAI, Together, Fireworks, Groq, DeepSeek, Cerebras, or a custom https address), Anthropic (Claude) and Google Gemini.
  - Each added model is tested before it's saved. The key is stored AES-256-GCM encrypted in `models/{id}`.
  - Each has an audience (only me / staff / everyone) and an optional daily cap (`modelUsage/{day}`).
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

## Canvas and published sites

- Signed-in users can ask for a web page, website, app, game or dashboard. The AI builds it in a **canvas** beside the chat instead of pasting code.
  - Two kinds: `html` (one self-contained page) or `react` (one component file, with Tailwind classes).
  - Tabs: Preview (sandboxed iframe, phone or desktop width) and Code (editable; "Save my edits" makes a new version).
  - Follow-ups edit the open canvas with exact find/replace edits, so small changes do not rewrite the whole page.
  - Versions: ◀ ▶ to look back, Restore to continue from an older one. The last 50 versions are kept.
  - Select code and use "Ask" for a change to just that part. Quick actions: improve design, mobile-friendly, fix bugs, add comments.
  - Errors in the preview are shown with a "Fix this" button.
  - The **Canvases** button lists every canvas and its site.
- **Publish** (owner and approved staff): the page goes live at `https://accaza-sites.web.app/<name>`.
  - Sites are served from a separate origin with a strict Content-Security-Policy: no requests out (`connect-src 'none'`), no form posts. So sites cannot collect data or payments, and cannot reach the app.
  - "Add a photo" shrinks the photo (about 1600px JPEG, 900 KB max) and hosts it at `/a/<id>` on the sites origin.
  - Publishing is a snapshot. After more edits, tap **Update site**. Unpublish takes it offline; deleting a canvas also unpublishes it.
- Canvas turns get a longer time budget (up to about 5 minutes) and larger outputs.

## Layout

- `public/`: the web app (`index.html`), manifest, service worker and icons, served by Firebase Hosting.
- `functions/index.js`: the callables `chat`, `upload`, `skills` and `account` (region asia-southeast1, App Check enforced).
- `functions/lib/providers.js`: the AI chain, timeouts and reply cleanup.
- `functions/lib/access.js`: tiers, owner emails and daily limits.
- `functions/lib/files.js`: attachment checks, the upload cap, the Gemini Files API, owner-bound resolution.
- `functions/lib/memory.js`: settings, memories, extraction, sensitive-data filter.
- `functions/lib/skills.js` and `functions/lib/tools.js`: skill storage, ingestion, retrieval tools, and the tool combiner.
- `functions/lib/websearch.js` and `functions/lib/netguard.js`: web tools and the safe fetch.
- `functions/lib/google.js`, `functions/lib/mcp.js` and `functions/lib/crypto.js`: connectors and token encryption.
- `functions/lib/models.js`: model menu, added models, test-before-save, caps.
- `functions/lib/canvas.js`: canvas storage, versions, AI canvas tools, page builder, publishing, and the `sites` function that serves published pages.
- `sites-public/`: static files for the accaza-sites Hosting site (everything else goes to the `sites` function).
- `functions/lib/chats.js`: saved chats (create, regenerate, edit, list, rename, delete).
- `firestore.rules`: browsers get no direct database access. Everything goes through the functions.
- `tests/server.test.js`: unit tests.

## Data (Firestore, asia-southeast1)

- `users/{uid}`: email, name, role (owner/staff/member), status, approval stamps.
- `users/{uid}/chats/{chatId}` and `.../messages/{id}`: saved chats. Only the server reads or writes them, always under the caller's own uid.
- `users/{uid}/settings/profile` and `users/{uid}/memories/{id}`: personalisation and memory.
- `skills/{id}` and `skills/{id}/chunks/{id}` (vector index on `embedding`, defined in `firestore.indexes.json`): skills.
- `uploads/{id}` (TTL `expireAt`) and `uploadUsage/{day}`: attachments and the daily upload cap.
- `searchUsage/{day}`: web search caps.
- `users/{uid}/connectors/{google|mcp_*}` and `oauthStates/{state}`: connectors (tokens encrypted) and one-time OAuth states.
- `users/{uid}/canvases/{id}` and `.../versions/{n}`: canvases and their versions.
- `sites/{slug}` and `siteAssets/{id}`: published pages (built HTML) and site photos.
- `usage/{day}`: per-person and total message counts for members and guests (Manila day).
- `chatLog/{id}`: analytics (who asked, which AI answered, and a SHA-256 hash of the question). The question text is not stored here.
- `providerHealth/{day}`: backup answers and provider failures.
- `adminLog/{id}`: staff approvals and removals.

## AI keys

The keys are stored as Secret Manager secrets in `accaza-ai`: GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, DEEPSEEK_API_KEY, OLLAMA_ACCESS_CLIENT_ID, OLLAMA_ACCESS_CLIENT_SECRET, ASHNA_API_KEY, WEB_SEARCH_KEY, CONNECTOR_TOKEN_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET. They never go in this repository. To change one:

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

## Google connector setup (one time)

1. Google Cloud console → project **accaza-ai** → **Google Auth Platform**.
   - Set up **Branding**: app name "Accaza AI", with your email as the support email.
   - Under **Audience**, choose External, and add the Google accounts that may connect as **test users** (up to 100).
2. **Clients → Create client** → Web application.
   - Authorised redirect URI: `https://accaza-ai.web.app/oauth/google`
3. Save the client ID and secret as secrets, then redeploy (Actions → Test and deploy → Run workflow):
   ```powershell
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID --project accaza-ai
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project accaza-ai
   ```

While the app is in "Testing" mode, Google asks each person to reconnect every 7 days. Publishing the app for Gmail/Drive access requires Google's verification.
