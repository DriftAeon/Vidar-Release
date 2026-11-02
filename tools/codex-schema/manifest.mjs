// Extract and compare the protocol surface; no installed Codex or network on import. breakingChanges
// judges a drift by direction (what Vidar sends vs reads) over the manifest's `shapes`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const GROUPS = ["clientRequests", "serverRequests", "notifications"];
const sources = ["ClientRequest", "ServerRequest", "ServerNotification"];
const metadata = new Set(["$schema", "$id", "title", "description", "default", "examples", "deprecated"]);

function trim(schema) {
  if (Array.isArray(schema)) return schema.map(trim);
  if (!schema || typeof schema !== "object") return schema;
  // Property and definition names are data, including names such as 'description'.
  return Object.fromEntries(Object.keys(schema).sort().filter((key) => !metadata.has(key)).map((key) =>
    [key, ["properties", "definitions", "patternProperties"].includes(key)
      ? Object.fromEntries(Object.keys(schema[key]).sort().map((name) => [name, trim(schema[key][name])]))
      : ["enum", "const"].includes(key) ? schema[key] : trim(schema[key])]));
}

export function contract(schema) {
  const { definitions = {}, ...root } = schema;
  const kept = {};
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const match = /^#\/definitions\/([^/]+)$/.exec(value.$ref);
      if (!match || !Object.hasOwn(definitions, match[1])) throw new Error(`Unresolved schema reference: ${value.$ref}`);
      const name = match[1];
      if (!Object.hasOwn(kept, name)) { kept[name] = definitions[name]; visit(kept[name]); }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return trim({ ...root, ...(Object.keys(kept).length ? { definitions: kept } : {}) });
}

export function buildManifest(directory, codexVersion) {
  const load = (name) => JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
  const manifest = { format: 1, codexVersion, experimental: true };
  // Each method's trimmed params over one shared definitions table: what breakingChanges compares.
  const shapes = { definitions: {}, ...Object.fromEntries(GROUPS.map((group) => [group, {}])) };
  for (const [index, group] of GROUPS.entries()) {
    const schema = load(sources[index]);
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) throw new Error(`${sources[index]} has no method variants`);
    const methods = schema.oneOf.map((variant) => {
      const names = variant.properties?.method?.enum;
      const paramsSchema = variant.properties?.params;
      const ref = paramsSchema?.$ref ?? paramsSchema?.anyOf?.find((part) => part.$ref)?.$ref;
      if (names?.length !== 1 || typeof names[0] !== "string" || !paramsSchema ||
          (ref && !ref.startsWith("#/definitions/"))) {
        throw new Error(`Unrecognized method variant in ${sources[index]}`);
      }
      const paramsType = ref ? ref.slice("#/definitions/".length) : null;
      const params = contract({ ...paramsSchema, definitions: schema.definitions });
      const paramsSha256 = createHash("sha256").update(JSON.stringify(params)).digest("hex");
      const entry = { method: names[0], paramsType, paramsSha256 };
      const { definitions = {}, ...root } = params;
      shapes[group][names[0]] = root;
      for (const [name, definition] of Object.entries(definitions)) {
        const known = shapes.definitions[name];
        if (known && !isDeepStrictEqual(known, definition)) throw new Error(`Definition ${name} differs between groups`);
        shapes.definitions[name] = definition;
      }
      if (group === "serverRequests") {
        if (!paramsType?.endsWith("Params")) throw new Error(`Cannot derive response for ${paramsType}`);
        entry.response = contract(load(paramsType.replace(/Params$/, "Response")));
      }
      return entry;
    }).sort((a, b) => a.method.localeCompare(b.method, "en"));
    if (new Set(methods.map((m) => m.method)).size !== methods.length) throw new Error(`Duplicate methods in ${group}`);
    manifest[group] = methods;
  }
  shapes.definitions = Object.fromEntries(Object.keys(shapes.definitions).sort().map((name) => [name, shapes.definitions[name]]));
  manifest.shapes = shapes;
  return manifest;
}

