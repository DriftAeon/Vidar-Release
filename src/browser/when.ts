// Timestamps for rows and comments. Offsets (`Z`, `+01:00`, Jira's `+0100`) are parsed explicitly, because
// Date.parse rejects the colon-less form in some engines.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** Epoch ms, or null. A stamp with no offset (or a bare date) reads as UTC. */
export function parseWhen(s: string): number | null {
  const m = RE.exec(typeof s === "string" ? s.trim() : "");
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0", frac = "0", off] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, Math.floor(+`0.${frac}` * 1000));
  const check = new Date(ms);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +sec > 59) return null;
  if (off && off.toUpperCase() !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const digits = off.slice(1).replace(":", "");
    const oh = +digits.slice(0, 2);
    const om = digits.length > 2 ? +digits.slice(2, 4) : 0;
    if (oh > 23 || om > 59) return null;
    ms -= sign * (oh * 60 + om) * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

const dayNumber = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);

/** "2h", "Yesterday", "Oct 12" (local time). Empty for an unreadable stamp. */
export function relativeTime(s: string, now: number = Date.now()): string {
  const t = parseWhen(s);
  if (t === null) return "";
  const diff = now - t;
  if (diff < 60000) return "Now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  const then = new Date(t);
  const today = new Date(now);
  if (dayNumber(today) - dayNumber(then) === 1) return "Yesterday";
  const base = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === today.getFullYear() ? base : `${base}, ${then.getFullYear()}`;
}

/** "Oct 12, 2026, 14:05" (local time). Empty for an unreadable stamp. */
export function absoluteTime(s: string): string {
  const t = parseWhen(s);
  if (t === null) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}
