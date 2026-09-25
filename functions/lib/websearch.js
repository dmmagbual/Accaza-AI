"use strict";
// Web search and page reading tools (Danilo, 26 Sep 2026, step C).
// web_search: Gemini with Google Search grounding (WEB_SEARCH_KEY first, then the chat key),
// falling back to Wikipedia's free search API so the AI can still cite something when Google
// grounding is unavailable. open_url: reads one public page (SSRF-guarded).
// Daily caps keep grounding inside the free allowance (5,000 searches a month).
const {safeFetch, htmlToText} = require("./netguard");

const SEARCH_MODEL = "gemini-3.5-flash-lite";
const CAPS = {perUser: {limited: 5, unlimited: 60}, shared: 150};
const TOOL_DECLARATIONS = [
  {name: "web_search", description: "Search the web for current or recent information (news, prices, versions, schedules, events, anything that may have changed). Returns a short summary and sources.", parameters: {type: "object", properties: {query: {type: "string", description: "A focused search query."}}, required: ["query"]}},
  {name: "open_url", description: "Read the text of one public web page, e.g. a link the user gave.", parameters: {type: "object", properties: {url: {type: "string", description: "Full http(s) address."}}, required: ["url"]}},
];
const GUIDE = "You can call web_search for anything current or time-sensitive (today's news, prices, releases, schedules, weather, laws that change) and open_url to read a link. After using them, answer from what they returned and mention the most relevant sources by name. If a search fails, say so and answer from what you know, noting it may be out of date.";

function cleanLine(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function domain(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_error) { return ""; } }

async function claimSearch(db, uid, day, unlimited, now) {
  const ref = db.collection("searchUsage").doc(day), cap = unlimited ? CAPS.perUser.unlimited : CAPS.perUser.limited;
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), usage = snap.exists ? snap.data() : {}, users = usage.users && typeof usage.users === "object" ? usage.users : {};
    const mine = Number(users[uid] || 0), total = Number(usage.total || 0);
    if (mine >= cap || total >= CAPS.shared) return false;
    tx.set(ref, {total: total + 1, updatedAt: now, users: Object.assign({}, users, {[uid]: mine + 1})});
    return true;
  });
}

async function geminiGrounded(key, query, fetchImpl = fetch) {
  const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${SEARCH_MODEL}:generateContent`, {method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, signal: AbortSignal.timeout(25000),
    body: JSON.stringify({contents: [{role: "user", parts: [{text: `Search the web and report the facts that answer this, with dates and numbers where relevant. Be concise (under 200 words): ${query}`}]}], tools: [{googleSearch: {}}], generationConfig: {temperature: 0, maxOutputTokens: 1024}})});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(`grounding ${response.status}`); e.status = response.status; throw e; }
  const c = body.candidates && body.candidates[0] || {};
  const summary = ((c.content && c.content.parts) || []).map(p => p.text || "").join("").trim();
  const seen = new Set();
  const sources = ((c.groundingMetadata && c.groundingMetadata.groundingChunks) || []).map(ch => ch && ch.web).filter(w => w && /^https:\/\//.test(w.uri || ""))
    .map(w => ({title: cleanLine(w.title || domain(w.uri), 120), url: w.uri})).filter(s => { if (seen.has(s.title + s.url)) return false; seen.add(s.title + s.url); return true; }).slice(0, 8);
  if (!summary) throw new Error("empty grounding answer");
  return {summary, sources, engine: "google"};
}
async function wikipedia(query, fetchImpl = fetch) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&utf8=1&srsearch=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, {headers: {"user-agent": "AccazaAI/1.0 (https://accaza-ai.web.app)"}, signal: AbortSignal.timeout(10000)});
  const body = await response.json().catch(() => ({}));
  const hits = (body.query && body.query.search) || [];
  if (!hits.length) return {summary: "No results found.", sources: [], engine: "wikipedia"};
  return {
    summary: hits.map(h => `${h.title}: ${cleanLine(String(h.snippet || "").replace(/<[^>]+>/g, ""), 300)}`).join("\n"),
    sources: hits.map(h => ({title: `${h.title} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`})),
    engine: "wikipedia",
    note: "Google search was unavailable; these are Wikipedia results only and may not reflect the latest news.",
  };
}

// Builds the web tools for one request. keys: {search, chat} (strings), onSources(list) collects
// sources for the answer.
function webTools({db, uid, day, unlimited, keys, onSources, now = Date.now(), fetchImpl = fetch, safeFetchImpl = safeFetch}) {
  return {
    declarations: TOOL_DECLARATIONS,
    labels: {web_search: args => `Searching the web: ${cleanLine(args.query, 80)}`, open_url: args => `Reading ${domain(args.url) || "a web page"}`},
    run: async (name, args) => {
      if (name === "web_search") {
        const query = cleanLine(args.query, 300);
        if (!query) return {error: "Empty query."};
        if (!(await claimSearch(db, uid, day, unlimited, now))) return {error: "The daily web search limit is reached. Answer from your own knowledge and say it may be out of date."};
        let result = null;
        for (const key of [keys.search, keys.chat].filter(Boolean)) {
          try { result = await geminiGrounded(key, query, fetchImpl); break; } catch (_error) { /* try the next key, then Wikipedia */ }
        }
        if (!result) { try { result = await wikipedia(query, fetchImpl); } catch (_error) { return {error: "Web search is unavailable right now."}; } }
        if (onSources) onSources(result.sources);
        return result;
      }
      if (name === "open_url") {
        try {
          const page = await safeFetchImpl(args.url, {headers: {"user-agent": "AccazaAI/1.0 (+https://accaza-ai.web.app)", accept: "text/html,text/plain;q=0.9,*/*;q=0.5"}});
          if (page.status >= 400) return {error: `The page returned HTTP ${page.status}.`};
          const isHtml = /html/i.test(page.contentType), parsed = isHtml ? htmlToText(page.text) : {title: "", text: page.text};
          if (!/^(text\/|application\/(json|xml))/i.test(page.contentType) && !isHtml) return {error: `That link is a ${page.contentType || "binary"} file, not a web page. Ask the user to attach it instead.`};
          if (onSources) onSources([{title: cleanLine(parsed.title || domain(page.url), 120), url: page.url}]);
          return {url: page.url, title: parsed.title, text: parsed.text.slice(0, 11000)};
        } catch (error) { return {error: cleanLine(error && error.message, 200) || "Could not open that page."}; }
      }
      return {error: "Unknown web tool."};
    },
  };
}
module.exports = {CAPS, TOOL_DECLARATIONS, GUIDE, claimSearch, geminiGrounded, wikipedia, webTools, domain};
