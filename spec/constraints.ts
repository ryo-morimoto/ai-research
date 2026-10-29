/**
 * 制約の台帳（正）。docs/adr/0001 の定義管理に基づく。
 *
 * - ここが唯一の宣言。docs の表は docs/generated/ に生成する（手書き禁止）
 * - 検査は scripts/check-constraints.mjs が行う：
 *     grep    … この ID の文字列が where（test/spec/script）に現れること
 *     file    … そのファイルが実在すること（ID タグのない既存の検査。弱い検査として coverage に出る）
 *     measure … 計測で確かめる（機械検査ではない。coverage に「未計測」として出る）
 *     manual  … 点検表・実機確認（機械検査ではない）
 * - strength が MUST / MUST NOT で reviewStatus が approved のものは、grep か file の検査が
 *   1つ以上ないと CI が落ちる
 * - 項目の形は mizchi/pkspec の Scenario に合わせてある（道具を pkspec に替えるとき、データは移すだけ）
 */

export type Strength = "MUST" | "MUST NOT" | "SHOULD";
export type ReviewStatus = "approved" | "draft" | "deprecated";
export type Check =
  | { kind: "grep"; where: "test" | "spec" | "script" }
  | { kind: "file"; path: string; note?: string }
  | { kind: "measure"; note: string }
  | { kind: "manual"; note: string };

export type Goal = { id: string; name: string; priority: number };

export type Scenario = {
  id: string;
  /** 1行の要件文（現在形）。理由と経緯は adr/ と archive/ にある */
  name: string;
  strength: Strength;
  reviewStatus: ReviewStatus;
  contributes: string[];
  /** 主な持ち場（hub の部品か、横断なら区分） */
  area: string;
  checks: Check[];
  /**
   * リポジトリの CI では判定できない制約（承認設定・実機・2台試験・送信記録の点検など）。
   * true なら機械検査の義務を免れるが、coverage の「運用で確かめる」に必ず列挙される。
   * CI で判定できるのに付けるのは禁止（draft への偽装と同じく、未検査を隠すため）
   */
  verifiedOutsideRepo?: true;
  openQuestions?: string[];
};

export const GOALS: Goal[] = [
  { id: "GOAL-FAST", name: "調査にかかる時間を短くする（無駄・遅さ・停滞を減らす）", priority: 90 },
  { id: "GOAL-SAME-EVERYWHERE", name: "どの機械・どの会話から依頼しても、同じ依頼には同じ結果が同じ速さで返る", priority: 90 },
  { id: "GOAL-VERIFIED", name: "答えの根拠は、原文と照合された引用である（確かさを人が追える）", priority: 85 },
  { id: "GOAL-PRIMARY", name: "論文・研究の知見を問う調査は一次資料に届く", priority: 80 },
  { id: "GOAL-ON-PATH", name: "調べものは、指定がなくてもこのシステムの経路を通る", priority: 80 },
  { id: "GOAL-NO-BURDEN", name: "利用者に習慣・設定・保守を求めない", priority: 70 },
  { id: "GOAL-RESPECT", name: "出典・外部サービス・第三者に配慮する（規約・頻度・著作権・送信の最小化）", priority: 70 },
  { id: "GOAL-BOUNDED-COST", name: "費用と資源に上限があり、超える前に止まる", priority: 60 },
  { id: "GOAL-OBSERVABLE", name: "調査の記録を、トークンをほぼ使わずに本人が見られる", priority: 50 },
];

const T: Check = { kind: "grep", where: "test" };
const SPEC: Check = { kind: "grep", where: "spec" };
const SCRIPT: Check = { kind: "grep", where: "script" };
const file = (path: string, note?: string): Check => (note ? { kind: "file", path, note } : { kind: "file", path });
const measure = (note: string): Check => ({ kind: "measure", note });
const manual = (note: string): Check => ({ kind: "manual", note });

