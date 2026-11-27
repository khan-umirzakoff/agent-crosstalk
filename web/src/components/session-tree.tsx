import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, GitForkIcon, MessagesSquareIcon, PlusIcon, SearchIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from "@/components/ui/sidebar";
import { APPS, COLOR, DOT, LABEL, NEW_LABEL, STATE, active, ago, label, store, type Group, type Row, type State } from "@/lib/api";
import { cn } from "@/lib/utils";

type Node = Row & { kids: Node[] };

// Rows come flat in tree order with a depth; nest them.
function nest(rows: Row[]): Node[] {
  const top: Node[] = [];
  const stack: Node[] = [];
  for (const r of rows) {
    const node = { ...r, kids: [] };
    while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : top).push(node);
    stack.push(node);
  }
  return top;
}
const anyActive = (n: Node): boolean => active(n) || n.kids.some(anyActive);


// Open state: the person's own toggles win; otherwise recent activity decides.
function useOpen() {
  const [open, setOpen] = useState<Record<string, boolean>>(() => store.get("expanded", {}));
  return {
    is: (key: string, fallback: boolean) => open[key] ?? fallback,
    set: (key: string, value: boolean) =>
      setOpen((o) => {
        const next = { ...o, [key]: value };
        store.set("expanded", next);
        return next;
      }),
    reveal: (keys: string[]) =>
      setOpen((o) => {
        if (keys.every((k) => o[k])) return o;
        const next = { ...o, ...Object.fromEntries(keys.map((k) => [k, true])) };
        store.set("expanded", next);
        return next;
      }),
  };
}

