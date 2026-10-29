# issues 001〜008 の改善設計（根本対応）

status: draft / created: 2026-10-30 / 対象: issues/001〜008

8件の issue を個別の対症療法で潰すのではなく、横断して見ると根本原因は3つに束ねられる。
本設計はその3つの構造的な原因への対応と、残るノイズ低減の小修整を分けて定義する。

| 根本原因 | 対象 issue | 種別 |
|---|---|---|
| R1. 失敗が「握りつぶされる」設計 — 失敗を値に直す場所で構造化ログを出す規約がない | 001, 003, 004(前兆), 006(切り分け) | observability |
| R2. 境界が「弾く」設計 — 上限超過を bad_input で突き返し、呼び直しの往復を生む | 002 | ux |
| R3. RunDO の状態が単一キーの全量書き換え — 書き込み量が run の長さに比例して伸びる | 004 | bug |
| （小修整）ノイズ源の個別対応 | 005, 007, 008 | noise |

---

## R1. 観測の規約：失敗を値に直す場所では必ず1行の構造化ログを出す

### 原因の構造

このコードベースは「例外を値（HubError / isError）に直してモデルへ返す」方針が徹底している。
それ自体は正しいが、**値に直した時点で例外が観測から消える**。`guarded()`（sandbox.ts）だけが
`hub_error` を出しており、同じ変換をしている他の場所（mcp.ts の `code` ハンドラ、MCP トランスポートの
400、OAuthProvider）はログを出さない。issue 001 と 003 は同じ欠落の別の現れ。

### 対応

obs.ts を「遅いストレージ専用」から**観測の規約の置き場**に昇格させ、イベント語彙を一元化する。

```ts
// obs.ts に追加
export type ObsEvent =
  | { event: "code_error"; message: string; logs: number; client?: string }
  | { event: "bad_request"; path: string; status: number; reason: string }
  | { event: "hub_error"; message: string; runId?: string }           // 既存（sandbox.ts から移す）
  | { event: "bad_input"; what: string; issues: string; args?: string } // R2 と連動
  | { event: "slow_storage"; label: string; ms: number; bytes?: number };

export function obs(e: ObsEvent): void {
  console.log(JSON.stringify(e)); // message/args 系は呼び出し側で 300 字に切る
}
```

差し込み点:

1. **mcp.ts `code` ハンドラ**（issue 001）: `r.error` のとき `obs({ event: "code_error", message: slice300, logs: r.logs?.length ?? 0, client })`。
   Dynamic Worker 自体のイベントは観測に乗らないため、ここが code 失敗の唯一の観測点であることをコメントで明記する。
2. **handleMcp の応答ラップ**（issue 003）: `transport.handleRequest()` の戻りが 4xx のとき、
   応答ボディ（JSON-RPC error）を複製して reason を1行出す。トランスポート内部に手を入れず、
   ハブ側の1箇所で確実に捕まえる。OAuthProvider が返す 400（トークン不備）は defaultHandler 側に同じラップを置く。
   ```ts
   const res = await transport.handleRequest(request);
   if (res.status >= 400 && res.status < 500) {
     const body = await res.clone().text().catch(() => "");
     obs({ event: "bad_request", path: "/mcp", status: res.status, reason: body.slice(0, 300) });
   }
   ```
3. **timed() にサイズを添える**（issue 004 の前兆計測）: 下記 R3 参照。

### 運用（コード外）

- issue 006: `$workers.entrypoint` group-by で canceled alarm の DO を特定するクエリを
  docs/04（運用）に保存クエリとして追記。RunDO.alarm() は `finish → abortAll → save` のみで、
  save は put の上書きなので**再実行しても壊れない（冪等）**。TraceDO 側も transactionSync 内で
  完結しており冪等。特定の結果が RunDO/TraceDO なら issue 006 は priority: low に下げてよい。
- issue 005: コード変更なし。異常終了の見張りクエリから `GET /mcp × canceled` を除外した
  保存クエリを docs/04 に定義する（SSE の正常切断。wallTime 中央値37秒は長生き接続の切断と整合）。

