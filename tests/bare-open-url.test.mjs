// tools/bare/open-url.cmd: the BROWSER opener Bare Claude tabs use. Spawned through the real cross-spawn
// (the escaping claude.exe applies); the VIDAR_OPEN_URL_LOG hook is set in every case, so no browser
// is ever started.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const spawn = require("cross-spawn");
const here = dirname(fileURLToPath(import.meta.url));
const opener = join(here, "..", "tools", "bare", "open-url.cmd");
const pwshDir = dirname(execFileSync("where.exe", ["pwsh.exe"], { encoding: "utf8" }).split(/\r?\n/)[0]);

function run(args, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-url-"));
  const log = join(dir, "opened.txt");
  const sys = process.env.SystemRoot || "C:\\Windows";
  const env = { SystemRoot: sys, PATH: `${pwshDir};${sys}\\System32`, VIDAR_OPEN_URL_LOG: log, ...extra };
  assert.ok(env.VIDAR_OPEN_URL_LOG, "hook env set: the real explorer is never resolved");
  const r = spawn.sync(opener, args, { env, encoding: "utf8" });
  const logged = existsSync(log) ? readFileSync(log, "utf8") : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, logged, stderr: r.stderr };
}

/** The quoted names of a PowerShell `@( ... )` list that opens on the line matching `opener`. */
function psList(file, opener) {
  const src = readFileSync(join(here, "..", file), "utf8");
  const start = src.search(opener);
  assert.ok(start >= 0, `${file}: list not found`);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\s*\)/);
  assert.ok(end > 0, `${file}: list not closed`);
  return [...rest.slice(0, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test("the system-name list matches tools/release/clean-env.ps1 (not shipped, so copied)", {
  skip: existsSync(join(here, "..", "tools", "release", "clean-env.ps1")) ? false : "tools/release/clean-env.ps1 is not in this tree (not shipped)",
}, () => {
  const ours = psList("tools/bare/open-url.ps1", /\$systemNames = @\(/);
  const theirs = psList("tools/release/clean-env.ps1", /\$script:CleanEnvSystemNames = @\(/);
  assert.ok(ours.length > 10, ours.join(","));
  assert.deepEqual(ours, theirs);
});

test("an unreadable logon profile opens nothing and prints the URL to stderr", () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
  const r = run([url], { VIDAR_OPEN_URL_NO_VOLATILE: "1" });
  assert.equal(r.status, 3);
  assert.equal(r.logged, null);
  assert.ok(r.stderr.split(/\r?\n/).includes(url), r.stderr);
});

test("an OAuth-shaped URL survives byte-exact", () => {
  const url = "https://mcp.example.com/authorize?response_type=code&client_id=a.b&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&scope=x%20y&state=a^b!c;d=e,f(g)#frag";
  const r = run([url]);
  assert.equal(r.status, 0);
  assert.equal(r.logged, url);
});

test("a Claude sign-in shaped URL keeps every & parameter through to state, the last", () => {
  // The shape claude auth login hands BROWSER (2026-10-21, ~450 characters): fake values, same order.
  const scope = "org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins";
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code"
    + `&redirect_uri=http%3A%2F%2Flocalhost%3A54274%2Fcallback&scope=${scope}`
    + `&code_challenge=${"C".repeat(43)}&code_challenge_method=S256&state=${"S".repeat(43)}`;
  assert.ok(url.length > 400);
  const r = run([url]);
  assert.equal(r.status, 0);
  assert.equal(r.logged, url);
  assert.ok(r.logged.endsWith(`&state=${"S".repeat(43)}`));
});

test("the opener hands the URL to ShellExecute, never explorer.exe's command line", () => {
  const src = readFileSync(join(here, "..", "tools", "bare", "open-url.ps1"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.ok(!/explorer\.exe/i.test(code), "explorer.exe drops the state parameter of a long URL");
  assert.match(code, /ProcessStartInfo\]::new\(\$url\)/);
  assert.match(code, /UseShellExecute = \$true/);
});

test("a localhost http URL passes", () => {
  const r = run(["http://localhost:3118/x"]);
  assert.equal(r.status, 0);
  assert.equal(r.logged, "http://localhost:3118/x");
});

for (const bad of [
  "file:///C:/Windows/System32/calc.exe",
  "C:\\Windows\\System32\\calc.exe",
  "javascript:alert(1)",
  "ms-settings:",
  'https://a.example/"x',
  "https://a.example/a b",
]) {
  test(`refused: ${bad}`, () => {
    const r = run([bad]);
    assert.equal(r.status, 1);
    assert.equal(r.logged, null);
  });
}

test("no argument exits 2", () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.equal(r.logged, null);
});
