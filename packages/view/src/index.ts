/**
 * 会話の中の View（docs/05 §3、案 C）。1枚の HTML で、外部を読まない（claude-ai-mcp#40：CSP の指定が無視される）。
 *
 * - MCP Apps の View の側の通信を手で書く（ui/initialize → ui/notifications/initialized、tools/call、size-changed）。
 *   公式の App クラスは依存込みで約 400KB あり、1画面には重いので使わない
 * - データは持たない。表示されたあと app 専用ツール（trace_read）で読む（C-06）
 * - モデルへ書き戻さない。ui/update-model-context と ui/message は送らない（C-11。test/view.test.ts で検査）
 * - 取得した文字列は textContent で入れる。HTML として解釈しない（C-09）
 * - JSON-RPC でないメッセージは捨てる（claude-ai-mcp#47）
 *
 * このパッケージは他のパッケージに依存しない（scripts/check-deps.mjs の規則 5）。値は hub が viewHtml に渡す
 */

export type ViewConfig = {
  /** 読むツールの名前（POLICY.view.readTool） */
  readTool: string;
  /** 実行中の調査がある間だけ読み直す間隔（POLICY.view.pollMs） */
  pollMs: number;
  /** MCP Apps の版 */
  protocolVersion: string;
  /** View の名前と版（ui/initialize の appInfo） */
  appVersion: string;
};