---

## R2. 境界の方針転換：範囲超過は「弾く」のではなく「丸めて知らせる」

### 原因の構造

issue 002 の35件のうち31件（waitMs 13 + after 11 + before/after 5 + maxPassages 2）は
**値の範囲超過**であり、型の間違いではない。モデルは意図を正しく伝えており、ハブは安全に丸められる。
それを bad_input で突き返すから、code の書き直し→再実行の往復（トークンと待ち時間）が発生する。
`around` の before/after には既に clamp + `clamped` notice の前例があり（boundary.ts の
AroundOpts コメント、設計 v1.5 §8.3.7）、**この方針を境界全体に一般化していないこと**が根本原因。

### 対応方針（境界の規約として明文化）

> **数値の範囲超過・配列の件数超過は clamp して `{ kind: "clamped", field, max }` を notices に付けて続行する。
> bad_input で弾くのは「型・形が違っていて意図が読めない」ときだけ。**

boundary.ts の冒頭コメント（P-05 の節)にこの規約を追記し、スキーマを次のように変える。

| 入力 | 現状 | 変更後 |
|---|---|---|
| `waitMs`（Start/Steer/NextOpts） | `.max(60_000)` で reject | max を外し、呼び出し側で `Math.min(60_000, v)` + clamped notice |
| `maxPassages` | `.max(50)` で reject | 同上（max 50 に clamp） |
| `queries` / `urls` / `exclusions` | `.max(8/16)` で reject | 先頭 N 件に切って clamped notice |
| `find` の `limit` | max なし（DO 側任せ） | `POLICY.find.maxResults` に clamp + notice |
| `ClaimsInput` | `.max(50)` で reject | 先頭 50 件だけ照合し、残りは `Status { status: "未照合", reason: "budget" }` で返す（VERIFY_NEXT.budget が既にある） |
| `runId` / `passageId` / `find.source/text` の型違い | bad_input | **bad_input のまま**（意図が読めない） |

実装は parse の後に個別に clamp するのではなく、boundary.ts に小さなヘルパを置いて一元化する：

```ts
/** 範囲超過を丸め、clamped notices を集める。弾かない（設計 v1.5 §8.3.7 の一般化） */
export function clampNum(v: number | undefined, max: number, field: string, out: Notice[]): number | undefined;
export function clampList<T>(v: T[] | undefined, max: number, field: string, out: Notice[]): T[] | undefined;
```

### 併せて行うこと

1. **SANDBOX_TYPES に上限を明記**（sandbox-api）: `waitMs?: number  // ≤60000（超えると丸める）`、
   `maxPassages?: number  // 1..50`、`claims: …[]  // 50件まで/回` のように、モデルが読む型定義に
   上限をコメントで入れる。clamp に変えても、そもそも正しい値で呼ばれるのが最善。
2. **bad_input の実引数ログ**（R1 の `bad_input` イベント）: 型違い4件（runId に object 等）の
   切り分けのため、`parse()` 失敗時に `typeof` と値の先頭 120 字（文字列化、本文になり得る `question`
   `text` はキー名のみ）をログに残す。
3. 既に clamp 済みの `around` の11件の失敗は、観測期間が clamp 導入前のログを含むためと考えられる。
   再観測で0件になることを確認（反証条件: 残るなら Zod の `.int()` 違反など別経路を疑う）。

### 検証

- boundary のユニットテスト: 範囲超過 → clamp + notices、型違い → BadInput、の対を各入力に。
- 再観測（2週間）: `hub_error` のうち bad_input 系が 35 件/30日 → 1桁/30日 に落ちること。

---

## R3. RunDO のストレージ書き込みを run の長さに比例させない

### 原因の構造

issue 004 の `storage operation exceeded timeout` の有力候補は `save()`:

- `events` は**単一キーに全量 put**（run.ts:220、最大 500 件の配列）。run が進むほど
  1回の put が重くなる。meta も counters を含めて都度 put。
