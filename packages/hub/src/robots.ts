/**
 * robots.txt の最小限の解釈（E-02）。User-agent が * か ai-research のグループの
 * Allow / Disallow を見て、最も長く一致した規則に従う。
 */
export type RobotsRules = { allow: string[]; disallow: string[] };

export function parseRobots(text: string, agent = "ai-research"): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow") current.allow.push(value);
    if (key === "disallow") current.disallow.push(value);
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.allow).filter((p) => p.length > 0),
    disallow: chosen.flatMap((g) => g.disallow).filter((p) => p.length > 0),
  };
}

const SPECIAL = /[.+?^$(){}|[\]\\]/g;

function escapeRegExp(s: string): string {
  return s.replace(SPECIAL, (c) => `\\${c}`);
}

function matches(pattern: string, path: string): boolean {
  // * と末尾の $ に対応する
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = "^" + body.split("*").map(escapeRegExp).join(".*") + (anchored ? "$" : "");
  return new RegExp(source).test(path);
}

export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const p of rules.allow) if (matches(p, pathWithQuery) && (!best || p.length >= best.len)) best = { len: p.length, allow: true };
  for (const p of rules.disallow) if (matches(p, pathWithQuery) && (!best || p.length > best.len)) best = { len: p.length, allow: false };
  return best ? best.allow : true;
}
