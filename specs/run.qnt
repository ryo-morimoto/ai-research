// 1つの調査の実行（RunDO）（docs/03 §2.5.1、§3.1）
//
// 取得の作業は await の位置で割り込む：作業の完了（complete）は、start・next・steer の
// どの間にも入りうる。1つの action が、ストレージ以外の await で区切られた1手に当たる。
//
// 不変条件：
//   INV-8  締め切りで終わっていなかった現在の版の作業は、その束の cutoffs に必ず現れる
//   INV-9  使用量は上限を超えない
//   INV-10 現在の結果として返したものは、すべて現在の版の問いに対する作業の結果
//   INV-11 深掘りを求めていなければ、T4 以降に作業を始めない
//   有界な応答：Collecting の間、時刻は締め切りを超えない（締め切りで必ず束を返す）
//
// BUG：
//   "none"          正しい実装
//   "mix_versions"  束を作るときに版を確かめない（W-02）
//   "no_cutoffs"    締め切りで終わっていない作業を cutoffs に入れない（Q-04）
//   "no_deadline"   締め切りが来ても束を返さずに時間が進む（W-01）
//   "over_budget"   上限を超えても全部返す（R-01）
//   "late_start"    4分を過ぎても作業を始める（W-04）
module research_run {
  const BUG: str
  const D: int
  const T4: int
  const CAP: int
  const MAX_TIME: int
  const MAX_TASKS: int

  // ev は出来事の順序（論理時刻）。clock は実時間の拍（締め切りの判定に使う）
  type Task = { id: int, v: int, startedEv: int, startedClock: int, deep: bool, done: bool, doneEv: int, delivered: bool }
  type Res = { id: int, v: int }

  var status: str
  var version: int
  var tasks: Set[Task]
  var nextId: int
  var clock: int
  var ev: int
  var deadline: int
  var current: Set[Res]
  var lastBundleEv: int
  var lastBundleVersion: int
  var lastCutoffs: Set[int]
  var used: int
  var deep: bool

  action init = all {
    status' = "Collecting",
    version' = 1,
    tasks' = Set(),
    nextId' = 0,
    clock' = 0,
    ev' = 0,
    deadline' = D,
    current' = Set(),
    lastBundleEv' = -1,
    lastBundleVersion' = 0,
    lastCutoffs' = Set(),
    used' = 0,
    deep' = false,
  }

  pure def isActive(s: str): bool = s == "Collecting" or s == "FirstReturned" or s == "Continuing"

