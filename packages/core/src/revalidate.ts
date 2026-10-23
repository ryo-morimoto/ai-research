import type { Fingerprint, SourceKind, Volatility } from "./types.ts";

/**
 * 照らし直しの規則（docs/02 §6、docs/03 §2.6.4、制約 W-03・Q-02）
 *
 * どれも LLM を使わない。plan で確かめ方を決め、judge で「変わっていない／変わった／分からない」を決める。
 * 変わっていなければ本文を読まずに確認済にできる。変わっていれば抜き書きを照合する。
 */
export type RevalidationMethod = "github-commit" | "arxiv-version" | "conditional-get" | "always-fetch";

export function planRevalidation(kind: SourceKind, volatility: Volatility): RevalidationMethod {
  if (volatility === "volatile") return "always-fetch";
  if (kind === "github") return "github-commit";
  if (kind === "arxiv") return "arxiv-version";
  return "conditional-get";
}

export type Observation =
  | { method: "github-commit"; commit: string }
  | { method: "arxiv-version"; version: string }
  | { method: "conditional-get"; status: 304 }
  | { method: "conditional-get"; status: 200; textHash: string; etag?: string; lastModified?: string }
  | { method: "always-fetch"; textHash: string };

export type Judgement = "unchanged" | "changed" | "unknown";

export function judgeRevalidation(prev: Fingerprint, obs: Observation): Judgement {
  switch (obs.method) {
    case "github-commit":
      if (!prev.commit) return "unknown";
      return prev.commit === obs.commit ? "unchanged" : "changed";
    case "arxiv-version":
      if (!prev.arxivVersion) return "unknown";
      return prev.arxivVersion === obs.version ? "unchanged" : "changed";
    case "conditional-get":
      if (obs.status === 304) return prev.etag || prev.lastModified ? "unchanged" : "unknown";
      if (!prev.textHash) return "changed";
      return prev.textHash === obs.textHash ? "unchanged" : "changed";
    case "always-fetch":
      // 変わりやすいものは、ハッシュが同じでも照合し直す（照合は安いので、規則を単純に保つ）
      return "changed";
  }
}

/** 条件付き GET の要求ヘッダ */
export function conditionalHeaders(prev: Fingerprint): Record<string, string> {
  const h: Record<string, string> = {};
  if (prev.etag) h["If-None-Match"] = prev.etag;
  if (prev.lastModified) h["If-Modified-Since"] = prev.lastModified;
  return h;
}
