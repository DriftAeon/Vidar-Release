// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { cleanSend } from "../browser/send.ts";
import type { SlackItem } from "./ipc";

export const ITEM_KEYS = ["id", "kind", "place", "sender", "channel", "text", "ts", "url"] as const;

export type Place = SlackItem["place"];

/** Where an item lives. Rust sets `place`; an older item without it falls back to the channel label. */
export function placeOf(item: Pick<SlackItem, "channel"> & { place?: string }): Place {
  const p = item.place;
  if (p === "dm" || p === "group" || p === "channel" || p === "private") return p;
  if (item.channel === "DM") return "dm";
  if (item.channel === "Group DM") return "group";
  return "channel";
}

const SEEN_RE = /^(\d{1,12})(?:\.(\d{1,9}))?$/;

function tsParts(ts: unknown): [number, number] | null {
  const m = SEEN_RE.exec(typeof ts === "string" ? ts : "");
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** True when `ts` is later than `seen` (seconds, then micros as numbers). No readable `seen` means nothing is new. */
export function isNewer(ts: string, seen: string | null | undefined): boolean {
  const a = tsParts(ts);
  const b = tsParts(seen);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

/** The newest readable ts in the list, or "" for none. */
export function newestTs(items: readonly Pick<SlackItem, "ts">[]): string {
  let best = "";
  for (const i of items) if (tsParts(i.ts) && (!best || isNewer(i.ts, best))) best = i.ts;
  return best;
}

/** The later of two ts strings; an unreadable one loses. */
export function laterTs(a: string | null | undefined, b: string | null | undefined): string {
  if (!tsParts(a)) return tsParts(b) ? (b as string) : "";
  if (!tsParts(b)) return a as string;
  return isNewer(b as string, a) ? (b as string) : (a as string);
}

export interface ChannelGroup {
  id: string;
  /** Channel name without the leading #. */
  name: string;
  private: boolean;
  items: SlackItem[];
}

export interface Sections {
  /** DMs and group DMs, newest first. */
  dms: SlackItem[];
  /** Channels by id, the one with the newest message first; each list newest first. */
  channels: ChannelGroup[];
}

const newestFirst = (a: SlackItem, b: SlackItem) => (isNewer(a.ts, b.ts) ? -1 : isNewer(b.ts, a.ts) ? 1 : 0);

export function sections(items: readonly SlackItem[]): Sections {
  const dms: SlackItem[] = [];
  const byId = new Map<string, ChannelGroup>();
  for (const item of items) {
    const place = placeOf(item);
    if (place === "dm" || place === "group") { dms.push(item); continue; }
    const id = item.id.split(":")[0] || item.channel;
    let g = byId.get(id);
    if (!g) {
      g = { id, name: item.channel.replace(/^#/, ""), private: place === "private", items: [] };
      byId.set(id, g);
    }
    g.items.push(item);
  }
  dms.sort(newestFirst);
  const channels = [...byId.values()];
  for (const g of channels) g.items.sort(newestFirst);
  channels.sort((a, b) => newestFirst(a.items[0], b.items[0]));
  return { dms, channels };
}

/** One display letter for a name, by code point; "" when there is none. */
export function initial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "";
}

/** Slack `secs.micros` string to an ISO stamp for `relativeTime`. Empty for an unreadable value. */
export function whenIso(ts: string): string {
  const m = /^(\d{1,12})(?:\.\d+)?$/.exec(typeof ts === "string" ? ts.trim() : "");
  if (!m) return "";
  const ms = Number(m[1]) * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

/** Text typed into a tab for a mention; `channel` already carries `#`, `DM` or `Group DM`. No permalink. */
export function sendText(item: Pick<SlackItem, "sender" | "channel" | "text">): string {
  const flat = `@${item.sender} in ${item.channel}: ${item.text}`.replace(/\s+/g, " ").trim();
  return cleanSend(flat, 1024);
}

export function looksLikeUserToken(s: string): boolean {
  return s.trim().startsWith("xoxp-");
}
