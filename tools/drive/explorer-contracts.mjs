// Explorer line contracts: Snapshot, RunLogLine, FindingLine, GoalFile. Pure, no deps.
// Each validateX(obj) returns string[] of problems; an empty array means valid.

export const FLAGS = ["zero-size", "off-viewport", "clipped-text", "occluded", "overlap", "low-contrast", "broken-image", "fg-equals-bg"];
export const SNAPSHOT_REASONS = ["start", "reload", "large", "asked"];
export const FINDING_KINDS = ["pass", "fail", "blocked", "detour", "stale", "wanted", "not-driven"];
export const REAL_MODEL_TAGS = ["model", "effort", "card", "approval"];

/**
 * @typedef {{enabled:boolean, checked?:boolean, expanded?:boolean, selected?:boolean, focused?:boolean}} NodeState
 * @typedef {{ref:string, role:string, name:string, state:NodeState, locator:{role:string, name:string, nth:number},
 *   flags:string[], bbox:{x:number, y:number, w:number, h:number},
 *   cover?:{tag:string, role:string, name:string, cls:string, bbox:object, relation:string}}} SnapshotNode
 * @typedef {{v:1, port:number|string, timeOrigin:number, full:boolean, reason?:string, nodes:SnapshotNode[], removed?:string[]}} Snapshot
 * @typedef {{t:string, port:number|string, episode:string|number, verb:string, args:string[],
 *   target?:{ref:string, locator:object}|{selector:string}, hit?:{ok:boolean, ref?:string, tag?:string}, exit:number}} RunLogLine
 * @typedef {{t:string, goal:string, step:number|string, intent:string, did:string, observed:string, expected:string,
 *   kind:string, episode?:string, shot?:string, dup?:boolean|string}} FindingLine
 * @typedef {{id:string, title:string, style:string, scope:"vidar", surfaces:string[], tags:string[],
 *   realModel:boolean, core:boolean, steps:{intent:string}[]}} GoalFile
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);
const REF = /^e\d+$/;

function need(errs, obj, key, ok, what, where = "") {
  if (!ok(obj[key])) errs.push(`${where}${key}: expected ${what}`);
}

function validateNode(n, i) {
  const w = `nodes[${i}].`;
  const errs = [];
  if (!isObj(n)) return [`nodes[${i}]: expected object`];
  need(errs, n, "ref", (v) => isStr(v) && REF.test(v), "ref like e<n>", w);
  need(errs, n, "role", isStr, "string", w);
  need(errs, n, "name", isStr, "string", w);
  if (!isObj(n.state)) errs.push(`${w}state: expected object`);
  else {
    need(errs, n.state, "enabled", (v) => typeof v === "boolean", "boolean", `${w}state.`);
    for (const k of ["checked", "expanded", "selected", "focused"]) {
      if (n.state[k] !== undefined && typeof n.state[k] !== "boolean") errs.push(`${w}state.${k}: expected boolean`);
    }
  }
  if (!isObj(n.locator)) errs.push(`${w}locator: expected object`);
  else {
    need(errs, n.locator, "role", isStr, "string", `${w}locator.`);
    need(errs, n.locator, "name", isStr, "string", `${w}locator.`);
    need(errs, n.locator, "nth", (v) => Number.isInteger(v) && v >= 0, "non-negative integer", `${w}locator.`);
  }
  if (!isStrArr(n.flags)) errs.push(`${w}flags: expected string[]`);
  else for (const f of n.flags) if (!FLAGS.includes(f)) errs.push(`${w}flags: unknown flag ${f}`);
  if (!isObj(n.bbox)) errs.push(`${w}bbox: expected object`);
  else for (const k of ["x", "y", "w", "h"]) need(errs, n.bbox, k, isNum, "number", `${w}bbox.`);
  if (n.cover !== undefined) {
    if (!isObj(n.cover)) errs.push(`${w}cover: expected object`);
    else {
      for (const k of ["tag", "role", "name", "cls", "relation"]) need(errs, n.cover, k, isStr, "string", `${w}cover.`);
      if (!isObj(n.cover.bbox)) errs.push(`${w}cover.bbox: expected object`);
      else for (const k of ["x", "y", "w", "h"]) need(errs, n.cover.bbox, k, isNum, "number", `${w}cover.bbox.`);
    }
  }
  return errs;
}

/** @returns {string[]} */
export function validateSnapshot(o) {
  if (!isObj(o)) return ["snapshot: expected object"];
  const errs = [];
  if (o.v !== 1) errs.push("v: expected 1");
  need(errs, o, "port", (v) => isNum(v) || isStr(v), "port number or string");
  need(errs, o, "timeOrigin", isNum, "number");
  need(errs, o, "full", (v) => typeof v === "boolean", "boolean");
  if (o.reason !== undefined && !SNAPSHOT_REASONS.includes(o.reason)) errs.push(`reason: expected one of ${SNAPSHOT_REASONS.join("|")}`);
  if (!Array.isArray(o.nodes)) errs.push("nodes: expected array");
  else o.nodes.forEach((n, i) => errs.push(...validateNode(n, i)));
  if (o.removed !== undefined) {
    if (!isStrArr(o.removed)) errs.push("removed: expected string[]");
    else for (const r of o.removed) if (!REF.test(r)) errs.push(`removed: bad ref ${r}`);
  }
  return errs;
}

