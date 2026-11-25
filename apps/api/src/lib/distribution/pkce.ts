import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636, S256). Verifier: 32 tasodifiy bayt -> base64url (43 belgi, RFC bo'yicha 43..128).
 * Manba: https://datatracker.ietf.org/doc/html/rfc7636 (§4.1, §4.2).
 */
export function base64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(bytes: (n: number) => Uint8Array = randomBytes): string {
  return base64Url(bytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export function generateState(bytes: (n: number) => Uint8Array = randomBytes): string {
  return base64Url(bytes(24));
}
