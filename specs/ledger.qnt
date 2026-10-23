// 台帳と照らし直し（docs/03 §2.4.1、§2.6.2、§3.1）
//
// 文字列は扱わず、「出典の版 × 抜き書き ID」で抽象化する。
// 出典はいつでも変わりうる（版が上がる）。どの版にどの抜き書きが含まれるかは CONTENT で決める。
// 照合の中身（正規化や部分文字列）は core の性質ベーステストで別に確かめる。
//
// 不変条件：
//   INV-1 台帳のどのレコードも、抜き書きは記録した時点の出典の版に含まれる
//   INV-3 墓標が付いたものは、それ以降に始まった実行の候補に現れない
//   INV-4 実行は、開始時の台帳の番号より後のレコードを候補にしない
//   INV-5 確認済の印は、付けた時点の出典の現在の版と照合できたものにだけ付く
//         （その後に出典が変わった場合を除く）
//
// BUG：
//   "none"         正しい実装
//   "write_any"    照合せずに書く（会話の文脈で上書きした文を保存した失敗、Q-06）
//   "stale_check"  照らし直しで、記録した時点の版を見て確認済にする（Q-02）
//   "ignore_tomb"  候補を選ぶときに墓標を見ない（U-02）
//   "read_future"  候補を選ぶときに開始時の番号を見ない（INV-4）
module ledger {
  const BUG: str
  const MAX_VER: int
  const MAX_SEQ: int

  pure val SOURCES = Set("s1", "s2")
  pure val EXCERPTS = Set("e1", "e2", "e3")
  pure val RUNS = Set("r1", "r2")

  // 出典 s の版 v に含まれる抜き書き
  pure def CONTENT(s: str, v: int): Set[str] =
    if (s == "s1") (if (v == 0) Set("e1", "e2") else if (v == 1) Set("e2", "e3") else Set("e3"))
    else (if (v == 0) Set("e1") else if (v == 1) Set("e1", "e3") else Set("e2"))

  type LRecord = { seq: int, src: str, ex: str, ver: int }
  type Tomb = { seq: int, src: str, ex: str }
  // 実行ごとの印。t は印を付けた時刻（論理時刻）
  type Mark = { src: str, ex: str, checked: bool, ver: int, t: int }
  type Run = { started: bool, snapshot: int, candidates: Set[LRecord], marks: Set[Mark] }

  var ver: str -> int
  var lastChange: str -> int
  var records: Set[LRecord]
  var tombs: Set[Tomb]
  var seq: int
  var clock: int
  var runs: str -> Run

  action init = all {
    ver' = SOURCES.mapBy(s => 0),
    lastChange' = SOURCES.mapBy(s => 0),
    records' = Set(),
    tombs' = Set(),
    seq' = 0,
    clock' = 0,
    runs' = RUNS.mapBy(r => { started: false, snapshot: 0, candidates: Set(), marks: Set() }),
  }

  pure def tombstoned(ts: Set[Tomb], r: LRecord, upto: int): bool =
    ts.exists(t => t.src == r.src and t.ex == r.ex and t.seq <= upto)

  // 出典が変わる
  action change(s: str): bool = all {
    ver.get(s) < MAX_VER,
    ver' = ver.set(s, ver.get(s) + 1),
    lastChange' = lastChange.set(s, clock + 1),
    clock' = clock + 1,
    records' = records, tombs' = tombs, seq' = seq, runs' = runs,
  }

  // 台帳から候補を選ぶ（開始時の番号 snap までを読む）
  def candidatesAt(snap: int): Set[LRecord] = records.filter(rec =>
    (BUG == "read_future" or rec.seq <= snap) and
    (BUG == "ignore_tomb" or not(tombstoned(tombs, rec, snap))))

  // 実行を始める：台帳の番号を決め、候補を選ぶ
  action start(r: str): bool = {
    val snap = seq
    all {
      not(runs.get(r).started),
      runs' = runs.set(r, { started: true, snapshot: snap, candidates: candidatesAt(snap), marks: Set() }),
      clock' = clock + 1,
      ver' = ver, lastChange' = lastChange, records' = records, tombs' = tombs, seq' = seq,
    }
  }

  // 実行の途中（続き・深掘り）で台帳を引き直す。開始時の番号までしか読まない
  action refresh(r: str): bool = {
    val rs = runs.get(r)
    all {
      rs.started,
      runs' = runs.set(r, rs.with("candidates", candidatesAt(rs.snapshot))),
      clock' = clock + 1,
      ver' = ver, lastChange' = lastChange, records' = records, tombs' = tombs, seq' = seq,
    }
  }

