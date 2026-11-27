import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { toast } from "sonner";
import { Thread, type Sender } from "@/components/assistant-ui/elements/thread.aui";
import { useSidebar } from "@/components/ui/sidebar";
import { COLOR, LABEL, NEW_LABEL, api, type History, type LogLine, type Message, type Party } from "@/lib/api";

type Pending = Message & { pending?: boolean };
type Opener = (key: string) => (() => void) | undefined; // a click handler when that session is listed

const body = (text: string) => (text?.trim() ? text : "_Empty message_");
const Empty: FC<{ text: string }> = ({ text }) => <p className="text-muted-foreground mb-6 px-2 text-center text-sm">{text}</p>;

export function SessionChat({ agent, id, readOnly, opener, onCreated, bump }: { agent: string; id: string; readOnly?: string; opener: Opener; onCreated: (key: string) => void; bump: number }) {
  const fresh = id === "new";
  const [messages, setMessages] = useState<Pending[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(!fresh);
  const [error, setError] = useState("");
  const n = useRef(60);
  const restore = useRef<(text: string) => void>(() => {});
  const { isMobile } = useSidebar();

  const load = useCallback(async () => {
    if (fresh) return;
    try {
      const h = await api<History>(`/api/messages?agent=${agent}&id=${encodeURIComponent(id)}&n=${n.current}`);
      setMessages((old) => (sig(old) === sig(h.messages) ? old : h.messages));
      setTotal(h.total);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agent, id, fresh]);

  useEffect(() => {
    load();
    const t = setInterval(() => document.hidden || load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!bump) return;
    const t = setTimeout(load, 800);
    return () => clearTimeout(t);
  }, [bump, load]);

  const onNew = async (m: AppendMessage) => {
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
    if (!text) return;
    setMessages((old) => [...old, { n: -Date.now(), role: "user", text, ts: Date.now(), pending: true }]);
    try {
      const { to, delivery } = await api<{ to?: Party; delivery?: string }>("/api/send", { agent, target: id, text });
      if (delivery === "held") toast.warning("Claude held the message. Check its inbound message settings.");
      else if (delivery === "queued") toast("Queued");
      if (fresh && to?.id) return onCreated(`${agent}|${to.id}`);
      setTimeout(load, 1500);
      setTimeout(load, 6000);
    } catch (e) {
      setMessages((old) => old.filter((x) => !x.pending));
      restore.current(text); // keep what was typed
      toast.error((e as Error).message);
    }
  };

  const convert = (m: Pending, i: number): ThreadMessageLike => {
    const relay = m.role === "crosstalk" || m.role === "peer";
    const mine = m.role === "user";
    const sender: Sender = mine
      ? { name: m.pending ? "Sending…" : "You", ts: m.ts }
      : relay
        ? { edge: true, name: m.fromName || m.from || "Another agent", color: COLOR[m.fromAgent ?? ""], app: LABEL[m.fromAgent ?? ""], ts: m.ts, onOpen: m.fromAgent && m.fromId ? opener(`${m.fromAgent}|${m.fromId}`) : undefined }
        : { name: LABEL[agent], color: COLOR[agent], ts: m.ts };
    return { id: String(m.n), role: mine ? "user" : "assistant", content: [{ type: "text", text: body(m.text) }], metadata: { custom: { sender: { ...sender, hide: same(m, messages[i - 1]) } } } };
  };

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: convert,
    onNew,
    isDisabled: !!readOnly,
    isLoading: loading,
    hasEarlier: total > messages.length,
    onLoadEarlier: async () => {
      n.current += 100;
      await load();
    },
  });

  restore.current = (text) => runtime.thread.composer.getState().text || runtime.thread.composer.setText(text);

  const welcome = fresh ? `Write the first message to start: ${NEW_LABEL[agent]}.` : error || "No messages yet.";
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={{ Welcome: () => <Empty text={welcome} /> }} placeholder={fresh ? "First message" : "Message"} note={readOnly} autoFocus={!isMobile} />
    </AssistantRuntimeProvider>
  );
}

// A run of messages from one sender within five minutes shows the name once.
const same = (m: Message, p?: Message) => !!p && p.role === m.role && p.fromId === m.fromId && !!m.ts && !!p.ts && m.ts - p.ts < 3e5;

const sig = (ms: Message[]) => JSON.stringify(ms);

const short = (p?: Party) => (!p ? "?" : p.agent === "user" ? "You" : p.name || LABEL[p.agent] || p.agent);

// Every message crosstalk carried, newest last, from the daemon's event stream.
export function LogFeed({ lines, opener }: { lines: LogLine[]; opener: Opener }) {
  const convert = (m: LogLine, i: number): ThreadMessageLike => {
    const mine = m.from?.agent === "user";
    const target = m.to?.id ? opener(`${m.to.agent}|${m.to.id}`) : undefined;
    const from = m.from?.id ? opener(`${m.from.agent}|${m.from.id}`) : undefined;
    const failed = m.delivery?.startsWith("not delivered");
    const sender: Sender = {
      edge: true,
      name: `${short(m.from)} → ${short(m.to)}`,
      color: COLOR[m.from?.agent],
      app: failed ? "Not delivered" : m.delivery === "held" ? "Held by Claude" : m.delivery === "queued" ? "Queued" : undefined,
      ts: Date.parse(m.ts),
      onOpen: from ?? target,
    };
    return { id: `log${i}`, role: mine ? "user" : "assistant", content: [{ type: "text", text: body(m.text) }], metadata: { custom: { sender } } };
  };
  const runtime = useExternalStoreRuntime({ messages: lines, convertMessage: convert, onNew: async () => {}, isDisabled: true });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread composer={false} components={{ Welcome: () => <Empty text='No messages between agents yet. Tell one something like "ask Antigravity to review this diff".' /> }} />
    </AssistantRuntimeProvider>
  );
}
