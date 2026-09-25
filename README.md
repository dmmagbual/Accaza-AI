# Accaza AI

A standalone general-chat AI app. It has its own Firebase project (`accaza-ai`), its own logins and its own server. It is **separate from the Accaza Coffee project** and has no access to Accaza Coffee data.

Live at **https://accaza-ai.web.app**.

## What it does

- General chat with a backup chain: Gemini → Groq → Cerebras → DeepSeek → Qwen (Ollama on SUPERDAD) → Ashna. If one AI fails or times out, the next one answers.
- Replies are cleaned into plain paragraphs and "• " / "1. " lists.
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
- `functions/index.js`: the callables `chat` and `account` (region asia-southeast1, App Check enforced).
- `functions/lib/providers.js`: the AI chain, timeouts and reply cleanup.
- `functions/lib/access.js`: tiers, owner emails and daily limits.
- `firestore.rules`: browsers get no direct database access. Everything goes through the functions.
- `tests/server.test.js`: unit tests.

## Data (Firestore, asia-southeast1)

- `users/{uid}`: email, name, role (owner/staff/member), status, approval stamps.
- `usage/{day}`: per-person and total message counts for members and guests (Manila day).
- `chatLog/{id}`: who asked, which AI answered, and a SHA-256 hash of the question. The question text is never stored.
- `providerHealth/{day}`: backup answers and provider failures.
- `adminLog/{id}`: staff approvals and removals.

## AI keys

The keys are stored as Secret Manager secrets in `accaza-ai`: GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, DEEPSEEK_API_KEY, OLLAMA_ACCESS_CLIENT_ID, OLLAMA_ACCESS_CLIENT_SECRET, ASHNA_API_KEY. They never go in this repository. To change one:

```powershell
firebase functions:secrets:set GEMINI_API_KEY --project accaza-ai
```

## Test and deploy

```powershell
cd functions; npm install; cd ..
npm test
firebase deploy --project accaza-ai
```
