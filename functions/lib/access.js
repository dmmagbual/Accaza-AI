"use strict";
// Who may chat and how much (Danilo, 25 Sep 2026):
// - owner: the emails in OWNER_EMAILS, once the email is verified. Unlimited; approves staff.
// - staff: registered accounts the owner approved. Unlimited.
// - member: registered, email verified, not yet approved. Guest limits.
// - guest: anonymous sign-in. 10 messages per Manila day each.
// Members and guests also share one daily ceiling across everyone, so resetting a browser
// (new anonymous account) or registering many emails cannot run up the AI bill without bound.
const {HttpsError} = require("firebase-functions/v2/https");

const OWNER_EMAILS = ["danilomagbual@gmail.com"];
const DAILY_LIMIT = 10;
const SHARED_DAILY_LIMIT = 100;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function manilaDay(now) {
  return new Date(Number(now) + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}
function isAnonymous(auth) {
  return Boolean(auth && auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider === "anonymous");
}
function normalEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function isOwnerEmail(email) {
  return OWNER_EMAILS.includes(normalEmail(email));
}
function unlimited(tier) {
  return tier === "owner" || tier === "staff";
}

// Returns {uid, tier, email, name}. Throws for a missing login or an unverified email.
async function resolveAccount(db, auth) {
  if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Sign in or continue as a guest first.");
  if (isAnonymous(auth)) return {uid: auth.uid, tier: "guest", email: "", name: "Guest"};
  const email = normalEmail(auth.token && auth.token.email);
  if (!email) throw new HttpsError("permission-denied", "This account has no email address.");
  if (!(auth.token && auth.token.email_verified === true)) throw new HttpsError("failed-precondition", "Verify your email first. Open the link we emailed you, then tap \"I've verified\".");
  if (isOwnerEmail(email)) return {uid: auth.uid, tier: "owner", email, name: cleanName(auth.token.name) || email};
  const snap = await db.collection("users").doc(auth.uid).get(), user = snap.exists ? snap.data() : {};
  const tier = user.role === "staff" && user.status === "approved" ? "staff" : "member";
  return {uid: auth.uid, tier, email, name: cleanName(user.name) || email};
}
function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// One transaction on the day document enforces both limits atomically, so concurrent sends
// cannot overshoot either limit.
async function claimMessage(db, uid, day, now) {
  const ref = db.collection("usage").doc(day);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), usage = snap.exists ? snap.data() : {};
    const users = usage.users && typeof usage.users === "object" ? usage.users : {};
    const mine = Number(users[uid] && users[uid].count || 0), total = Number(usage.total || 0);
    if (mine >= DAILY_LIMIT) throw new HttpsError("resource-exhausted", `Daily limit reached (${DAILY_LIMIT} messages today). Try again tomorrow.`, {limit: "user"});
    if (total >= SHARED_DAILY_LIMIT) throw new HttpsError("resource-exhausted", "Chat is busy today. Please try again tomorrow.", {limit: "shared"});
    tx.set(ref, {total: total + 1, updatedAt: now, users: Object.assign({}, users, {[uid]: {count: mine + 1, updatedAt: now}})});
    return {used: mine + 1, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - mine - 1)};
  });
}
// A message the AI never answered should not cost the user one of their 10.
async function releaseMessage(db, uid, day) {
  const ref = db.collection("usage").doc(day);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const usage = snap.data(), users = usage.users && typeof usage.users === "object" ? usage.users : {}, mine = Number(users[uid] && users[uid].count || 0);
      if (mine < 1) return;
      tx.set(ref, Object.assign({}, usage, {total: Math.max(0, Number(usage.total || 0) - 1), users: Object.assign({}, users, {[uid]: Object.assign({}, users[uid], {count: mine - 1})})}));
    });
  } catch (_error) { /* best effort: a failed refund only costs one message */ }
}
async function usedToday(db, uid, day) {
  const snap = await db.collection("usage").doc(day).get(), usage = snap.exists ? snap.data() : {};
  return Number(usage.users && usage.users[uid] && usage.users[uid].count || 0);
}

module.exports = {OWNER_EMAILS, DAILY_LIMIT, SHARED_DAILY_LIMIT, manilaDay, isAnonymous, normalEmail, isOwnerEmail, unlimited, resolveAccount, cleanName, claimMessage, releaseMessage, usedToday};
