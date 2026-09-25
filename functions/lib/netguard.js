"use strict";
// Safe outbound fetch for URLs that come from users or AI (open_url, MCP connectors).
// Blocks private, loopback, link-local, carrier-grade NAT and metadata addresses (SSRF), checks
// every redirect hop, and caps time and size.
const dns = require("dns").promises;
const net = require("net");

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}
async function assertPublicUrl(raw, lookup = dns.lookup) {
  let url;
  try { url = new URL(String(raw)); } catch (_error) { throw new Error("That is not a valid web address."); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http and https addresses can be opened.");
  if (url.username || url.password) throw new Error("Addresses with passwords are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|metadata(\.google\.internal)?)$/i.test(host) || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("That address is not allowed.");
  const addresses = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("That address is not allowed.");
  return url;
}
// Fetches a public URL with manual, re-checked redirects. Returns {url, status, contentType, text}.
async function safeFetch(raw, {method = "GET", headers = {}, body, timeoutMs = 12000, maxBytes = 2 * 1024 * 1024, lookup} = {}) {
  let url = await assertPublicUrl(raw, lookup);
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(url, {method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs)});
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await assertPublicUrl(new URL(response.headers.get("location"), url).toString(), lookup);
      method = "GET"; body = undefined;
      continue;
    }
    const reader = response.body && response.body.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); break; }
        chunks.push(value);
      }
    }
    return {url: url.toString(), status: response.status, contentType: String(response.headers.get("content-type") || ""), headers: response.headers, text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8")};
  }
  throw new Error("Too many redirects.");
}
// Plain text from HTML: drops scripts/styles/nav chrome, keeps headings and paragraphs.
function htmlToText(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const text = String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return {title: title.replace(/\s+/g, " ").trim(), text};
}
module.exports = {isPrivateIp, assertPublicUrl, safeFetch, htmlToText};
