// 全機械共通の頻度制限（docs/03 §2.6.5、§3.1）
//
// 機械（クライアント）が同じホストへの取得の許可証を求める。
// 許可証には開始時刻 startAt と有効期限 expiresAt がある。
// 機械は途中で落ちうる（release しない）。期限切れで回収される。
//
// 不変条件（E-02：取得先の規約と頻度制限を全機械の合計で守る）：
//   INV-6 同じホストへの取得の開始時刻は、全機械を通して MIN_INTERVAL 以上あく
//   INV-7 同時に有効な許可証は MAX_CONC 以下
//
// BUG で、わざと壊した版を作る（空振りの防止）：
//   "none"     正しい実装
//   "spacing"  直前の許可からの間隔を見ずに now から始める
//   "conc"     同時の数を見ずに許可する
module limiter {
  const BUG: str
  const MIN_INTERVAL: int
  const MAX_CONC: int
  const LEASE_TTL: int
  const MAX_TIME: int

  type Lease = { client: str, startAt: int, expiresAt: int }

  pure val CLIENTS = Set("c1", "c2", "c3")

  var now: int
  var lastStart: int
  var leases: Set[Lease]
  // これまでに許可した開始時刻（INV-6 の検査用の履歴）
  var starts: List[int]

  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def iabs(a: int): int = if (a < 0) -a else a

  action init = all {
    now' = 0,
    lastStart' = -1000,
    leases' = Set(),
    starts' = List(),
  }

  // 時間が進む。期限切れの許可証を回収する
  action tick = all {
    now < MAX_TIME,
    now' = now + 1,
    leases' = leases.filter(l => l.expiresAt > now + 1),
    lastStart' = lastStart,
    starts' = starts,
  }

  action acquire(c: str): bool = {
    val startAt = if (BUG == "spacing") now else imax(now, lastStart + MIN_INTERVAL)
    all {
      not(leases.exists(l => l.client == c)),
      BUG == "conc" or leases.size() < MAX_CONC,
      leases' = leases.union(Set({ client: c, startAt: startAt, expiresAt: startAt + LEASE_TTL })),
      lastStart' = startAt,
      starts' = starts.append(startAt),
      now' = now,
    }
  }

  action release(c: str): bool = all {
    leases.exists(l => l.client == c),
    leases' = leases.filter(l => l.client != c),
    lastStart' = lastStart,
    starts' = starts,
    now' = now,
  }

  // 落ちた機械は release しない。モデルでは release を選ばないことで表す
  action step = {
    nondet c = CLIENTS.oneOf()
    any { tick, acquire(c), release(c) }
  }

  // INV-6
  val spacing = starts.indices().forall(i =>
    starts.indices().forall(j => i == j or iabs(starts[i] - starts[j]) >= MIN_INTERVAL))

  // INV-7
  val concurrency = leases.size() <= MAX_CONC

  val inv = spacing and concurrency
}

module limiter_ok {
  import limiter(BUG = "none", MIN_INTERVAL = 3, MAX_CONC = 1, LEASE_TTL = 4, MAX_TIME = 12).*
}

module limiter_ok_conc2 {
  import limiter(BUG = "none", MIN_INTERVAL = 1, MAX_CONC = 2, LEASE_TTL = 3, MAX_TIME = 10).*
}

module limiter_bug_spacing {
  import limiter(BUG = "spacing", MIN_INTERVAL = 3, MAX_CONC = 2, LEASE_TTL = 4, MAX_TIME = 12).*
}

module limiter_bug_conc {
  import limiter(BUG = "conc", MIN_INTERVAL = 1, MAX_CONC = 1, LEASE_TTL = 4, MAX_TIME = 12).*
}
