# 上流（mizchi/pkspec）への報告の下書き（issues/009）

投稿は利用者が行う（GitHub の名義での対外投稿のため）。そのまま貼れる形：

---

**Title:** `pkspec-adapter-vitest discover` aborts (SIGABRT) on test files containing raw surrogate-pair (emoji) literals — content/offset sensitive

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

| change | vitest 4.1.12 | vitest 5.0.5 |
| --- | --- | --- |
| as above | **SIGABRT** (deterministic) | **SIGABRT** |
| replace the fc import with a **same-byte-length comment** | (not tested) | **SIGABRT** |
| remove that line entirely | OK | **SIGABRT** |
| add a short `//x` comment line before the emoji | (not tested) | **SIGABRT** |
| keep the import but use it (`void fc;`) | OK | (not tested) |
| replace the raw emoji literals with `"\u{1F600}"` escapes | OK | OK |
| raw emoji in a top-level `it`, minimal file | OK | (not tested) |
| Japanese describe/it names without the emoji | OK | (not tested) |

So `fast-check` itself is irrelevant (a same-length comment reproduces it). The one necessary ingredient is a **raw surrogate-pair literal** in the file; whether it crashes flips with small changes to the surrounding content and with the vitest version, which suggests the abort depends on the **byte/char offset of the surrogate pair** in some intermediate the shim processes (string slicing at a surrogate boundary?). Escaping the literal always avoids it. `run --manifest` works fine on the same project; only `discover` aborts.

Environment: Linux x86_64 (Arch, kernel 7.2.11), Node 22 / 26, vitest 4.1.12 and 5.0.5, fast-check 4.10.2, pkspec@0.4.2 binaries from the release tarball (sha256 verified).

Happy to provide the full project if useful — the repro is from a real suite where we worked around it by writing the emoji as `\u{1F600}` escapes.