  // 作業（取得・照らし直し）を始める
  action startTask = all {
    isActive(status),
    nextId < MAX_TASKS,
    BUG == "late_start" or deep or clock < T4,
    tasks' = tasks.union(Set({ id: nextId, v: version, startedEv: ev, startedClock: clock, deep: deep,
                               done: false, doneEv: -1, delivered: false })),
    nextId' = nextId + 1,
    ev' = ev + 1,
    status' = status, version' = version, clock' = clock, deadline' = deadline, current' = current,
    lastBundleEv' = lastBundleEv, lastBundleVersion' = lastBundleVersion, lastCutoffs' = lastCutoffs,
    used' = used, deep' = deep,
  }

  // 作業が終わる（await からの復帰。どの時点にも割り込みうる）
  action complete(t: Task): bool = all {
    tasks.contains(t),
    not(t.done),
    tasks' = tasks.exclude(Set(t)).union(Set(t.with("done", true).with("doneEv", ev))),
    ev' = ev + 1,
    status' = status, version' = version, nextId' = nextId, clock' = clock, deadline' = deadline,
    current' = current, lastBundleEv' = lastBundleEv, lastBundleVersion' = lastBundleVersion,
    lastCutoffs' = lastCutoffs, used' = used, deep' = deep,
  }

  // 束を作って返す（最初の束、または next）
  action bundle(nextStatus: str): bool = {
    val ready = tasks.filter(t => t.done and not(t.delivered) and (BUG == "mix_versions" or t.v == version))
    val n = ready.size()
    val fits = BUG == "over_budget" or used + n <= CAP
    val unfinished = tasks.filter(t => t.v == version and not(t.done)).map(t => t.id)
    val delivered = if (fits) ready else Set()
    all {
      tasks' = tasks.map(t => if (delivered.contains(t)) t.with("delivered", true) else t),
      current' = current.union(delivered.map(t => { id: t.id, v: t.v })),
      used' = if (fits) used + n else CAP,
      status' = if (fits) nextStatus else "Stopped",
      lastBundleEv' = ev,
      lastBundleVersion' = version,
      lastCutoffs' = if (BUG == "no_cutoffs") Set() else unfinished,
      ev' = ev + 1,
      version' = version, nextId' = nextId, clock' = clock, deadline' = deadline, deep' = deep,
    }
  }

  // 最初の束：締め切りに達したか、現在の版の作業がすべて終わったとき
  action returnFirst = all {
    status == "Collecting",
    clock >= deadline or (tasks.exists(t => t.v == version) and tasks.forall(t => t.v != version or t.done)),
    bundle("FirstReturned"),
  }

  action nextBundle = all {
    status == "FirstReturned" or status == "Continuing",
    bundle("Continuing"),
  }

  // 方向転換：版を上げ、現在の結果を空にして集め直す
  action steer = all {
    isActive(status),
    version' = version + 1,
    current' = Set(),
    status' = "Collecting",
    deadline' = clock + D,
    ev' = ev + 1,
    tasks' = tasks, nextId' = nextId, clock' = clock, lastBundleEv' = lastBundleEv,
    lastBundleVersion' = lastBundleVersion, lastCutoffs' = lastCutoffs, used' = used, deep' = deep,
  }

  // 時間が進む。Collecting の間は締め切りを超えて進まない（締め切りでアラームが束を返す）
  action tick = all {
    clock < MAX_TIME,
    BUG == "no_deadline" or not(status == "Collecting" and clock >= deadline),
    clock' = clock + 1,
    status' = status, version' = version, tasks' = tasks, nextId' = nextId, ev' = ev, deadline' = deadline,
    current' = current, lastBundleEv' = lastBundleEv, lastBundleVersion' = lastBundleVersion,
    lastCutoffs' = lastCutoffs, used' = used, deep' = deep,
  }

  // 4分で終わる（深掘りでなければ）
  action finish = all {
    status == "FirstReturned" or status == "Continuing",
    clock >= T4,
    not(deep),
    status' = "Done",
    ev' = ev + 1,
    version' = version, tasks' = tasks, nextId' = nextId, clock' = clock, deadline' = deadline,
    current' = current, lastBundleEv' = lastBundleEv, lastBundleVersion' = lastBundleVersion,
    lastCutoffs' = lastCutoffs, used' = used, deep' = deep,
  }

  // 利用者が求めたときだけ深掘りする
  action deepen = all {
    status == "Done",
    not(deep),
    deep' = true,
    status' = "Continuing",
    ev' = ev + 1,
    version' = version, tasks' = tasks, nextId' = nextId, clock' = clock, deadline' = deadline,
    current' = current, lastBundleEv' = lastBundleEv, lastBundleVersion' = lastBundleVersion,
    lastCutoffs' = lastCutoffs, used' = used,
  }

  action step = any {
    startTask,
    all { tasks.exists(t => not(t.done)), nondet t = tasks.filter(t => not(t.done)).oneOf() complete(t) },
    returnFirst,
    nextBundle,
    steer,
    tick,
    finish,
    deepen,
  }

  // INV-8
  val inv8 = lastBundleEv < 0 or tasks.forall(t =>
    (t.v == lastBundleVersion and t.startedEv < lastBundleEv and (not(t.done) or t.doneEv > lastBundleEv))
      implies lastCutoffs.contains(t.id))

  // INV-9
  val inv9 = used <= CAP

  // INV-10
  val inv10 = current.forall(r => r.v == version)

  // INV-11
  val inv11 = tasks.forall(t => t.startedClock < T4 or t.deep)

  // 有界な応答（W-01）
  val bounded = status != "Collecting" or clock <= deadline

  val inv = inv8 and inv9 and inv10 and inv11 and bounded
}

module rrun_ok {
  import research_run(BUG = "none", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}

module rrun_bug_mix_versions {
  import research_run(BUG = "mix_versions", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}

module rrun_bug_no_cutoffs {
  import research_run(BUG = "no_cutoffs", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}

module rrun_bug_no_deadline {
  import research_run(BUG = "no_deadline", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}

module rrun_bug_over_budget {
  import research_run(BUG = "over_budget", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}

module rrun_bug_late_start {
  import research_run(BUG = "late_start", D = 2, T4 = 5, CAP = 3, MAX_TIME = 7, MAX_TASKS = 4).*
}