export const PROTOCOL_VERSION = "2026-01-26";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #ffffff);
  --bg2: var(--color-background-secondary, #f5f5f4);
  --fg: var(--color-text-primary, #1c1917);
  --fg2: var(--color-text-secondary, #57534e);
  --fg3: var(--color-text-tertiary, #78716c);
  --line: var(--color-border-secondary, #e7e5e4);
  --accent: var(--color-text-info, #2563eb);
  --warn: var(--color-text-warning, #b45309);
  --bad: var(--color-text-danger, #b91c1c);
  --good: var(--color-text-success, #15803d);
  --radius: var(--border-radius-md, 8px);
  --font: var(--font-sans, system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #1c1917);
  --bg2: var(--color-background-secondary, #292524);
  --fg: var(--color-text-primary, #fafaf9);
  --fg2: var(--color-text-secondary, #d6d3d1);
  --fg3: var(--color-text-tertiary, #a8a29e);
  --line: var(--color-border-secondary, #44403c);
  --accent: var(--color-text-info, #60a5fa);
  --warn: var(--color-text-warning, #fbbf24);
  --bad: var(--color-text-danger, #f87171);
  --good: var(--color-text-success, #4ade80);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 14px; line-height: 1.5; }
#app { padding: 12px 16px 16px; max-width: 760px; }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
h2 { font-size: 12px; font-weight: 600; color: var(--fg2); margin: 16px 0 6px; letter-spacing: .02em; }
.sub { color: var(--fg3); font-size: 12px; }
.counts { display: flex; gap: 16px; margin: 8px 0 4px; flex-wrap: wrap; }
.count b { font-size: 18px; font-weight: 600; margin-right: 4px; font-variant-numeric: tabular-nums; }
.count span { color: var(--fg2); font-size: 12px; }
ul { list-style: none; margin: 0; padding: 0; }
.run { display: block; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line); padding: 8px 0; color: inherit; font: inherit; cursor: pointer; }
.run:hover .q { color: var(--accent); }
.q { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.meta { color: var(--fg3); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; margin-top: 2px; font-variant-numeric: tabular-nums; }
.live { color: var(--accent); font-weight: 600; }
.back { background: none; border: 0; color: var(--accent); font: inherit; font-size: 13px; padding: 0; margin: 0 0 8px; cursor: pointer; }
.ver { margin: 14px 0 4px; padding: 6px 10px; background: var(--bg2); border-radius: var(--radius); font-size: 13px; overflow-wrap: anywhere; }
.ver b { font-weight: 600; margin-right: 6px; }
.ev { display: grid; grid-template-columns: 52px 64px 1fr; gap: 8px; padding: 5px 0; border-top: 1px solid var(--line); font-size: 13px; align-items: baseline; }
.t { color: var(--fg3); font-family: var(--mono); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.k { font-size: 11px; font-weight: 600; color: var(--fg2); }
.k.cut { color: var(--warn); }
.k.bad { color: var(--bad); }
.k.ok { color: var(--good); }
.d { overflow-wrap: anywhere; min-width: 0; }
.d .x { color: var(--fg3); font-size: 12px; margin-left: 6px; }
.empty, .err { color: var(--fg2); padding: 12px 0; }
.err { color: var(--bad); }
.retry { margin-left: 8px; background: none; border: 1px solid var(--line); border-radius: var(--radius); color: var(--fg); font: inherit; font-size: 12px; padding: 2px 8px; cursor: pointer; }
@media (max-width: 420px) {
  #app { padding: 10px 12px 12px; }
  .ev { grid-template-columns: 44px 56px 1fr; gap: 6px; }
}
`;

/**
 * View の処理。テンプレートリテラル（バッククォートとドル記号の波かっこ）を使わない（この文字列自体がテンプレートなので）。
 * 設定は <script id="cfg" type="application/json"> から読む
 */
const SCRIPT = `
(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var host = window.parent;
  var root = document.getElementById("app");
  var nextId = 1;
  var pending = {};
  var ctx = {};
  var screen = { name: "today", runId: null, gen: 0 };
  var pollTimer = null;
  var rendered = false;

  function send(msg) { host.postMessage(msg, "*"); }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== host) return;
    var m = ev.data;
    // JSON-RPC でないもの（claude-ai-mcp#47）は捨てる
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && m.method === undefined) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params); reportSize(); return; }
    if (m.method === "ui/notifications/tool-result") { onOpenResult(m.params); return; }
    if (m.id !== undefined) {
      if (m.method === "ping" || m.method === "ui/resource-teardown") send({ jsonrpc: "2.0", id: m.id, result: {} });
      else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  function applyContext(c) {
    if (!c || typeof c !== "object") return;
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) ctx[k] = c[k];
    var de = document.documentElement;
    if (ctx.theme === "dark" || ctx.theme === "light") de.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") {
      for (var name in vars) {
        if (name.indexOf("--") === 0 && typeof vars[name] === "string") de.style.setProperty(name, vars[name]);
      }
    }
  }

  var lastHeight = -1;
  function reportSize() {
    var h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    if (h && h !== lastHeight) { lastHeight = h; notify("ui/notifications/size-changed", { height: h }); }
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.documentElement);

  // ---- 描画（文字は textContent だけで入れる。C-09） ----
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear() { rendered = true; while (root.firstChild) root.removeChild(root.firstChild); }
  function hm(ms) {
    try { return new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone || undefined }); }
    catch (e) { return new Date(ms).toISOString().slice(11, 16); }
  }
  function secs(ms) { return "+" + (Math.max(0, ms) / 1000).toFixed(1) + "s"; }
  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

  function failBox(e, retry) {
    var box = el("div", "err", "読み込めませんでした：" + describe(e));
    if (retry) {
      var b = el("button", "retry", "もう一度");
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
    return box;
  }
  function describe(e) {
    if (!e) return "不明";
    if (typeof e === "string") return e;
    return String(e.message || e.code || "不明");
  }

  function read(args) {
    return request("tools/call", { name: cfg.readTool, arguments: args }).then(function (r) {
      if (!r) throw { message: "空の応答" };
      if (r.isError) {
        var t = r.content && r.content[0] && r.content[0].text;
        throw { code: "tool_error", message: t || "ツールの失敗" };
      }
      return r.structuredContent || {};
    });
  }

  function schedule(fn) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(fn, cfg.pollMs);
  }

  function runMeta(r) {
    var meta = el("div", "meta");
    if (!r.done) meta.appendChild(el("span", "live", "実行中"));
    meta.appendChild(el("span", "", hm(r.startedAt)));
    meta.appendChild(el("span", "", r.mode + (r.version > 1 ? "・版" + r.version : "")));
    meta.appendChild(el("span", "", "出典 " + r.sources));
    meta.appendChild(el("span", "", "段落 " + r.passages));
    if (r.cutoffs) meta.appendChild(el("span", "", "打ち切り " + r.cutoffs));
    if (r.verified || r.failedClaims) meta.appendChild(el("span", "", "照合 " + r.verified + "/" + (r.verified + r.failedClaims)));
    return meta;
  }

  function runList(title, runs) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("h2", "", title));
    if (!runs.length) { frag.appendChild(el("div", "empty", "ありません")); return frag; }
    var ul = el("ul");
    runs.forEach(function (r) {
      var li = el("li");
      var b = el("button", "run");
      b.setAttribute("data-run", r.runId);
      b.appendChild(el("div", "q", r.question || "（問いなし）"));
      b.appendChild(runMeta(r));
      b.addEventListener("click", function () { showRun(r.runId); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    frag.appendChild(ul);
    return frag;
  }

  // ---- 今日 ----
  function showToday() {
    var gen = ++screen.gen;
    screen.name = "today";
    screen.runId = null;
    read({ view: "today" }).then(function (d) {
      if (gen !== screen.gen) return;
      clear();
      root.appendChild(el("h1", "", "今日の調査"));
      root.appendChild(el("div", "sub", d.date || ""));
      var counts = el("div", "counts");
      var c1 = el("div", "count"); c1.appendChild(el("b", "", d.started || 0)); c1.appendChild(el("span", "", "件始まった")); counts.appendChild(c1);
      var c2 = el("div", "count"); c2.appendChild(el("b", "", (d.running || []).length)); c2.appendChild(el("span", "", "件実行中")); counts.appendChild(c2);
      root.appendChild(counts);
      var running = d.running || [];
      var live = {};
      running.forEach(function (r) { live[r.runId] = true; });
      if (running.length) root.appendChild(runList("実行中", running));
      // 実行中のものは上に出しているので、最近の一覧には重ねて出さない
      root.appendChild(runList("最近の調査", (d.recent || []).filter(function (r) { return !live[r.runId]; })));
      reportSize();
      if ((d.running || []).length) schedule(function () { if (gen === screen.gen) showToday(); });
    }).catch(function (e) {
      if (gen !== screen.gen) return;
      clear();
      root.appendChild(failBox(e, showToday));
      reportSize();
    });
  }

  // ---- 調査の流れ ----
  var KIND = {
    "run.started": ["始め", ""],
    "run.steered": ["向き", ""],
    "run.deepened": ["深掘り", ""],
    "run.done": ["終わり", "ok"],
    "search.sent": ["検索", ""],
    "source.fetched": ["取得", ""],
    "passage.selected": ["段落", ""],
    "ledger.hit": ["台帳", ""],
    "verify.done": ["照合", ""],
    "cutoff": ["打ち切り", "cut"]
  };

  function detail(e) {
    var d = el("div", "d");
    function main(t) { d.appendChild(document.createTextNode(String(t))); }
    function extra(t) { d.appendChild(el("span", "x", t)); }
    switch (e.type) {
      case "run.started":
        main((e.queries || []).join("、") || "（検索語なし）");
        extra(e.mode + ((e.sources || []).length ? "・" + e.sources.join("+") : ""));
        if ((e.urls || []).length) extra("URL " + e.urls.length);
        break;
      case "run.steered":
        main((e.queries || []).join("、") || "（検索語なし）");
        break;
      case "search.sent":
        main(e.query);
        extra(e.provider + "・" + (e.ok === false ? "失敗" : (e.hits || 0) + "件"));
        break;
      case "source.fetched":
        main(e.title || e.host || hostOf(e.url));
        extra((e.host || hostOf(e.url)) + "・" + (e.tier || "") + (e.ms !== undefined ? "・" + e.ms + "ms" : "") + (e.reused ? "・使い回し" : ""));
        break;
      case "passage.selected":
        main(e.context || e.passageId);
        extra(e.sourceId + "・" + (e.chars || 0) + "字" + (e.via && e.via !== "bundle" ? "・" + e.via : ""));
        break;
      case "ledger.hit":
        main(e.status);
        extra(hostOf(e.url || "") + "・" + e.recordId);
        break;
      case "verify.done":
        var cl = e.claims || [];
        var ok = cl.filter(function (c) { return c.status.indexOf("引用確認済") === 0; }).length;
        main("確認済 " + ok + " / " + cl.length);
        var reasons = cl.filter(function (c) { return c.reason; }).map(function (c) { return c.reason; });
        if (reasons.length) extra(reasons.join("、"));
        break;
      case "cutoff":
        main(e.why + "・" + (e.host || e.what));
        if (e.detail) extra(e.detail);
        break;
      case "run.done":
        main(e.why);
        extra("出典 " + (e.fetched || 0) + "・失敗 " + (e.failed || 0) + "・" + ((e.elapsedMs || 0) / 1000).toFixed(1) + "s");
        break;
      default:
        main(e.type);
    }
    return d;
  }

  function showRun(runId) {
    var gen = ++screen.gen;
    screen.name = "run";
    screen.runId = runId;
    read({ view: "run", id: runId }).then(function (d) {
      if (gen !== screen.gen) return;
      clear();
      var back = el("button", "back", "← 今日の調査");
      back.addEventListener("click", showToday);
      root.appendChild(back);
      var s = d.summary;
      var events = d.events || [];
      if (!s) { root.appendChild(el("div", "empty", "この調査の記録はありません")); reportSize(); return; }
      root.appendChild(el("h1", "", s.question || "（問いなし）"));
      root.appendChild(runMeta(s));
      var t0 = s.startedAt;
      var v = 0;
      events.forEach(function (e) {
        if (e.type === "run.started" || e.type === "run.steered") {
          v = e.v;
          var ver = el("div", "ver");
          ver.appendChild(el("b", "", "問いの版 " + e.v));
          ver.appendChild(document.createTextNode(String(e.question || "")));
          root.appendChild(ver);
        }
        var k = KIND[e.type] || [e.type, ""];
        var row = el("div", "ev");
        row.setAttribute("data-type", e.type);
        row.appendChild(el("div", "t", secs(e.at - t0)));
        var cls = k[1];
        if (e.type === "search.sent" && e.ok === false) cls = "bad";
        if (e.type === "verify.done" && (e.claims || []).some(function (c) { return c.status.indexOf("引用確認済") !== 0; })) cls = "bad";
        row.appendChild(el("div", "k" + (cls ? " " + cls : ""), k[0]));
        row.appendChild(detail(e));
        root.appendChild(row);
      });
      if (!events.length) root.appendChild(el("div", "empty", "まだ記録が届いていません"));
      reportSize();
      if (!s.done) schedule(function () { if (gen === screen.gen) showRun(runId); });
    }).catch(function (e) {
      if (gen !== screen.gen) return;
      clear();
      root.appendChild(failBox(e, function () { showRun(runId); }));
      reportSize();
    });
  }

  // 開いたツールの結果（件数だけ。C-06）。今日の画面を読むまでの間に出す
  function onOpenResult(params) {
    var sc = params && params.structuredContent;
    if (!sc || rendered) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(el("h1", "", "今日の調査"));
    root.appendChild(el("div", "sub", "今日 " + (sc.started || 0) + " 件・実行中 " + (sc.running || 0) + " 件。読み込み中"));
    reportSize();
  }

  request("ui/initialize", {
    appInfo: { name: "ai-research-view", version: cfg.appVersion },
    appCapabilities: {},
    protocolVersion: cfg.protocolVersion
  }).then(function (r) {
    applyContext(r && r.hostContext);
    notify("ui/notifications/initialized", {});
    showToday();
  }).catch(function (e) {
    clear();
    root.appendChild(failBox(e, null));
    reportSize();
  });
})();
`;

/** View の HTML（ui://ai-research/view の中身） */
export function viewHtml(cfg: ViewConfig): string {
  // 設定は JSON として埋める。< を逃がして </script> で切れないようにする
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-research の調査の記録</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><div class="sub">読み込み中</div></main>
<script id="cfg" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** 試験用：View の処理の文字列 */
export const VIEW_SCRIPT = SCRIPT;