/** True when two manifests describe the same protocol surface; `codexVersion` and `called` (refresh.mjs's
 *  scan of Vidar's sources, not a protocol fact) are the fields ignored. */
export function sameSurface(a, b) {
  return isDeepStrictEqual({ ...a, codexVersion: null, called: null }, { ...b, codexVersion: null, called: null });
}

export function diffMethods(before, after) {
  return Object.fromEntries(GROUPS.map((group) => {
    const previous = new Map((before?.[group] ?? []).map((entry) => [entry.method, entry]));
    const next = new Map(after[group].map((entry) => [entry.method, entry]));
    const added = [...next.keys()].filter((name) => !previous.has(name));
    const removed = [...previous.keys()].filter((name) => !next.has(name));
    const changed = [...next.keys()].filter((name) => previous.has(name) &&
      JSON.stringify(previous.get(name)) !== JSON.stringify(next.get(name)));
    // Shared parameter types suggest a rename; they cannot prove upstream intent.
    const possibleRenames = removed.flatMap((from) => added.filter((to) =>
      previous.get(from).paramsType && previous.get(from).paramsType === next.get(to).paramsType).map((to) => ({ from, to })));
    return [group, { added, removed, changed, possibleRenames }];
  }));
}

// ---- Compatibility: does a drift break something Vidar uses ----
// Direction decides. Vidar writes client request params and server request responses, so Codex must still
// accept what it sends: a removed field, value or union variant, a narrowed type or a newly required
// field breaks. Vidar reads notifications and server request params through guards that treat every field
// as optional (str/obj/num in src/agents), so a read breaks only when a field is gone or changes type;
// added fields, values and variants never do. Client requests Vidar never sends (`called`) do not count.

/** `#/definitions/X` chains followed; `refs` collects the names for the cycle guard. */
function deref(schema, defs, refs) {
  let s = schema;
  while (s && typeof s === "object" && typeof s.$ref === "string") {
    const name = s.$ref.replace("#/definitions/", "");
    refs.push(name);
    s = defs[name];
  }
  return s;
}

/** A discriminated union member's tag (`type` enum or const), null when it has none. */
function tagOf(s) {
  const t = s?.properties?.type;
  if (t?.enum?.length === 1) return String(t.enum[0]);
  return t && t.const !== undefined ? String(t.const) : null;
}

/** One schema node flattened: types, enum values, properties (undiscriminated union branches' merged in),
 *  required names, items, additionalProperties and the discriminated variants by tag. */
function shapeOf(schema, defs) {
  const refs = [];
  const s = deref(schema, defs, refs);
  const node = { refs, any: false, types: new Set(), enum: null, props: new Map(), required: new Set(), items: null, extra: null, variants: new Map() };
  if (!s || typeof s !== "object" || !Object.keys(s).length) return { ...node, any: true };
  const merge = (part, own) => {
    for (const t of [part.type].flat()) if (t) node.types.add(t === "integer" ? "number" : t);
    const values = part.enum ?? (part.const !== undefined ? [part.const] : null);
    if (values) node.enum = new Set([...(node.enum ?? []), ...values.map(String)]);
    if (part.properties) node.types.add("object");
    for (const [k, v] of Object.entries(part.properties ?? {})) if (!node.props.has(k)) node.props.set(k, v);
    if (own) for (const r of part.required ?? []) node.required.add(r);
    if (part.items && typeof part.items === "object") node.items = part.items;
    if (part.additionalProperties && typeof part.additionalProperties === "object") node.extra = part.additionalProperties;
  };
  merge(s, true);
  for (const part of s.allOf ?? []) merge(deref(part, defs, []) ?? {}, true);
  const branches = [...(s.anyOf ?? []), ...(s.oneOf ?? [])];
  const objects = branches.filter((b) => { const r = deref(b, defs, []); return r && (r.properties || r.anyOf || r.oneOf); });
  const sole = branches.filter((b) => deref(b, defs, [])?.type !== "null").length === 1;
  for (const b of branches) {
    const r = deref(b, defs, []) ?? {};
    const tag = tagOf(r);
    if (tag !== null && objects.length > 1) { node.variants.set(tag, b); node.types.add("object"); continue; }
    if (r.anyOf || r.oneOf) {
      const inner = shapeOf(b, defs);
      for (const t of inner.types) node.types.add(t);
      if (inner.enum) node.enum = new Set([...(node.enum ?? []), ...inner.enum]);
      for (const [k, v] of inner.props) if (!node.props.has(k)) node.props.set(k, v);
      for (const [k, v] of inner.variants) node.variants.set(k, v);
      continue;
    }
    merge(r, sole); // a branch's required names bind only when it is the one non-null branch
  }
  return node;
}

