# 上流（mizchi/pkspec）への報告の下書き（issues/009）

投稿は利用者が行う（GitHub の名義での対外投稿のため）。そのまま貼れる形：

---

**Title:** `pkspec-adapter-vitest discover` aborts (SIGABRT) when a test file combines an unused `fast-check` import with a raw surrogate-pair literal

**Body:**

`pkspec-adapter-vitest discover` (pkspec@0.4.2, linux-amd64, official release tarball) crashes with SIGABRT (exit 134, no output) on a project containing the file below, while `vitest list` succeeds on the same project.

Reproduces on both **vitest 4.1.12 and 5.0.5** (standalone project, outside any monorepo; Node 22 and 26). Minimal reproduction (plain config with `include: ["test/**/*.test.ts"]`, `src/index.ts` is a 4-line `clipChars` stub):

```ts
// test/repro.test.ts
import { describe, expect, it } from "vitest";
import fc from "fast-check"; // unused — removing this line makes discover succeed
import { clipChars } from "../src/index.ts";

describe("記録の整形（例）", () => {
  const base = { runId: "run_1", at: 1, ev: 1, v: 1 };

  it("サロゲートの組を割らずに切る", () => {
    expect(clipChars("😀😀😀", 2)).toBe("😀😀");
  });
});
```

Bisect results (each change applied alone to the file above):

| change | discover |
| --- | --- |
| as above | **SIGABRT** (deterministic, 3/3) |
| remove the unused `import fc from "fast-check"` | OK |
| keep the import but use it (`void fc;`) | OK |
| replace the raw emoji literals with `"\u{1F600}"` escapes | OK |
| raw emoji in a top-level `it` without the fc import | OK |
| Japanese describe/it names without the emoji | OK |
| same crashing file on vitest 5.0.5 | **SIGABRT** |
| escaped variant on vitest 5.0.5 | OK |

So the crash needs the combination of (a) an **unused** `fast-check` default import and (b) a **raw surrogate-pair literal** inside a `describe`-scoped test body. `run --manifest` works fine on the same project; only `discover` aborts.

Environment: Linux x86_64 (Arch, kernel 7.2.11), Node 22 / 26, vitest 4.1.12 and 5.0.5, fast-check 4.10.2, pkspec@0.4.2 binaries from the release tarball (sha256 verified).

Happy to provide the full project if useful — the repro is from a real suite where we worked around it by writing the emoji as `\u{1F600}` escapes.
