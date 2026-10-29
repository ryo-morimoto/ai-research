# 上流（mizchi/pkspec）への報告の下書き（issues/009。投稿は利用者が行う）

---

**Title:** `pkspec-adapter-vitest discover` aborts (SIGABRT) on test files containing raw surrogate-pair (emoji) literals

**Body:**

`pkspec-adapter-vitest discover` (pkspec@0.4.2, linux-amd64 release tarball) exits with SIGABRT (code 134, no output) on the file below. `vitest list` and `pkspec-adapter-vitest run --manifest` succeed on the same project.

```ts
// test/a.test.ts — vitest config: { include: ["test/**/*.test.ts"] }
// src/index.ts is a 4-line clipChars stub
import { describe, expect, it } from "vitest";
import { clipChars } from "../src/index.ts";

describe("記録の整形（例）", () => {
  const base = { runId: "run_1", at: 1, ev: 1, v: 1 };

  it("サロゲートの組を割らずに切る", () => {
    expect(clipChars("😀😀😀", 2)).toBe("😀😀");
  });
});
```

| variant | vitest 4.1.12 | vitest 5.0.5 |
| --- | --- | --- |
| as above | SIGABRT | SIGABRT |
| emoji written as `"\u{1F600}"` escapes | OK | OK |
| small edits near the emoji (add/remove a line) | flips to OK in some cases | still SIGABRT |

The only necessary ingredient is a raw surrogate-pair literal in the file; whether it crashes flips with small content changes and the vitest version, suggesting the abort depends on the byte/char offset of the surrogate pair in something the shim processes.

Environment: Linux x86_64, Node 22/26, vitest 4.1.12 / 5.0.5.
