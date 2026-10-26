// look <ref|selector> "<question>" | look --file <png> "<question>": clip a shot, hand it with the
// question to headless Haiku (`claude -p`), return text only. The driver never sees image bytes.
// The image goes in as a stream-json image block on stdin.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shot } from "./basic.mjs";
import { explorerRun, countLook, LookCapError, IMAGE_MIME, lookMessage } from "../shot-opts.mjs";

export const HAIKU = "claude-haiku-5-5";

// Default runner: spawn claude, write the stream-json message to stdin. Injected in tests.
export function defaultSpawn(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const CLAUDE_ARGS = ["-p", "--model", HAIKU, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "",
  "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "", "--system-prompt", "You describe UI screenshots."];

// Pull {answer, tokens} out of claude's stream-json (or json) output.
export function parseClaude(stdout) {
  let result = null;
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    for (const c of Array.isArray(o) ? o : [o]) if (c?.type === "result") result = c;
  }
  if (!result) throw new Error("look: claude returned no result");
  if (result.is_error) throw new Error(`look: claude error: ${result.result ?? result.subtype}`);
  const u = result.usage ?? {};
  return {
    answer: String(result.result ?? "").trim(),
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0 },
  };
}

export function askHaiku(bytes, mime, question, spawn = defaultSpawn) {
  const r = spawn("claude", CLAUDE_ARGS, lookMessage(bytes, mime, question));
  if (r.status !== 0 && !r.stdout) throw new Error(`look: claude exited ${r.status}: ${String(r.stderr).slice(0, 300)}`);
  return parseClaude(r.stdout);
}

// argv after the verb: `--file <png> "<q>"` (the flag parser drops a trailing positional).
export function lookArgs(argv) {
  const rest = argv.slice(1);
  let file = null; const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") file = rest[++i];
    else if (!rest[i].startsWith("--")) pos.push(rest[i]);
  }
  return file ? { file, target: null, question: pos[0] } : { file: null, target: pos[0], question: pos[1] };
}

// Pure core: counts the look, captures when no file, asks. deps: {capture(target)→path, spawn, env, argv}.
export async function runLook({ argv, env = process.env, capture, spawn = defaultSpawn }) {
  const { file, target, question } = lookArgs(argv);
  if (!question || (!file && !target)) throw new Error('usage: look <ref|selector> "<question>" | look --file <png> "<question>"');
  try { countLook(explorerRun(env), env.VIDAR_EXPLORER_EPISODE, undefined); }
  catch (e) { if (e instanceof LookCapError) { console.error(e.message); process.exit(2); } throw e; }
  let imgPath = file;
  if (!imgPath) imgPath = await capture(target);
  const mime = IMAGE_MIME[path.extname(imgPath).toLowerCase()];
  if (!mime) throw new Error(`look: unsupported image type ${imgPath}`);
  const out = askHaiku(fs.readFileSync(imgPath), mime, question, spawn);
  return { answer: out.answer, shot: imgPath, tokens: out.tokens };
}

export async function look(ctx) {
  const run = explorerRun();
  const dir = path.join(run ?? path.join(process.env.TEMP ?? ".", "vidar-look"), "shots");
  const capture = async (target) => {
    const out = path.join(dir, `look-${Date.now()}.jpg`);
    const r = await shot({ ...ctx, a1: undefined, flags: { clip: target, scale: "1", jpeg: "80", out } });
    return r?.path ?? out;
  };
  return runLook({ argv: process.argv.slice(2), capture });
}
