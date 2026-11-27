// The daemon's API (lib/ui.js). The token comes in the URL fragment of the link `crosstalk ui` prints.
export const TOKEN = location.hash.slice(1);

export const APPS = ["claude", "antigravity", "codex", "opencode", "hermes"] as const;
export type App = (typeof APPS)[number];

export const LABEL: Record<string, string> = { claude: "Claude", antigravity: "Antigravity", codex: "Codex", opencode: "OpenCode", hermes: "Hermes", terminal: "Terminal", user: "You" };
export const COLOR: Record<string, string> = { claude: "#d97757", antigravity: "#4c8df6", codex: "#23a8b5", opencode: "#8a8f98", hermes: "#b0874f", user: "#8a8881" };
export const DOT: Record<string, string> = { busy: "bg-amber-500 animate-pulse", waiting: "bg-violet-500", idle: "bg-emerald-500", open: "bg-emerald-500", closed: "bg-muted-foreground/30" };
export const STATE: Record<string, string> = { idle: "Ready", busy: "Working", waiting: "Waiting for you", open: "Open", closed: "Not running" };
export const NEW_LABEL: Record<string, string> = { antigravity: "New Antigravity conversation", codex: "New Codex thread", opencode: "New OpenCode session", hermes: "New Hermes session" };

export type Row = {
  id: string;
  name?: string;
  short?: string | null;
  kind?: string | null;
  status?: string;
  surface?: string;
  note?: string | null;
  cwd?: string;
  last?: number;
  depth: number;
  parent?: string | null;
};
export type Group = { project: string; rows: Row[] };
export type State = Record<App, Group[] | { error: string }>;

export type Message = { n: number; role: string; text: string; ts?: number; fromAgent?: string; fromName?: string; fromId?: string; from?: string };
export type History = { id: string; name?: string; total: number; messages: Message[] };
export type Party = { agent: string; id?: string; name?: string };
export type LogLine = { ts: string; from: Party; to: Party; text: string; delivery?: string };

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "x-crosstalk-token": TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data as T;
}

export const label = (r: Row) => (r.name && r.name !== r.id ? r.name : `${r.kind ? r.kind[0].toUpperCase() + r.kind.slice(1) : "Untitled"} · ${r.id.slice(0, 8)}`);

export function ago(ms?: number) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const RECENT = 3 * 864e5; // trees with activity in the last 3 days start expanded
export const active = (r: Row) => r.status === "busy" || r.status === "waiting" || (!!r.last && Date.now() - r.last < RECENT);

// What the app lets crosstalk do to a session from outside.
export function abilities(agent: string, r: Row): ("archive" | "delete")[] {
  if (agent === "codex") return ["archive", "delete"];
  if (agent === "antigravity") return r.surface === "desktop" ? ["delete"] : [];
  if (agent === "claude") return r.short ? ["archive", "delete"] : [];
  return ["delete"];
}

export const store = {
  get<T>(k: string, d: T): T {
    try {
      return JSON.parse(localStorage.getItem("crosstalk." + k) ?? "null") ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("crosstalk." + k, JSON.stringify(v));
    } catch {}
  },
};
