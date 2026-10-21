// Extract and compare the protocol surface; no installed Codex or network on import.
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
      if (group === "serverRequests") {
        if (!paramsType?.endsWith("Params")) throw new Error(`Cannot derive response for ${paramsType}`);
        entry.response = contract(load(paramsType.replace(/Params$/, "Response")));
      }
      return entry;
    }).sort((a, b) => a.method.localeCompare(b.method, "en"));
    if (new Set(methods.map((m) => m.method)).size !== methods.length) throw new Error(`Duplicate methods in ${group}`);
    manifest[group] = methods;
  }
  return manifest;
}

/** True when two manifests describe the same protocol surface; `codexVersion` is the only field ignored. */
export function sameSurface(a, b) {
  return isDeepStrictEqual({ ...a, codexVersion: null }, { ...b, codexVersion: null });
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