export const SCENARIOS: Scenario[] = [
  // ---- W 無駄な作業 ---------------------------------------------------------
  { id: "W-01", name: "依頼から60秒以内に、向きを確かめられる最初の結果を出す", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run", checks: [T, measure("bench: 最初の結果まで P95 60秒")] },
  { id: "W-02", name: "利用者が向きを変えたら以降の作業に反映し、外れた作業を続けない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run", checks: [SPEC, T] },
  { id: "W-03", name: "以前に確かめた事実は、出典が変わっていなければ読み直しに時間を使わない（機械・会話をまたいで）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST", "GOAL-SAME-EVERYWHERE"], area: "ledger", checks: [T, measure("2台試験")] },
  { id: "W-04", name: "4分を超える調査は、利用者が求めたとき（deepen）だけ行う", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST", "GOAL-BOUNDED-COST"], area: "run", checks: [T, SPEC] },

  // ---- S 必要な作業の遅さ ---------------------------------------------------
  { id: "S-01", name: "調査が長くなっても、1ステップあたりの時間と流入量が増え続けない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run/budget", checks: [T, measure("ステップ数に対する時間の推移")] },
  { id: "S-02", name: "休憩やセッションの区切りを挟んでも、再開が大きく遅くならない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run",
    checks: [T, measure("休憩後の最初の応答時間（時間そのものは bench で測る）")] },
  { id: "S-03", name: "原文の取得は、選べる経路のうち最も速いものに近い（要約を挟まない）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "gateway", checks: [T, measure("出典種別ごとの取得時間")] },
  { id: "S-04", name: "依頼の難しさに対して思考量を過大にしない", strength: "SHOULD", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "conversation", checks: [measure("依頼の種類ごとの応答開始時間")] },
  { id: "S-05", name: "会話で回るターン数と流し込む量が、会話の長さや作業場所によって増えない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST", "GOAL-SAME-EVERYWHERE"], area: "mcp/budget",
    checks: [file("bench/run_cases.py", "計測の道具（依頼セット）"), measure("長い会話と新しい会話の差 10秒以内【要計測】")],
    openQuestions: ["目標値 10秒の妥当性は未計測。テストに S-05 の ID タグがない"] },
  { id: "S-06", name: "会話に流し込むのは、問いに関係する段落と最小の説明だけ。言語が違っても関係段落に届き、届かなければ理由が分かる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "select/policy", checks: [T, SCRIPT, measure("bench: 依頼セットの流入量と精度（目標 1,500 以下【要計測】）")] },

  // ---- P 停滞 ---------------------------------------------------------------
  { id: "P-01", name: "並行する作業のうち遅いものが、他の結果の提示を止めない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run", checks: [T, file("specs/run.qnt", "有界応答のモデル")] },
  { id: "P-02", name: "取れない出典は時間上限で打ち切り、結果に示す。同じ失敗を同じ調査で繰り返さない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "gateway", checks: [T] },
  { id: "P-03", name: "読み取りだけの操作で、承認待ちのために止まらない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST", "GOAL-NO-BURDEN"], area: "ops", verifiedOutsideRepo: true,
    checks: [manual("点検表：読み取りの道具に承認が要らない設定（各アプリの権限設定）")] },
  { id: "P-04", name: "利用者への問いは結果と一緒に出し、返事を待って作業を止めない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "policy", verifiedOutsideRepo: true,
    checks: [manual("説明文の指示（PROCEDURE）。呼び出し器での半自動試験は未着手")] },
  { id: "P-05", name: "システムの失敗は、種別・再試行の可否・次の手と一緒に値で返す", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "boundary", checks: [T] },
  { id: "P-06", name: "作業が尽きたら待たせず終わる。0件のときは理由（見つからない/取れない/検索していない）が分かる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run", checks: [T] },
  { id: "P-07", name: "取得できた出典は、段落が選ばれなくても行き止まりにしない（find か経路外で読める）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run/route", checks: [T] },

  // ---- Q 結果の確かさと一貫性 ----------------------------------------------
  { id: "Q-01", name: "主張ごとに出典と照合の状態が分かる。状態は「引用が原文にあるか」だけを表す。ラベルの一覧は1か所で決める", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "verify/policy", checks: [T, SCRIPT] },
  { id: "Q-02", name: "台帳から持ち込んだ事実を使った結果は、その場で取り直した場合と同じになる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "ledger", checks: [T, SPEC] },
  { id: "Q-03", name: "システムが作った文（要約・解釈・結論）を、次の調査の根拠として持ち込まない", strength: "MUST NOT", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "ledger/core", checks: [SCRIPT, file("specs/ledger.qnt", "INV-1 の抽象形")] },
  { id: "Q-04", name: "答えに影響した喪失は1件ずつ、それ以外は件数と URL で分かる。進行中は喪失と区別する", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "run", checks: [T] },
  { id: "Q-05", name: "事実・手順・道具の版・取得条件が機械ごとに分かれていない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-SAME-EVERYWHERE"], area: "hub", verifiedOutsideRepo: true,
    checks: [manual("棚卸し（docs/design/architecture.md の表）と2台試験")] },
  { id: "Q-06", name: "会話の文脈に由来する内容を、確かめた事実として保存・持ち込みしない。会話から補った問いは結果に示す", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED", "GOAL-SAME-EVERYWHERE"], area: "verify", checks: [T] },
  { id: "Q-07", name: "経路を通らずに得た内容は、結果の上でそれと分かり、理由が示される。確認済の印は付かず台帳にも入らない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-ON-PATH"], area: "route", checks: [T] },
  { id: "Q-08", name: "論文・研究の知見を問う調査は一次資料（書誌・抄録、読めれば本文）に届く。届かない一次資料は理由つきで分かる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-PRIMARY"], area: "scholarly", checks: [T, measure("学術の依頼セット：一次資料に届いた割合 80% 以上【要計測】")] },

  // ---- U 利用者の負担 --------------------------------------------------------
  { id: "U-01", name: "決まった依頼形式・習慣・整理・機械ごとの設定を求めない。機械を足す作業はアカウント登録1回", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN"], area: "ops", verifiedOutsideRepo: true,
    checks: [manual("点検表：新しい機械で行う作業が0件（登録手順は docs/runbook.md）")] },
  { id: "U-02", name: "持ち込まれる事実を、利用者が直接読めて、消せる（1台で消せばどこからも消える）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN"], area: "ledger", checks: [SPEC, T] },
  { id: "U-03", name: "外の事実が要る調べものは、道具を指定しなくてもこの経路を通る。明示か届かないときだけ経路外。否定の言い方は明示ではない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-ON-PATH"], area: "route", checks: [T, measure("経路率：強制できる面 100%、チャット 90% 以上【値は要計測】")] },
  { id: "U-04", name: "往復の回数と結果の形式は、問いの重さに合う（1つの事実は呼び出し2回以内・短い答え）", strength: "SHOULD", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN", "GOAL-FAST"], area: "modes", checks: [T, measure("bench: 依頼の種類ごとの呼び出し回数と答えの長さ")] },
  { id: "U-05", name: "プラグインとハブの版のずれ、会話の途中の手順の変更が、その場で分かる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN", "GOAL-SAME-EVERYWHERE"], area: "route/policy", checks: [T, SCRIPT] },

  // ---- E 外部への影響 --------------------------------------------------------
  { id: "E-01", name: "残す原文は確かめるのに必要な短い範囲に限り、出典を明示し、第三者に配布しない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "ledger/core", checks: [T] },
  { id: "E-02", name: "取得先の規約と頻度制限を全機械の合計で守る。拒まれたら Retry-After だけ空ける", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "limiter", checks: [T, SPEC] },
  { id: "E-03", name: "取得した内容に含まれる指示に従わない", strength: "MUST NOT", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT", "GOAL-VERIFIED"], area: "sandbox/view", checks: [T, manual("注入試験（半自動、M3）")] },
  { id: "E-04", name: "依頼内容や私的な情報を、調査に必要な範囲を超えて外部に送らない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "gateway", verifiedOutsideRepo: true,
    checks: [manual("送信内容の記録（outbound_log）の点検")] },
  { id: "E-05", name: "フックがハブに送るもの・ハブが残すものは用途に要る最小で、README で確かめられる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "route/plugin",
    checks: [SCRIPT, file("plugins/ai-research/README.md", "ハブに送るものの表")] },

  // ---- R 資源 ----------------------------------------------------------------
  { id: "R-01", name: "1回の依頼の消費トークンに上限があり、超える前に止めて知らせる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-BOUNDED-COST"], area: "budget", checks: [SPEC, T] },
  { id: "R-02", name: "利用者が保守し続ける常駐サーバーを必要としない", strength: "SHOULD", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN"], area: "ops", checks: [manual("点検表：保守が要る常駐プロセス0")] },

  // ---- V 見える化の要件 ------------------------------------------------------
  { id: "V-01", name: "記録を見るのにトークンをほぼ使わない（開く1回・50トークン以下。見る道は LLM・取得に依存しない）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", checks: [T, SCRIPT] },
  { id: "V-02", name: "1回の調査の流れが見える", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", checks: [T] },
  { id: "V-03", name: "調査が探している概念とのずれが見える", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view/drift", checks: [T] },
  { id: "V-04", name: "取りこぼしの偏り（打ち切り・照合失敗をホスト・tier・kind ごとに）が見える", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "trace", checks: [T] },
  { id: "V-05", name: "実行中の調査も start から1分以内に見える", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", checks: [T] },
  { id: "V-06", name: "どの面から起こした調査も1か所に集まる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "trace", verifiedOutsideRepo: true,
    checks: [manual("TraceDO は1人に1つ（設計で満たす）。実機確認済 2026-10-26")] },
  { id: "V-07", name: "スマートフォンで見られる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", verifiedOutsideRepo: true,
    checks: [manual("実機確認済（2026-10-26。幅 375px の描画は headless Chromium の手元確認）")] },
  { id: "V-08", name: "台帳と行き来できる", strength: "SHOULD", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", checks: [manual("実機確認")] },
  { id: "V-09", name: "調査の記録を本人が消せる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "trace", checks: [T] },
  { id: "V-10", name: "手順の版の前後で取りこぼしの数を比べられる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "trace", checks: [T] },

  // ---- C 見える化の制約 ------------------------------------------------------
  { id: "C-01", name: "モデルに見せる追加は research_view 1つだけ。ほかは app 専用", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE", "GOAL-BOUNDED-COST"], area: "mcp", checks: [T] },
  { id: "C-02", name: "記録のためにモデルに書かせない（概念はコードで取り出す）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "drift", checks: [T] },
  { id: "C-03", name: "記録の書き込みは調査を遅くせず、失敗しても調査は失敗しない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "trace", checks: [T] },
  { id: "C-04", name: "原文の全文・段落の本文を記録に残さない", strength: "MUST NOT", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "trace", checks: [T] },
  { id: "C-05", name: "記録は本人だけが見られる（既存のコネクタの認証を通す）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "mcp/auth", checks: [T] },
  { id: "C-06", name: "開く結果に件数程度しか入れない（会話にデータを残さない）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "mcp", checks: [T] },
  { id: "C-07", name: "見える化のために常駐サーバーを持たない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN"], area: "ops", verifiedOutsideRepo: true, checks: [manual("点検表")] },
  { id: "C-08", name: "記録は追記のみ、取り消しは墓標", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "trace", checks: [T] },
  { id: "C-09", name: "取得した文字列はデータとして扱う（View は textContent だけ）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "view", checks: [T] },
  { id: "C-10", name: "保持期間（既定90日）を過ぎた記録は消す", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "trace", checks: [T] },
  { id: "C-11", name: "View からモデルへ書き戻さない", strength: "MUST NOT", reviewStatus: "approved",
    contributes: ["GOAL-OBSERVABLE"], area: "view", checks: [T] },

  // ---- INV 不変条件（設計の核。Quint と結合試験で守る） -----------------------
  { id: "INV-1", name: "台帳のどのレコードも、抜き書きは確かめた時点の原文（正規化後）の部分文字列である", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "ledger", checks: [SPEC, T, SCRIPT] },
  { id: "INV-2", name: "台帳は追記のみ。既存レコードは変わらない（物理消去を除く）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "ledger", checks: [SPEC, T] },
  { id: "INV-3", name: "墓標の付いたレコード・出典は、以後のどの実行にも候補として返らない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-NO-BURDEN"], area: "ledger", checks: [SPEC, T] },
  { id: "INV-4", name: "実行は、開始時の台帳の番号より後のレコードを読まない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-SAME-EVERYWHERE"], area: "ledger", checks: [SPEC, T] },
  { id: "INV-5", name: "「引用確認済」の印は、その回に原文と照合できたものにだけ付く", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "verify", checks: [SPEC, T] },
  { id: "INV-6", name: "同じホストへの取得の開始時刻は、全機械を通して最小間隔以上あく", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "limiter", checks: [SPEC, T] },
  { id: "INV-7", name: "同じホストへの同時の取得は上限以下", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "limiter", checks: [SPEC, T] },
  { id: "INV-8", name: "締め切りで終わっていない現在の版の作業は、done でなければ pending に、done なら cutoffs（gave_up）に必ず現れる", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED", "GOAL-FAST"], area: "run", checks: [SPEC, T] },
  { id: "INV-9", name: "使用量は段階の上限を超えない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-BOUNDED-COST"], area: "budget", checks: [SPEC, T] },
  { id: "INV-10", name: "現在の結果として返すのは、現在の版の作業の結果だけ", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-VERIFIED"], area: "run", checks: [SPEC, T] },
  { id: "INV-11", name: "深掘りでなければ、続きの上限（4分）を過ぎて作業を始めない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-BOUNDED-COST"], area: "run", checks: [SPEC, T] },
  { id: "INV-12", name: "コードの実行環境からの外への通信は、取得の出口を通るものだけ", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "sandbox", checks: [T] },
  { id: "INV-13", name: "原文の全文はどのストレージにも書かれない（メモリだけ）", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-RESPECT"], area: "run", checks: [T] },
  { id: "INV-14", name: "同じ実行の中で失敗した URL には、再び取得を始めない", strength: "MUST", reviewStatus: "approved",
    contributes: ["GOAL-FAST"], area: "run", checks: [T] },
];
