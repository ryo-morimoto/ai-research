# GitHub Actions の定義

ここにある2つは `.github/workflows/` に置くと動く。この開発で使っている GitHub App には workflow を書く権限がないので、ここに置いてある。

```sh
mkdir -p .github/workflows && git mv ci/ci.yml ci/nightly.yml .github/workflows/
```

| ファイル | いつ | 何を |
|---|---|---|
| `ci.yml` | push（main）と pull request | `pnpm check`、`pnpm spec:check`（シミュレーション）、`cf build` と `cf deploy --prebuilt --dry-run` |
| `nightly.yml` | 毎晩 03:17 JST と手動 | 性質ベーステストを 2万回、hub の結合試験、Apalache を加えた仕様の検査 |