- `slow_storage`（しきい値 1,000ms）が 30 日で 0 件 = 前兆が計測できていない。
  リセットは数十秒級のストールで起きるので、1秒を跨がずに即死した可能性より、
  **そもそも計測に乗らない経路（transactionSync、alarm 内）か、しきい値が粗すぎる**可能性が高い。

### 対応（2段階）

**第1段: 測れるようにする（即時）**

- `timed()` に書き込みサイズを渡せるようにし、`run.save.events` には
  `bytes: JSON.stringify(events).length` を添える。しきい値を `SLOW_STORAGE_MS = 250` に下げる
  （遅い操作だけ出す方針は維持。平常時は 10ms 級なので出力は増えない見込み）。
- TraceDO の `transactionSync` は timed で包めない（同期）ので、`append()` 全体の所要と
  件数を 250ms 超のときだけ出す。
- 発生時刻（2026-10-23 頃）の run を TraceDO から特定し、events のサイズと操作を確認する
  （issue 004 の「次の一手」のまま）。

**第2段: 構造の修正（計測で save が律速と確認できたら）**

- `events` を単一キーから**チャンク分割**に変える: `ev:<n/50>` のように 50 件ごとのキーに分け、
  save は**末尾チャンクだけ** put する。load は `storage.list({ prefix: "ev:" })`。
  1回の書き込み量が run の長さに依存しなくなる（上限 50 件 ≒ 数 KB）。
- meta の put は内容が変わったときだけにする（counters の比較）。
- MAX_EVENTS(500) と各イベントの data サイズ上限（本文を入れない規約 C-04 の再確認）は維持。

計測を待たずに第2段へ進まない（cause_confirmed: false のまま実装に入らない。issues/README の規約）。

---

## 小修整（原因確認済みのノイズ）

- **issue 007**: `pdf.ts` の `getDocumentProxy(bytes)` に `standardFontDataUrl` を渡す。
  unpdf は `getDocumentProxy(bytes, options)` で pdf.js の DocumentInitParameters を受けるので、
  フォントデータを同梱するか（`unpdf` の `configureUnPDF`）、警告だけ消すなら
  `disableFontFace: true` 系の設定で足りるかを実装時に確認。残りの警告（壊れた PDF）は対処しない。
- **issue 008**: index.ts の `defaultHandler` に2行追加。
  - `GET /robots.txt` → `200 "User-agent: *\nDisallow: /\n"`（text/plain）
  - `GET /favicon.ico` → `204`

---

## 実施順序

| 順 | 内容 | issue | 理由 |
|---|---|---|---|
| 1 | R1 の obs 規約 + code_error / bad_request / bad_input ログ | 001, 003, 002(ログ) | 以降の全判断の土台。変更が小さい |
| 2 | R3 第1段（timed の bytes、しきい値 250ms、23日の run 特定） | 004 | データ消失系で優先度最高。まず測る |
| 3 | R2 の clamp 化 + SANDBOX_TYPES の上限明記 | 002 | 件数最多の UX 損失。設計前例があり低リスク |
| 4 | 小修整（robots/favicon、standardFontDataUrl） | 007, 008 | 404/warn の集計が綺麗になり、以降の観測の S/N が上がる |
| 5 | 運用クエリ（005 の除外、006 の entrypoint 特定） | 005, 006 | コード変更なし。docs/04 に保存クエリ |
| 6 | 再観測 1〜2 週間 → 003 の本体対処・R3 第2段を判断 | 003, 004 | cause_confirmed になってから実装 |

## 不変条件との整合

- ログに段落本文・質問文を載せない（C-04、E-01）: bad_input の実引数ログはキー名と typeof まで。
  message 系は 300 字で切る（既存の慣行を踏襲）。
- 境界で型に直し内部で確かめ直さない（P-05）: clamp も境界（boundary.ts / sandbox.ts の providers）
  だけで行い、RunDO 側の防御的 clamp は増やさない（around の既存 clamp は撤去候補だが、本設計では触れない）。
- モデルへの応答形式は不変: clamped は既存の `Notice { kind: "clamped" }` を使い、新しい形を増やさない。
