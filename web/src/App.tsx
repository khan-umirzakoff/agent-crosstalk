import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { LogFeed, SessionChat } from "@/components/chat";
import { SessionTree } from "@/components/session-tree";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APPS, DOT, LABEL, NEW_LABEL, STATE, TOKEN, abilities, ago, api, label, store, type LogLine, type Row, type State } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string>(() => store.get("selected", { key: "log" }).key || "log");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [bump, setBump] = useState(0);
  const current = useRef(selected);

  const select = useCallback((key: string) => {
    current.current = key;
    setSelected(key);
    store.set("selected", { key });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { agents } = await api<{ agents: State }>("/api/state");
      setState((old) => (JSON.stringify(old) === JSON.stringify(agents) ? old : agents));
    } catch (e) {
      toast.error((e as Error).message, { id: "state" });
    }
  }, []);

  useEffect(() => {
    if (!TOKEN) return;
    refresh();
    const t = setInterval(() => document.hidden || refresh(), 60000); // a fallback: the daemon announces changes
    const ev = new EventSource("/events?token=" + encodeURIComponent(TOKEN));
    const seen = new Set<string>(); // a reconnect replays the backlog
    ev.onmessage = (e) => {
      if (seen.has(e.data)) return;
      seen.add(e.data);
      const line = JSON.parse(e.data) as LogLine;
      setLines((old) => [...old, line]);
      if ([line.from, line.to].some((p) => p?.id && `${p.agent}|${p.id}` === current.current)) setBump((b) => b + 1);
    };
    ev.addEventListener("state", () => document.hidden || refresh());
    ev.onerror = () => refresh();
    return () => {
      clearInterval(t);
      ev.close();
    };
  }, [refresh]);

  const find = useCallback(
    (key: string) => {
      const [agent, id] = key.split("|");
      const groups = state?.[agent as keyof State];
      if (Array.isArray(groups)) for (const g of groups) for (const r of g.rows) if (r.id === id) return { agent, row: r, project: g.project };
      return null;
    },
    [state],
  );
  const opener = useCallback((key: string) => (find(key) ? () => select(key) : undefined), [find, select]);

  if (!TOKEN) return <p className="text-muted-foreground p-8">Open the link that <code>crosstalk ui</code> printed (it ends with #…).</p>;

  return (
    <TooltipProvider>
      <SidebarProvider style={{ "--sidebar-width": "20rem" } as React.CSSProperties}>
        <SessionTree state={state} selected={selected} onSelect={select} />
        <SidebarInset className="h-svh overflow-hidden">
          <Main selected={selected} find={find} opener={opener} lines={lines} bump={bump} select={select} refresh={refresh} />
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}

type Found = { agent: string; row: Row; project: string } | null;

function Main({ selected, find, opener, lines, bump, select, refresh }: { selected: string; find: (k: string) => Found; opener: (k: string) => (() => void) | undefined; lines: LogLine[]; bump: number; select: (k: string) => void; refresh: () => Promise<void> }) {
  const [agent, id] = selected.split("|");
  const found = find(selected);
  const r = found?.row;
  const isLog = selected === "log" || !APPS.includes(agent as never);

  const readOnly = useMemo(() => {
    if (agent === "claude" && r?.status === "waiting") return `${r.note || "Waiting for you"} · answer in the Claude app`;
    return undefined;
  }, [agent, r?.status, r?.note]);

  const title = isLog ? "All crosstalk messages" : id === "new" ? NEW_LABEL[agent] : r ? label(r) : id;
  const sub = isLog
    ? "Between agents"
    : [r?.status && STATE[r.status], LABEL[agent], r?.surface && r.surface !== "desktop" ? r.surface : null, found?.project, r?.last && `active ${ago(r.last)} ago`].filter(Boolean).join(" · ");

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" title={r?.id}>
            {title}
          </h1>
          <p className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            {!isLog && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[r?.status ?? ""] ?? "bg-muted-foreground/30")} />}
            <span className="truncate">{sub}</span>
          </p>
        </div>
        {found && <Actions agent={agent} row={found.row} done={async () => (await refresh(), select("log"))} />}
      </header>
      <div className="min-h-0 flex-1">
        {isLog ? (
          <LogFeed lines={lines} opener={opener} />
        ) : (
          <SessionChat key={selected} agent={agent} id={id} readOnly={readOnly} opener={opener} onCreated={async (key) => (await refresh(), select(key))} bump={bump} />
        )}
      </div>
    </>
  );
}

// A session's name for a dialog: Codex names a thread by its whole first prompt.
const short = (r: Row) => {
  const name = label(r);
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
};

// Archive and delete where the app allows it from outside.
function Actions({ agent, row, done }: { agent: string; row: Row; done: () => Promise<void> }) {
  const can = abilities(agent, row);
  const run = async (action: "archive" | "delete") => {
    try {
      await api("/api/manage", { action, agent, target: row.id });
      toast.success(action === "delete" ? "Deleted" : agent === "claude" ? "Stopped" : "Archived");
      await done();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const stop = agent === "claude";
  return (
    <div className="flex items-center gap-1">
      {can.includes("archive") && (
        <Confirm
          title={stop ? "Stop this session?" : "Archive this thread?"}
          name={short(row)}
          text={stop ? "It can be opened again with claude attach." : "It moves to the app's archive."}
          action={stop ? "Stop" : "Archive"}
          onConfirm={() => run("archive")}
          trigger={
            <Button variant="ghost" size="icon" aria-label={stop ? "Stop this session" : "Archive"} title={stop ? "Stop this session" : "Archive"}>
              {stop ? <SquareIcon /> : <ArchiveIcon />}
            </Button>
          }
        />
      )}
      {can.includes("delete") && (
        <Confirm
          title={agent === "codex" ? "Delete this thread?" : "Delete this session?"}
          name={short(row)}
          text={stop ? "It leaves the list; its conversation is kept." : "This cannot be undone."}
          action="Delete"
          destructive
          onConfirm={() => run("delete")}
          trigger={
            <Button variant="ghost" size="icon" aria-label="Delete" title="Delete" className="hover:text-destructive">
              <Trash2Icon />
            </Button>
          }
        />
      )}
    </div>
  );
}

function Confirm({ title, name, text, action, destructive, onConfirm, trigger }: { title: string; name: string; text: string; action: string; destructive?: boolean; onConfirm: () => void; trigger: React.ReactElement }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="text-foreground line-clamp-2 font-medium">{name}</span>
            {text}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