/** @returns {string[]} */
export function validateRunLogLine(o) {
  if (!isObj(o)) return ["runlog: expected object"];
  const errs = [];
  need(errs, o, "t", isStr, "string");
  need(errs, o, "port", (v) => isNum(v) || isStr(v), "port number or string");
  need(errs, o, "episode", (v) => isStr(v) || isNum(v), "string or number");
  need(errs, o, "verb", isStr, "string");
  need(errs, o, "args", isStrArr, "string[]");
  need(errs, o, "exit", Number.isInteger, "integer");
  if (o.target !== undefined) {
    if (!isObj(o.target)) errs.push("target: expected object");
    else if (o.target.selector !== undefined) {
      need(errs, o.target, "selector", (v) => isStr(v) && v.length > 0, "non-empty string", "target.");
    } else {
      need(errs, o.target, "ref", (v) => isStr(v) && REF.test(v), "ref like e<n>", "target.");
      need(errs, o.target, "locator", isObj, "object", "target.");
    }
  }
  if (o.hit !== undefined) {
    if (!isObj(o.hit)) errs.push("hit: expected object");
    else {
      need(errs, o.hit, "ok", (v) => typeof v === "boolean", "boolean", "hit.");
      for (const k of ["ref", "tag"]) if (o.hit[k] !== undefined && !isStr(o.hit[k])) errs.push(`hit.${k}: expected string`);
    }
  }
  return errs;
}

/** @returns {string[]} */
export function validateFindingLine(o) {
  if (!isObj(o)) return ["finding: expected object"];
  const errs = [];
  need(errs, o, "t", (v) => isStr(v) && !Number.isNaN(Date.parse(v)), "ISO timestamp string");
  need(errs, o, "goal", isStr, "string");
  need(errs, o, "step", (v) => isStr(v) || isNum(v), "string or number");
  for (const k of ["intent", "did", "observed", "expected"]) need(errs, o, k, isStr, "string");
  need(errs, o, "kind", (v) => FINDING_KINDS.includes(v), `one of ${FINDING_KINDS.join("|")}`);
  if (o.episode !== undefined && !isStr(o.episode)) errs.push("episode: expected string");
  if (o.shot !== undefined && !isStr(o.shot)) errs.push("shot: expected string");
  if (o.dup !== undefined && typeof o.dup !== "boolean" && !isStr(o.dup)) errs.push("dup: expected boolean or string");
  return errs;
}

/** @returns {string[]} */
export function validateGoalFile(o) {
  if (!isObj(o)) return ["goal: expected object"];
  const errs = [];
  for (const k of ["id", "title", "style"]) need(errs, o, k, isStr, "string");
  need(errs, o, "scope", (v) => v === "vidar", '"vidar"');
  need(errs, o, "surfaces", isStrArr, "string[]");
  need(errs, o, "tags", isStrArr, "string[]");
  need(errs, o, "realModel", (v) => typeof v === "boolean", "boolean");
  need(errs, o, "core", (v) => typeof v === "boolean", "boolean");
  if (!Array.isArray(o.steps) || o.steps.length === 0) errs.push("steps: expected non-empty array");
  else o.steps.forEach((s, i) => { if (!isObj(s) || !isStr(s.intent)) errs.push(`steps[${i}].intent: expected string`); });
  if (isStrArr(o.tags) && o.tags.some((t) => REAL_MODEL_TAGS.includes(t)) && o.realModel !== true) {
    errs.push(`realModel: must be true when a tag is one of ${REAL_MODEL_TAGS.join("|")}`);
  }
  return errs;
}