export function SessionTree({ state, selected, onSelect }: { state: State | null; selected: string; onSelect: (key: string) => void }) {
  const [q, setQ] = useState("");
  const open = useOpen();
  const { isMobile, setOpenMobile } = useSidebar();
  const pick = (key: string) => {
    onSelect(key);
    if (isMobile) setOpenMobile(false);
  };
  const query = q.trim().toLowerCase();
  const loaded = !!state;
  // Show the open chat in the list: expand its app, project and parents, then scroll to it.
  useEffect(() => {
    const [agent, id] = selected.split("|");
    const groups = state?.[agent as keyof State];
    if (Array.isArray(groups))
      for (const g of groups) {
        const byId = new Map(g.rows.map((r) => [r.id, r]));
        if (!byId.has(id)) continue;
        const keys = [`app:${agent}`, `proj:${agent}|${g.project}`];
        for (let p = byId.get(id)?.parent, i = 0; p && byId.has(p) && i < 32; p = byId.get(p)?.parent, i++) keys.push(`node:${agent}|${p}`);
        open.reveal(keys);
      }
    setTimeout(() => document.querySelector('[data-sidebar="menu-button"][aria-current="page"]')?.scrollIntoView({ block: "nearest" }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when another chat opens or the list first arrives
  }, [selected, loaded]);

  const session = (agent: string, n: Node, project: string): ReactNode => {
    const key = `${agent}|${n.id}`;
    const has = n.kids.length > 0 && !query;
    const isOpen = has && open.is(`node:${key}`, n.kids.some(anyActive));
    const state = n.status || "";
    const button = (
      <SidebarMenuButton
        isActive={selected === key}
        aria-current={selected === key ? "page" : undefined}
        onClick={() => pick(key)}
        title={[n.kind && `${n.kind} of the session above`, STATE[state], n.cwd || project, n.id].filter(Boolean).join(" · ")}
        className={cn("h-auto min-h-8 py-1.5", state === "closed" && "text-muted-foreground")}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state] ?? "bg-transparent")} />
        {STATE[state] && <span className="sr-only">{STATE[state]}:</span>}
        {n.kind === "fork" && <GitForkIcon className="size-3! shrink-0 opacity-60" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label(n)}</span>
          {n.note && <span className="text-muted-foreground block truncate text-xs">{n.note}</span>}
        </span>
        {n.surface && n.surface !== "desktop" && (
          <span className="text-muted-foreground border-border rounded border px-1 text-[10px] leading-4 uppercase">{n.surface}</span>
        )}
        <time className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{ago(n.last)}</time>
      </SidebarMenuButton>
    );
    if (!has) return <SidebarMenuItem key={key}>{button}</SidebarMenuItem>;
    return (
      <Collapsible key={key} open={isOpen} onOpenChange={(v) => open.set(`node:${key}`, v)} render={<SidebarMenuItem />}>
        {button}
        <CollapsibleTrigger
          render={<button type="button" aria-label={`${isOpen ? "Collapse" : "Expand"} ${label(n)}`} />}
          className="text-muted-foreground hover:text-foreground absolute top-1 -left-5 flex size-6 items-center justify-center rounded-md"
        >
          <ChevronRightIcon className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">{n.kids.map((k) => session(agent, k, project))}</SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const project = (agent: string, g: Group) => {
    const rows = query ? g.rows.filter((r) => [label(r), r.id, g.project, r.note].join(" ").toLowerCase().includes(query)).map((r) => ({ ...r, depth: 0 })) : g.rows;
    if (!rows.length) return null;
    const key = `proj:${agent}|${g.project}`;
    const isOpen = !!query || open.is(key, g.rows.some(active));
    return (
      <Collapsible key={key} open={isOpen} onOpenChange={(v) => open.set(key, v)} render={<SidebarMenuItem />}>
        <CollapsibleTrigger render={<SidebarMenuButton className="text-muted-foreground font-medium" />}>
          <ChevronRightIcon className={cn("transition-transform", isOpen && "rotate-90")} />
          <span className="truncate">{g.project || "(no folder)"}</span>
        </CollapsibleTrigger>
        <SidebarMenuBadge>{g.rows.length}</SidebarMenuBadge>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">{nest(rows).map((n) => session(agent, n, g.project))}</SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <div className="flex items-center gap-2 px-1 pt-1 font-semibold">
          <span className="flex -space-x-1" aria-hidden>
            {APPS.slice(0, 3).map((a) => (
              <span key={a} className="border-sidebar size-3 rounded-full border-2" style={{ background: COLOR[a] }} />
            ))}
          </span>
          crosstalk
        </div>
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <SidebarInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="pl-8"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {!query && (
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={selected === "log"} onClick={() => pick("log")}>
                  <MessagesSquareIcon />
                  All crosstalk messages
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
        {APPS.map((agent) => {
          const data = state?.[agent];
          const appOpen = !!query || open.is(`app:${agent}`, true);
          return (
            <Collapsible key={agent} open={appOpen} onOpenChange={(v) => open.set(`app:${agent}`, v)} render={<SidebarGroup />}>
              <SidebarGroupLabel render={<CollapsibleTrigger />} className="text-sidebar-foreground gap-2 text-sm">
                <span aria-hidden className="size-2 rounded-full" style={{ background: COLOR[agent] }} />
                {LABEL[agent]}
                <ChevronRightIcon className={cn("ml-auto transition-transform", appOpen && "rotate-90")} />
              </SidebarGroupLabel>
              {NEW_LABEL[agent] && Array.isArray(data) && (
                <SidebarGroupAction title={NEW_LABEL[agent]} aria-label={NEW_LABEL[agent]} onClick={() => pick(`${agent}|new`)} className="right-8">
                  <PlusIcon />
                </SidebarGroupAction>
              )}
              <CollapsibleContent>
                <SidebarGroupContent>
                  {!data ? (
                    <p className="text-muted-foreground px-2 text-xs">Loading…</p>
                  ) : "error" in data ? (
                    <p className="text-muted-foreground px-2 text-xs">{agent === "claude" ? data.error : <>Not reachable. Run <code>crosstalk open {agent}</code></>}</p>
                  ) : !data.length ? (
                    <p className="text-muted-foreground px-2 text-xs">No sessions</p>
                  ) : (
                    <SidebarMenu>{data.map((g) => project(agent, g))}</SidebarMenu>
                  )}
                </SidebarGroupContent>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}
