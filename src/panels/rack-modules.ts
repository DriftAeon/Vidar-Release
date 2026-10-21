// Pure rack identities and saved-order migration. rack.ts adopts these in Wave 5.

import icons from "../../contracts/icons.json" with { type: "json" };

export interface RackServerIdentity {
  name: string;
  scope: string;
  project: string | null;
  transport: string;
  target: string;
  args: readonly string[];
  /** Claude's approval of a project server; absent = approved. */
  approved?: boolean;
}

// mirrors is_loopback_http in mcp.rs: plain http, no userinfo, a loopback host. The URL
// parser decides the host, so `http://localhost:80@evil.example/` and
// `http://127.0.0.1.evil.example/` are not loopback.
export function isLoopbackHttp(target: string): boolean {
  let u: URL;
  try { u = new URL(target); } catch { return false; }
  return u.protocol === "http:" && u.username === "" && u.password === ""
    && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
}

// Match the MCP reader's project_key: forward slashes, no trailing slash, lowercase.
export function normalizeRackProject(project: string | null): string {
  return (project ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function rackServerId(server: RackServerIdentity): string {
  const scope = server.scope;
  const name = encodeURIComponent(server.name);
  if (scope === "user" || scope === "codex") return `rack:server:${scope}:${name}`;
  return `rack:server:${scope}:${encodeURIComponent(normalizeRackProject(server.project))}:${name}`;
}

// JSON tuples avoid collisions between targets and arg boundaries. Project and local
// keys include the project, regardless of transport; stdio runs there too.
export function rackToolsKey(server: RackServerIdentity): string {
  return JSON.stringify([
    server.scope,
    server.scope === "user" || server.scope === "codex" ? null : normalizeRackProject(server.project),
    server.transport,
    server.target,
    server.args,
  ]);
}

/** One server's address for dedupe: scheme, host and port lowercased, trailing `/` trimmed;
 *  path and query keep their case. Stdio servers have none (null): they dedupe by ID only. */
export function rackUrlKey(server: RackServerIdentity): string | null {
  if (server.transport === "stdio") return null;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(server.target.trim());
  if (!m) return null;
  return (m[1].toLowerCase() + m[2]).replace(/\/+$/, "");
}

/** Reader order is significant: keep the first row for each canonical ID, then the first
 *  row for each URL, so one server listed by several sources (user ~/.claude.json and a
 *  project .mcp.json both naming the :8399 proxy, 2026-10-15) shows once. */
export function dedupeRackServers<T extends RackServerIdentity>(servers: readonly T[]): T[] {
  const seen = new Set<string>();
  const urls = new Set<string>();
  return servers.filter((server) => {
    const id = rackServerId(server);
    if (seen.has(id)) return false;
    const url = rackUrlKey(server);
    if (url !== null && urls.has(url)) return false;
    seen.add(id);
    if (url !== null) urls.add(url);
    return true;
  });
}

/** Rail button label: camelCase, `-` and `_` split into Title Case words; OpenAI stays one word. */
export function serverTitle(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (w.toLowerCase() === "openai" ? "OpenAI" : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** The :8399 proxy's config key and address; either one maps a row to the Proxy MCP button. */
export const PROXY_NAME = "proxy";
const PROXY_URL = "http://127.0.0.1:8399/mcp";
export function isProxyServer(server: RackServerIdentity): boolean {
  return server.name === PROXY_NAME || rackUrlKey(server) === PROXY_URL;
}

export interface RailServer {
  id: string;
  name: string;
  title: string;
  /** a ColorIcon name: the server's mark from contracts/icons.json `backends` (notion, slack,
   *  atlassian → jira, …), openai for openai*, else the neutral link */
  icon: string;
}

// The manifest itself rather than icon-img.ts: node tests load this module, and an
// extensionless import would not resolve there.
const SERVER_ICONS = icons.backends as Record<string, string | string[]>;

function railIcon(name: string): string {
  const lower = name.toLowerCase();
  const mark = Object.hasOwn(SERVER_ICONS, lower) ? [SERVER_ICONS[lower]].flat()[0] : undefined;
  if (mark) return mark;
  if (lower.startsWith("openai")) return "openai";
  return "link";
}

/** Rail buttons for one reader result, before visibility: the proxy row folds into the
 *  Proxy MCP button, the rest follow the saved rack order (unknown ones after, reader order). */
export function railServers(servers: readonly RackServerIdentity[], saved: readonly string[]):
  { proxy: RailServer | null; others: RailServer[] } {
  const entry = (s: RackServerIdentity): RailServer =>
    ({ id: rackServerId(s), name: s.name, title: serverTitle(s.name), icon: railIcon(s.name) });
  let proxy: RailServer | null = null;
  const others: RailServer[] = [];
  for (const s of dedupeRackServers(servers)) {
    if (s.approved === false) continue; // an unapproved server gets no rail button
    if (isProxyServer(s)) proxy ??= entry(s);
    else others.push(entry(s));
  }
  const rank = (id: string) => {
    const i = saved.indexOf(id);
    return i < 0 ? saved.length : i;
  };
  others.sort((a, b) => rank(a.id) - rank(b.id)); // stable: unknown ids keep reader order
  return { proxy, others };
}

/** Resolve old bare-name and scope:name hints only against unique current rows.
 * Unknown and ambiguous hints stay in place for a later reader result. The first
 * occurrence of a resolved ID wins, including when aliases resolve to that ID. */
export function reconcileRackOrder(saved: readonly string[], servers: readonly RackServerIdentity[]): string[] {
  const candidates = new Map<string, Set<string>>();
  for (const server of dedupeRackServers(servers)) {
    const id = rackServerId(server);
    for (const hint of [server.name, `${server.scope}:${server.name}`]) {
      let matches = candidates.get(hint);
      if (!matches) candidates.set(hint, matches = new Set());
      matches.add(id);
    }
  }

  const seen = new Set<string>();
  const order: string[] = [];
  for (const hint of saved) {
    const matches = candidates.get(hint);
    const id = matches?.size === 1 ? matches.values().next().value! : hint;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}
