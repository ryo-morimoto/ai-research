#!/usr/bin/env python3
"""
依頼セットを Claude Code（claude -p）で実行し、会話の側が払った量を数える（docs/02 §7.7、制約 S-06・U-04）。

使い方：
  python3 -I bench/run_cases.py bench/cases/feedback-2026-10-24.json \
      --mcp-config <ai-research の MCP 設定（Bearer トークン入り）> --plugin-dir plugins/ai-research [--label before]

数えるもの（ケースごと）：
  calls       道具の呼び出し回数（ToolSearch・Skill・code など全部）
  research    ai-research の道具の呼び出し回数
  in_tokens   ai-research の道具の結果として会話に入った量（推定トークン。CJK 1字=1、その他 3字=1。core の estimateTokens と同じ係数）
  passages    結果に現れた段落 ID の数（p… と h…）
  cited       verify に渡した段落 ID の数
  precision   cited / passages（会話に入れた段落のうち、根拠に使われた割合）
  answer      最終回答の推定トークン
  off_path    最終回答に「経路外」があるか
  error       ai-research の道具がエラーを返したか
結果は bench/results/<日時>-<label>/ に保存する（.gitignore 済み）。
"""
import argparse, concurrent.futures as cf, json, os, re, subprocess, sys, time

CJK = re.compile(r"[　-鿿가-힯＀-￯]")

def est_tokens(s: str) -> int:
    cjk = len(CJK.findall(s))
    return cjk + (len(s) - cjk + 2) // 3

def run_case(case, args, outdir):
    path = os.path.join(outdir, f"{case['id']}.jsonl")
    cmd = ["claude", "-p", case["prompt"], "--output-format", "stream-json", "--verbose", "--max-turns", "16",
           "--allowedTools", "WebSearch", "WebFetch", "ToolSearch", "Skill", "mcp__ai-research__code"]
    if args.plugin_dir: cmd += ["--plugin-dir", args.plugin_dir]
    if args.mcp_config: cmd += ["--mcp-config", args.mcp_config]
    t0 = time.time()
    with open(path, "w") as f:
        subprocess.run(cmd, stdout=f, stderr=subprocess.DEVNULL, timeout=600, cwd=args.cwd)
    return analyze(path, case, time.time() - t0)

def analyze(path, case, secs):
    calls = research = 0; in_tok = 0; ids = set(); cited = set(); final = ""; error = False; names = []
    pending = {}
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "assistant":
            for c in e["message"].get("content", []):
                if c.get("type") == "tool_use":
                    calls += 1; names.append(c["name"])
                    pending[c["id"]] = c["name"]
                    if "ai-research" in c["name"]:
                        research += 1
                        code = json.dumps(c.get("input"), ensure_ascii=False)
                        if "verify" in code:
                            cited |= set(re.findall(r'passageId\\?"?\s*:\s*\\?"([ph]\d+)', code))
        if e.get("type") == "user" and isinstance(e["message"].get("content"), list):
            for c in e["message"]["content"]:
                if c.get("type") != "tool_result": continue
                name = pending.get(c.get("tool_use_id"), "")
                t = c.get("content"); t = t if isinstance(t, str) else json.dumps(t, ensure_ascii=False)
                if "ai-research" in name:
                    in_tok += est_tokens(t)
                    ids |= set(re.findall(r'"passageId\\?"?\s*:\s*\\?"([ph]\d+)', t))
                    if c.get("is_error") or '"error"' in t[:200]: error = True
        if e.get("type") == "result": final = e.get("result") or ""
    return {
        "id": case["id"], "secs": round(secs), "calls": calls, "research": research, "in_tokens": in_tok,
        "passages": len(ids), "cited": len(cited & ids) if ids else len(cited),
        "precision": round(len(cited & ids) / len(ids), 2) if ids else None,
        "answer": est_tokens(final), "off_path": "経路外" in final, "error": error, "tools": names,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cases"); ap.add_argument("--mcp-config"); ap.add_argument("--plugin-dir")
    ap.add_argument("--label", default="run"); ap.add_argument("--cwd", default="/tmp")
    ap.add_argument("--parallel", type=int, default=3)
    args = ap.parse_args()
    if args.plugin_dir: args.plugin_dir = os.path.abspath(args.plugin_dir)
    if args.mcp_config: args.mcp_config = os.path.abspath(args.mcp_config)
    cases = json.load(open(args.cases))["cases"]
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", time.strftime("%Y%m%d-%H%M%S") + "-" + args.label)
    os.makedirs(outdir, exist_ok=True)
    with cf.ThreadPoolExecutor(args.parallel) as ex:
        rows = list(ex.map(lambda c: run_case(c, args, outdir), cases))
    json.dump(rows, open(os.path.join(outdir, "summary.json"), "w"), ensure_ascii=False, indent=1)
    cols = ["id", "secs", "calls", "research", "in_tokens", "passages", "cited", "precision", "answer", "off_path", "error"]
    print(" | ".join(cols))
    for r in rows: print(" | ".join(str(r[c]) for c in cols))
    tot = {c: sum(r[c] for r in rows) for c in ["calls", "research", "in_tokens", "answer"]}
    print("total", tot, "->", outdir)

if __name__ == "__main__":
    main()
