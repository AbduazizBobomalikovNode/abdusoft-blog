import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.js";

describe("crypto — AES-256-GCM round trip", () => {
  it("encrypts and decrypts back to the original value", () => {
    const plain = "123456789:AAExampleTelegramBotTokenValue";
    const enc = encryptSecret(plain);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plain = "same-secret-value";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("returns empty string for empty input, without an enc:v1: prefix", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  it("reads legacy plain-text values (no enc:v1: prefix) unchanged", () => {
    expect(decryptSecret("plain-legacy-token")).toBe("plain-legacy-token");
  });

  it("returns empty string (never throws) for a corrupted/tampered ciphertext", () => {
    const enc = encryptSecret("some-secret");
    const tampered = enc.slice(0, -4) + "abcd";
    expect(decryptSecret(tampered)).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    expect(decryptSecret(null)).toBe("");
    expect(decryptSecret(undefined)).toBe("");
  });
});

describe("maskSecret", () => {
  it("keeps only the last 4 characters visible", () => {
    expect(maskSecret("123456789:AAExampleTelegramBotTokenValue")).toBe("••••alue");
  });

  it("returns empty string for empty input", () => {
    expect(maskSecret("")).toBe("");
  });
});
