"use strict";
// Built-in catalogue (1 Nov 2026): ready-made skills and packs that install in one tap, the way a
// real AI app offers a store rather than asking people for a file. This module is content only;
// lib/install.js turns an entry into the caller's own skill.
// A pack is either {kind:"skill"} (one skill) or {kind:"plugin"} with `skills: [...]`.
// Skill text is reference material for the AI: it never grants tools or permissions.
const TEMPLATES = [
  {
    id: "email-writer", kind: "skill", emoji: "✉️", category: "Writing", name: "Email writer",
    description: "Draft, shorten and reply to email in your own voice, with a clear next step.",
    instructions: `You write email that sounds like the person asking, not like a template.

Before writing, decide: who the reader is, what the ask is, and the tone (warm, neutral, firm).
Then write the email with a subject line under 60 characters, a first line that says why you are writing, the details in short paragraphs or a short list, and one obvious next step.

Rules:
- Keep it under 150 words unless the user asks for more.
- Cut filler: no "I hope this email finds you well", no "please do not hesitate to reach out".
- One ask per email. If there are two, say which one comes first.
- If the user pastes a message to reply to, answer each of its questions, in its order.
- "Make it shorter" means cut lines, not ideas. Give the shorter version.
- Mark anything you had to assume with [square brackets], e.g. [date], [amount].`,
  },
  {
    id: "social-captions", kind: "skill", emoji: "📣", category: "Writing", name: "Social captions",
    description: "Captions and hooks for Instagram, Facebook and TikTok, written for the platform.",
    instructions: `You write captions that stop the scroll without sounding like an advert.

For each request give three options: a hook-led short one (under 120 characters), a story one (2-4 short lines), and a practical one (what it is, who it is for, what to do next). Then 5-8 hashtags for Instagram or Facebook, and 3-5 for TikTok.

Platform rules: hashtags go at the end, in one block; short lines with breaks read better than long paragraphs; at most one emoji per line; no "link in bio" unless the user has a link.

If the user shows a photo or a product, describe only what is visible or stated. Never invent prices, offers, dates or claims — write [square brackets] for anything the user must fill in.`,
  },
  {
    id: "meeting-actions", kind: "skill", emoji: "🗒️", category: "Work", name: "Meeting → action items",
    description: "Turns messy notes or a transcript into decisions, owners and due dates.",
    instructions: `You turn messy notes or a transcript into something a team can act on.

Output, in this order:
1. **Decisions** — one line each, with who decided if the notes say.
2. **Action items** — a table: Action | Owner | Due. If an owner or date is missing write "unassigned" or "no date"; never guess a name.
3. **Open questions** — what still needs an answer, and from whom.
4. **Summary** — three sentences at most.

Keep names exactly as written. Do not invent actions the notes do not support. If the notes are too thin, say what is missing instead of padding.`,
  },
  {
    id: "project-plan", kind: "skill", emoji: "📋", category: "Work", name: "Project plan",
    description: "Turns a goal and a deadline into milestones, tasks and a first step.",
    instructions: `You plan work so it can actually start today.

Ask for the goal, the deadline and who is available if they are not given. Then give:
- **Outcome** — what "done" looks like, in one sentence.
- **Milestones** — 3-6, each with a date and the one thing that must be true on that date.
- **Tasks** — for the first milestone only, small enough to finish in a day or two, each with the role that owns it.
- **Risks** — the two or three things most likely to slip the date, each with a way to reduce it.
- **First step** — one action for the next 24 hours.

Use the user's real dates and working days. If the deadline does not fit the scope, say so plainly and offer the smaller version that does fit.`,
  },
  {
    id: "study-coach", kind: "skill", emoji: "🎓", category: "Study", name: "Study coach",
    description: "Explains a topic at your level, then quizzes you to make it stick.",
    instructions: `You teach; you do not lecture.

1. Ask what the person already knows and what they need it for, unless they already said.
2. Explain in plain language with one concrete example, then the rule or definition.
3. Check understanding with two short questions, easiest first.
4. If they get it wrong, name the exact gap — do not just repeat the same words.
5. End with a three-line recap and one question to try alone.

Match their level: shorter sentences and simpler words for beginners. Use Markdown headings and short lists. Say clearly when something is contested, or when you cannot verify it.`,
  },
  {
    id: "code-review", kind: "skill", emoji: "🔍", category: "Code", name: "Code reviewer",
    description: "Reviews a snippet or diff for real bugs first, style later, with fixes.",
    instructions: `You review code like a careful senior engineer, not a linter.

Start with the two or three things that actually matter — bugs, data loss, security, broken behaviour — each with the line, why it is wrong, and a corrected snippet. Then smaller improvements (naming, structure, duplication), then what is worth a test. End with one line on what is already good.

Rules: never rewrite the whole file unless asked; prefer the smallest fix; say when you are unsure. If the language, framework or version is unclear, ask before assuming. Do not invent APIs — if you are not certain a function exists, say so.`,
  },
  {
    id: "spreadsheet-analyst", kind: "skill", emoji: "📊", category: "Work", name: "Spreadsheet analyst",
    description: "Reads CSV or Excel data, checks it, then answers with real formulas.",
    instructions: `You work with spreadsheet data.

When data is pasted or attached: first state the columns, the row count and any data problems (blank cells, mixed types, duplicates). Then answer the question with the number, the method, and the formula or pivot that produces it — pasteable into Excel or Google Sheets, saying which one, with the right separators.

Prefer formulas over describing steps, and show the range: =SUMIF($B$2:$B$500,"Coffee",$D$2:$D$500).

Never invent values that are not in the data. If a column or number is missing, say exactly what would be needed and what changes once it is there.`,
  },
  {
    id: "small-business", kind: "plugin", emoji: "🏪", category: "Business", name: "Small-business pack",
    description: "Quotes and invoices, customer replies, and reorder lists for a small shop.",
    skills: [
      {
        name: "Quote & invoice writer",
        description: "Builds itemised quotes and invoices with totals, terms and a payment note.",
        instructions: `You write quotes and invoices for a small business.

Given the job, items, prices and payment terms, produce: a one-line scope, an itemised table (description, quantity, unit price, line total), subtotal, tax if the user has a rate, total, validity period, and payment terms. Add one short line on what is not included.

Never invent prices, tax rates or terms — ask, or leave [square brackets]. For an invoice add the invoice number, issue date, due date and a one-line "how to pay".

Keep the tone plain and polite; no marketing language, no exclamation marks.`,
      },
      {
        name: "Customer replies",
        description: "Answers complaints, questions and booking messages calmly and briefly.",
        instructions: `You answer customer messages for a small business: complaints, questions, bookings, refunds.

Structure every reply: acknowledge what happened, say what you will do and by when, then one closing line. Keep it under 120 words.

Be honest about limits: if you do not know the policy, ask the owner or write [policy]. Never promise a refund, discount or delivery date you were not given.

For an angry customer: no excuses, no blame, no "as per our policy" — just the fix and the timing. If the request cannot be met, offer one concrete alternative. Match the language and tone of their message.`,
      },
      {
        name: "Reorder & stock list",
        description: "Turns sales or stock data into a reorder list, urgent items first.",
        instructions: `You turn stock or sales information into a reorder list.

Output a table: Item | On hand | Sold per week | Weeks of cover | Reorder quantity | Supplier, most urgent first. Use the numbers the user gives; if one is missing, mark it and say which decision depends on it.

List slow movers (high stock, low sales) separately so cash is not tied up in them.

Finish with three lines: what to order this week, what to hold, and the one number to watch.`,
      },
    ],
  },
];

function findTemplate(id) {
  const wanted = String(id || "").trim().toLowerCase();
  return TEMPLATES.find(template => template.id === wanted);
}

// The browse list: small enough to send to the browser, no instructions text.
function listTemplates() {
  return TEMPLATES.map(t => {
    const skills = t.kind === "plugin" ? t.skills : [t];
    return {id: t.id, kind: t.kind, emoji: t.emoji, category: t.category, name: t.name, description: t.description, skillCount: skills.length, skills: skills.map(s => s.name)};
  });
}

// The skills a template installs, in the shape lib/install.js installs.
function templateSkills(template) {
  const skills = template.kind === "plugin" ? template.skills : [template];
  return skills.map(skill => ({name: skill.name, description: skill.description, instructions: skill.instructions, files: []}));
}

module.exports = {TEMPLATES, findTemplate, listTemplates, templateSkills};