function compare(role, a, b, ctx, path) {
  const A = shapeOf(a, ctx.a), B = shapeOf(b, ctx.b);
  if (A.refs.length || B.refs.length) {
    const key = `${role}|${A.refs.join(">")}|${B.refs.join(">")}`;
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }
  if (A.any || B.any) return; // an unconstrained side: nothing to hold the other to
  const fail = (why) => ctx.out.push(`${path}: ${why}`);
  const minus = (x, y) => [...x].filter((v) => !y.has(v));
  if (A.types.size && B.types.size) {
    if (role === "write" && minus(A.types, B.types).length) fail(`no longer accepts ${minus(A.types, B.types).join(", ")}`);
    const fresh = minus(B.types, A.types).filter((t) => t !== "null");
    if (role === "read" && fresh.length) fail(`may now be ${fresh.join(", ")}`);
  }
  if (role === "write" && A.enum && B.enum && minus(A.enum, B.enum).length) fail(`values removed: ${minus(A.enum, B.enum).join(", ")}`);
  for (const [name, schema] of A.props) {
    if (!B.props.has(name)) fail(`field ${name} removed`);
    else compare(role, schema, B.props.get(name), ctx, `${path}.${name}`);
  }
  if (role === "write") for (const name of B.required) if (!A.required.has(name)) fail(`field ${name} is now required`);
  if (A.items && B.items) compare(role, A.items, B.items, ctx, `${path}[]`);
  if (A.extra && B.extra) compare(role, A.extra, B.extra, ctx, `${path}{}`);
  for (const [tag, schema] of A.variants) {
    if (!B.variants.has(tag)) { if (role === "write") fail(`variant ${tag} removed`); }
    else compare(role, schema, B.variants.get(tag), ctx, `${path}<${tag}>`);
  }
}

/** Why the drift from the pinned `before` to the installed `after` breaks Vidar; [] when it is compatible.
 *  A pinned manifest without shapes cannot be judged, so every drift from it counts as breaking. */
export function breakingChanges(before, after, diff = diffMethods(before, after)) {
  if (!before?.shapes || !after?.shapes) return ["the pinned manifest has no shapes to compare against"];
  const out = [];
  const calls = Array.isArray(before.called) ? new Set(before.called) : null; // none recorded: every request counts
  const sent = (method) => !calls || calls.has(method);
  const run = (role, group, method, defs = null, a = before.shapes[group][method], b = after.shapes[group][method], path = method) =>
    compare(role, a, b, { a: defs?.[0] ?? before.shapes.definitions, b: defs?.[1] ?? after.shapes.definitions, seen: new Set(), out }, path);
  for (const m of diff.clientRequests.removed) if (sent(m)) out.push(`${m}: removed`);
  for (const m of diff.clientRequests.changed) if (sent(m)) run("write", "clientRequests", m);
  for (const m of diff.serverRequests.added) out.push(`${m}: a new server request Vidar has no card or refusal for`);
  for (const m of diff.serverRequests.changed) {
    run("read", "serverRequests", m);
    const response = (manifest) => manifest.serverRequests.find((entry) => entry.method === m).response ?? {};
    const { definitions: da = {}, ...ra } = response(before);
    const { definitions: db = {}, ...rb } = response(after);
    run("write", "serverRequests", m, [da, db], ra, rb, `${m} response`);
  }
  for (const m of diff.notifications.removed) out.push(`${m}: removed`);
  for (const m of diff.notifications.changed) run("read", "notifications", m);
  return out;
}
