# 上流（mizchi/pkspec）への報告の下書き（issues/009。投稿は利用者が行う）

---

**Title:** `pkspec-adapter-vitest discover` SIGABRTs when a scanned test file contains a non-BMP (surrogate-pair) character

**Body:**

Repro (pkspec@0.4.2 linux-amd64 release tarball; no vitest or node_modules needed):

```sh
mkdir -p test && printf '// 😀\n' > test/a.test.ts
pkspec-adapter-vitest discover   # => SIGABRT (exit 134, no output)
```

Without the emoji the same layout succeeds. `run --manifest` is unaffected.

Where it happens: `discover` scans files itself (`src/adaptershim/discover.mbt`, `parse_js_test_file`) and applies `js_test_re` per line. Any line containing a surrogate pair that the regexp engine has to traverse aborts — a line where `it("name")` matches *before* the emoji passes (early return), while a non-matching line or an emoji inside the name capture crashes. So it looks like the regexp engine mis-steps at a surrogate boundary (char vs UTF-16 code-unit indexing).

Observed on Linux x86_64. Workaround we use: write non-BMP characters in test sources as `\u{...}` escapes.
