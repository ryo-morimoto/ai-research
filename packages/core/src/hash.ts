import { normalize } from "./normalize.ts";

/** 正規化した本文の SHA-256（16進）。Workers と Node の両方の Web Crypto で動く */
export async function textHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(normalize(text));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
