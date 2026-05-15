import crypto from "crypto";
import { config } from "./config.js";

const KEY = Buffer.from(config.encryptionKey, "utf8");

export function encrypt(plainText) {
    const iv = crypto.randomBytes(12); // GCM standard
    const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);

    const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // store as: iv.tag.ciphertext (base64)
    return [
        iv.toString("base64"),
        tag.toString("base64"),
        enc.toString("base64")
    ].join(".");
}

export function decrypt(payload) {
    const [ivB64, tagB64, encB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !encB64) throw new Error("Invalid encrypted payload");

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const enc = Buffer.from(encB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);

    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
}