  // 候補を照らし直す：現在の版と照合し、合えば確認済にして新しいレコードを追記する
  action revalidate(r: str, rec: LRecord): bool = {
    val rs = runs.get(r)
    val v = if (BUG == "stale_check") rec.ver else ver.get(rec.src)
    val ok = CONTENT(rec.src, v).contains(rec.ex)
    val mark = { src: rec.src, ex: rec.ex, checked: ok, ver: v, t: clock + 1 }
    all {
      rs.started,
      rs.candidates.contains(rec),
      seq < MAX_SEQ,
      runs' = runs.set(r, rs.with("marks", rs.marks.union(Set(mark)))),
      records' = if (ok) records.union(Set({ seq: seq + 1, src: rec.src, ex: rec.ex, ver: v })) else records,
      seq' = if (ok) seq + 1 else seq,
      clock' = clock + 1,
      ver' = ver, lastChange' = lastChange, tombs' = tombs,
    }
  }

  // 新しく取得して照合する（会話の Claude が引用した抜き書き e）
  action verifyNew(r: str, s: str, e: str): bool = {
    val rs = runs.get(r)
    val v = ver.get(s)
    val ok = BUG == "write_any" or CONTENT(s, v).contains(e)
    val mark = { src: s, ex: e, checked: ok, ver: v, t: clock + 1 }
    all {
      rs.started,
      seq < MAX_SEQ,
      runs' = runs.set(r, rs.with("marks", rs.marks.union(Set(mark)))),
      records' = if (ok) records.union(Set({ seq: seq + 1, src: s, ex: e, ver: v })) else records,
      seq' = if (ok) seq + 1 else seq,
      clock' = clock + 1,
      ver' = ver, lastChange' = lastChange, tombs' = tombs,
    }
  }

  // 取り消し（墓標の追記）
  action forget(s: str, e: str): bool = all {
    seq < MAX_SEQ,
    tombs' = tombs.union(Set({ seq: seq + 1, src: s, ex: e })),
    seq' = seq + 1,
    clock' = clock + 1,
    ver' = ver, lastChange' = lastChange, records' = records, runs' = runs,
  }

  action step = {
    nondet r = RUNS.oneOf()
    nondet s = SOURCES.oneOf()
    nondet e = EXCERPTS.oneOf()
    any {
      change(s),
      start(r),
      refresh(r),
      verifyNew(r, s, e),
      forget(s, e),
      all {
        runs.get(r).candidates.size() > 0,
        nondet rec = runs.get(r).candidates.oneOf()
        revalidate(r, rec),
      },
    }
  }

  // INV-1
  val inv1 = records.forall(rec => CONTENT(rec.src, rec.ver).contains(rec.ex))

  // INV-3
  val inv3 = RUNS.forall(r =>
    runs.get(r).candidates.forall(rec => not(tombstoned(tombs, rec, runs.get(r).snapshot))))

  // INV-4
  val inv4 = RUNS.forall(r => runs.get(r).candidates.forall(rec => rec.seq <= runs.get(r).snapshot))

  // INV-5（Q-02）
  val inv5 = RUNS.forall(r => runs.get(r).marks.forall(m =>
    not(m.checked) or (
      CONTENT(m.src, m.ver).contains(m.ex) and
      (m.ver == ver.get(m.src) or lastChange.get(m.src) > m.t)
    )))

  // 追記のみ（INV-2）：番号は seq を超えず、同じ番号は1つだけ
  val inv2 = records.forall(a => a.seq <= seq and records.forall(b => a.seq != b.seq or a == b))

  val inv = inv1 and inv2 and inv3 and inv4 and inv5
}

module ledger_ok {
  import ledger(BUG = "none", MAX_VER = 2, MAX_SEQ = 6).*
}

module ledger_bug_write_any {
  import ledger(BUG = "write_any", MAX_VER = 2, MAX_SEQ = 6).*
}

module ledger_bug_stale_check {
  import ledger(BUG = "stale_check", MAX_VER = 2, MAX_SEQ = 6).*
}

module ledger_bug_ignore_tomb {
  import ledger(BUG = "ignore_tomb", MAX_VER = 2, MAX_SEQ = 6).*
}

module ledger_bug_read_future {
  import ledger(BUG = "read_future", MAX_VER = 2, MAX_SEQ = 6).*
}
