"use strict";
// AES-256-GCM for connector tokens at rest. The key lives only in Secret Manager
// (CONNECTOR_TOKEN_KEY, 32 random bytes, base64). Stored form: v1.<iv>.<tag>.<ciphertext> (base64url).
const crypto = require("crypto");
function keyBytes(b64) {
  const key = Buffer.from(String(b64 || "").trim(), "base64");
  if (key.length !== 32) throw new Error("Connector encryption key is not configured.");
  return key;
}
function encrypt(plain, b64Key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(b64Key), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
function decrypt(stored, b64Key) {
  const [v, iv, tag, data] = String(stored || "").split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Stored token is unreadable.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(b64Key), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
module.exports = {encrypt, decrypt};
