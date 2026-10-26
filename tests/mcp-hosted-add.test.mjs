// tools/mcp/hosted-add.ps1 against fake claude/codex shims. Each case builds its env from scratch
// (never process.env): a shim dir first on PATH, temp profile folders, no real CLI or config home.
// The shim logs argv and the two config-home vars; a preflight asserts both CLIs resolve to the shim.
// Skips without pwsh like the other pwsh-backed tests.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasPwsh, plain } from "./lib/vendor-fence-rig.mjs";
import { AGENT_HOMES_REL, installRootKey } from "../tools/lib/agent-env.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = fileURLToPath(new URL("../tools/mcp/hosted-add.ps1", import.meta.url));
const skip = hasPwsh ? false : "needs pwsh on Windows";
const pwshExe = hasPwsh
  ? spawnSync("pwsh", ["-NoProfile", "-Command", "(Get-Command pwsh).Source"], { encoding: "utf8" }).stdout.trim()
  : "";

const SHIM_JS = `
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const [cli, ...argv] = process.argv.slice(2);
appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ cli, argv, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null }) + "\\n");
const isAdd = argv[0] === "mcp" && argv[1] === "add";
process.exit(isAdd && existsSync(join(dir, "fail-add")) ? 1 : 0);
`;

const URLS = {
  notion: "https://mcp.notion.com/mcp",
  slack: "https://mcp.slack.com/mcp",
  atlassian: "https://mcp.atlassian.com/v2/mcp",
};
const SLACK_ARGS = ["mcp", "add", "-s", "user", "-t", "http", "--client-id", "1601185624273.8899143856786", "--callback-port", "3118", "slack", URLS.slack];
const claudeAdd = (name) => ["mcp", "add", "-s", "user", "-t", "http", name, URLS[name]];

function rig() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "vidar-hosted-mcp-")));
  const dirs = Object.fromEntries(["shim", "profile", "appdata", "local", "codex"].map((d) => [d, join(base, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.shim, "shim.mjs"), SHIM_JS);
  for (const cli of ["claude", "codex"]) {
    // A .ps1 shim: a .cmd shim would re-parse quotes and CMD metacharacters in argv, which a native claude does not.
    writeFileSync(join(dirs.shim, `${cli}.ps1`), `& node "$PSScriptRoot\\shim.mjs" ${cli} @args\r\nexit $LASTEXITCODE\r\n`);
  }
  const baseEnv = {
    SystemRoot: process.env.SystemRoot,
    PATHEXT: ".COM;.EXE;.BAT;.CMD", // without it pwsh does not resolve the .cmd shims
    PATH: [dirs.shim, dirname(process.execPath), dirname(pwshExe)].join(";"),
    USERPROFILE: dirs.profile,
    HOME: dirs.profile,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.local,
    CODEX_HOME: dirs.codex,
    HOSTED_ADD_LOCALAPPDATA: dirs.local, // test-only: stands in for the known folder
  };
  // Async so cases overlap; resolves {status, stdout, stderr} like spawnSync (stdin closed, as spawnSync's was).
  const spawn = (args, env) =>
    new Promise((res, rej) => {
      const c = spawnChild(pwshExe, ["-NoProfile", "-NonInteractive", ...args], { env, cwd: base, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      c.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      c.on("error", rej);
      c.on("close", (status) => res({ status, stdout, stderr }));
    });
  const run = async (scriptArgs, extraEnv = {}) => {
    const env = { ...baseEnv, ...extraEnv };
    const pre = await spawn(["-Command", "(Get-Command claude).Source; (Get-Command codex).Source"], env);
    const sources = pre.stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(sources.length, 2, `preflight: ${plain(pre)}`);
    for (const s of sources) assert.ok(s.toLowerCase().startsWith(dirs.shim.toLowerCase()), `CLI resolves outside the shim dir: ${s}`);
    const r = await spawn(["-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...scriptArgs], env);
    return { ...r, text: plain(r), log: readLog() };
  };
  const readLog = () => {
    const f = join(dirs.shim, "log.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const bareHome = join(dirs.local, ...AGENT_HOMES_REL, installRootKey(ROOT), "claude-config");
  return { base, dirs, run, bareHome, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Each case owns its rig (temp dir, shim, env), so they share nothing; the cases only compete for CPU
// (two pwsh starts per run, ~0.7 s each). 8 keeps the pwsh starts from thrashing a typical 8-16 thread box.
const cases = [];
const withRig = (name, fn) => cases.push({ name, fn });

withRig("claude default: all three servers get the vendor argv, CLAUDE_CONFIG_DIR stays unset", async (r) => {
  const res = await r.run(["-Agent", "claude"]);
  assert.equal(res.status, 0, res.text);
  assert.deepEqual(res.log.map((l) => [l.cli, ...l.argv]), [
    ["claude", ...claudeAdd("notion")],
    ["claude", ...SLACK_ARGS],
    ["claude", ...claudeAdd("atlassian")],
  ]);
  assert.ok(res.log.every((l) => l.CLAUDE_CONFIG_DIR === null));
  assert.match(res.text, /Target: .*\(claude\)/);
  assert.match(res.text, /Open a new Raw Claude tab, run \/mcp, then Authenticate each\./);
});

withRig("claude: -Port sets the callback port on a single server, and is refused with all or slack", async (r) => {
  const ok = await r.run(["-Agent", "claude", "-Server", "notion", "-Port", "8080"]);
  assert.equal(ok.status, 0, ok.text);
  assert.deepEqual(ok.log[0].argv, ["mcp", "add", "-s", "user", "-t", "http", "--callback-port", "8080", "notion", URLS.notion]);
  assert.equal((await r.run(["-Agent", "claude", "-Port", "8080"])).status, 2);
  assert.equal((await r.run(["-Agent", "claude", "-Server", "slack", "-Port", "8080"])).status, 2);
  assert.equal((await r.run(["-Agent", "codex", "-Server", "notion", "-Port", "8080"])).status, 2);
  assert.equal((await r.run(["-Agent", "claude", "-Server", "notion", "-WhatIf"])).log.length, 1, "refusals ran no CLI; only the first case logged");
});

withRig("claude bare: refuses every server before resolving a home or invoking the CLI", async (r) => {
  for (const server of ["all", "notion", "slack", "atlassian"]) {
    const res = await r.run(["-Agent", "claude", "-Home", "bare", "-Server", server], {
      HOSTED_ADD_LOCALAPPDATA: "",
      CLAUDE_CONFIG_DIR: r.bareHome,
    });
    assert.equal(res.status, 2, res.text);
    assert.match(res.text, /module MCP is ticked per rune set in the Runes tab/);
    assert.doesNotMatch(res.text, /Target:/);
    assert.equal(res.log.length, 0);
  }
});

withRig("codex: -Force refuses and runs nothing", async (r) => {
  const res = await r.run(["-Agent", "codex", "-Force"]);
  assert.equal(res.status, 2);
  assert.match(res.text, /-Force is Claude only\./);
  assert.equal(res.log.length, 0);
});

withRig("codex: a multi-line string in config.toml refuses as ambiguous", async (r) => {
  for (const q of ["'''", '"""']) {
    writeFileSync(join(r.dirs.codex, "config.toml"), `note = ${q}\n[mcp_servers.notion]\n${q}\n`);
    const res = await r.run(["-Agent", "codex"]);
    assert.equal(res.status, 2, res.text);
    assert.match(res.text, /notion: can't tell if notion exists; check config\.toml/);
    assert.equal(res.log.length, 0);
  }
});

withRig("refuses a Bare/profile env: claude default, codex, and codex -Home bare", async (r) => {
  for (const extra of [{ VIDAR_AGENT_HOME: r.dirs.local }, { CLAUDE_CONFIG_DIR: r.dirs.local }]) {
    const res = await r.run(["-Agent", "claude"], extra);
    assert.equal(res.status, 2, res.text);
    assert.match(res.text, /VIDAR_AGENT_HOME or CLAUDE_CONFIG_DIR is set/);
  }
  const codex = await r.run(["-Agent", "codex"], { VIDAR_AGENT_HOME: r.dirs.local });
  assert.equal(codex.status, 2);
  assert.match(codex.text, /VIDAR_AGENT_HOME is set/);
  const bare = await r.run(["-Agent", "codex", "-Home", "bare"], { VIDAR_AGENT_HOME: r.dirs.local });
  assert.equal(bare.status, 2);
  assert.match(bare.text, /VIDAR_AGENT_HOME is .*not this install's Bare home/);
  assert.equal(bare.log.length, 0);
});

// The rig sets CODEX_HOME to a foreign dir; a plain terminal for Bare has none.
const NOCH = { CODEX_HOME: "" };

withRig("codex bare: login uses legacy CODEX_HOME from a combination tab, never adds", async (r) => {
  const home = join(dirname(r.bareHome), "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'mcp_oauth_credentials_store = "file"\n');
  const combo = join(dirname(r.bareHome), "codex-homes", "abcdef012345");
  mkdirSync(combo, { recursive: true });
  writeFileSync(join(combo, "config.toml"), "# per-set home must not be used for login\n");
  const res = await r.run(["-Agent", "codex", "-Home", "bare", "-Server", "notion"], {
    CODEX_HOME: combo,
    VIDAR_AGENT_HOME: combo,
  });
  assert.equal(res.status, 0, res.text);
  assert.deepEqual(res.log.map((l) => [l.cli, ...l.argv]), [["codex", "-c", `mcp_servers.notion.url="${URLS.notion}"`, "mcp", "login", "notion"]]);
  assert.equal(res.log[0].CODEX_HOME.toLowerCase(), home.toLowerCase());
  assert.ok(!res.log.some((l) => l.argv.includes("add")));
  assert.match(res.text, /Codex Bare login uses the legacy codex-home\./);
  assert.match(res.text, /Tokens stay in the legacy codex-home\./);
  const wi = await r.run(["-Agent", "codex", "-Home", "bare", "-Server", "notion", "-WhatIf"], NOCH);
  assert.equal(wi.status, 0, wi.text);
  assert.equal(wi.log.length, 1, "-WhatIf ran no CLI");
  assert.match(wi.text, /WhatIf: codex -c mcp_servers\.notion\.url=.* mcp login notion/);
});

withRig("codex bare: missing legacy config and slack refuse", async (r) => {
  const home = join(dirname(r.bareHome), "codex-home");
  mkdirSync(home, { recursive: true });
  const noFile = await r.run(["-Agent", "codex", "-Home", "bare", "-Server", "notion"], NOCH);
  assert.equal(noFile.status, 2, noFile.text);
  assert.match(noFile.text, /No legacy Codex Bare config at .*Open a Codex Bare tab once first\./);
  const slack = await r.run(["-Agent", "codex", "-Home", "bare", "-Server", "slack"], NOCH);
  assert.equal(slack.status, 2, slack.text);
  assert.match(slack.text, /slack is manual only for Codex; see docs\/reference\/hosted-mcp\.md/);
  assert.equal(slack.log.length, 0);
  assert.equal(noFile.log.length, 0);
});

withRig("-WhatIf prints every command and calls no CLI", async (r) => {
  const res = await r.run(["-Agent", "claude", "-WhatIf"]);
  assert.equal(res.status, 0, res.text);
  assert.equal(res.log.length, 0);
  assert.equal((res.text.match(/^WhatIf: claude mcp add /gm) ?? []).length, 3);
  assert.match(res.text, /WhatIf: nothing was run\./);
  const codex = await r.run(["-Agent", "codex", "-WhatIf"]);
  assert.equal(codex.status, 0, codex.text);
  assert.equal(codex.log.length, 0);
  assert.equal((codex.text.match(/^WhatIf: codex mcp add /gm) ?? []).length, 2);
});

withRig("claude: an existing entry is skipped; -Force removes then adds", async (r) => {
  writeFileSync(join(r.dirs.profile, ".claude.json"), JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://old.example/mcp" } } }));
  const skipRun = await r.run(["-Agent", "claude"]);
  assert.equal(skipRun.status, 0, skipRun.text);
  assert.match(skipRun.text, /notion: already in .*skipped \(-Force replaces it\)\./);
  assert.deepEqual(skipRun.log.map((l) => l.argv.at(-2)), ["slack", "atlassian"]);

  const force = await r.run(["-Agent", "claude", "-Server", "notion", "-Force"]);
  assert.equal(force.status, 0, force.text);
  assert.deepEqual(force.log.slice(2).map((l) => l.argv), [["mcp", "remove", "-s", "user", "notion"], claudeAdd("notion")]);
});

withRig("claude -Force: a failed add restores the old entry through add-json and exits non-zero", async (r) => {
  const old = { type: "http", url: "https://old.example/mcp", headers: { "X-Test": 'a "quoted" value' } };
  writeFileSync(join(r.dirs.profile, ".claude.json"), JSON.stringify({ mcpServers: { notion: old } }));
  writeFileSync(join(r.dirs.shim, "fail-add"), "");
  const res = await r.run(["-Agent", "claude", "-Server", "notion", "-Force"]);
  assert.notEqual(res.status, 0);
  assert.deepEqual(res.log.map((l) => l.argv.slice(0, 2).join(" ")), ["mcp remove", "mcp add", "mcp add-json"]);
  const restore = res.log[2].argv;
  assert.deepEqual(restore.slice(0, 5), ["mcp", "add-json", "-s", "user", "notion"]);
  assert.deepEqual(JSON.parse(restore[5]), old);
  assert.match(res.text, /previous entry restored\./);
  assert.ok(!res.text.includes("old.example"), "the saved entry is not echoed");
});

withRig("claude -Force: restore keeps CMD metacharacters in the saved entry intact", async (r) => {
  const old = { type: "http", url: "https://old.example/mcp?a=1&b=2", headers: { "X-Test": 'a|b ^c %PATH% "q" & echo hi' } };
  writeFileSync(join(r.dirs.profile, ".claude.json"), JSON.stringify({ mcpServers: { notion: old } }));
  writeFileSync(join(r.dirs.shim, "fail-add"), "");
  const res = await r.run(["-Agent", "claude", "-Server", "notion", "-Force"]);
  assert.notEqual(res.status, 0);
  assert.deepEqual(JSON.parse(res.log[2].argv[5]), old);
  assert.match(res.text, /previous entry restored\./);
});

withRig("codex: all adds notion and atlassian only; slack is skipped with a pointer", async (r) => {
  const res = await r.run(["-Agent", "codex"]);
  assert.equal(res.status, 0, res.text);
  assert.deepEqual(res.log.map((l) => [l.cli, ...l.argv]), [
    ["codex", "mcp", "add", "notion", "--url", URLS.notion],
    ["codex", "mcp", "add", "atlassian", "--url", URLS.atlassian],
  ]);
  assert.ok(res.log.every((l) => l.CODEX_HOME === r.dirs.codex));
  assert.match(res.text, /Target: .*\(codex\)/);
  assert.match(res.text, /slack: not added for Codex; see docs\/reference\/hosted-mcp\.md \(Codex Slack\)\./);
});

withRig("codex: -Server slack refuses and runs nothing", async (r) => {
  const res = await r.run(["-Agent", "codex", "-Server", "slack"]);
  assert.equal(res.status, 2);
  assert.match(res.text, /Slack on Codex is manual only; see docs\/reference\/hosted-mcp\.md \(Codex Slack\)\./);
  assert.equal(res.log.length, 0);
});

withRig("codex: an existing [mcp_servers.<name>] header is skipped, never removed", async (r) => {
  writeFileSync(join(r.dirs.codex, "config.toml"), 'model = "x"\n\n[ mcp_servers . "notion" ]\nurl = "https://old.example/mcp"\n\n[mcp_servers.other]\nurl = "https://o.example"\n');
  const res = await r.run(["-Agent", "codex"]);
  assert.equal(res.status, 0, res.text);
  assert.match(res.text, /notion: already in .*run codex mcp remove notion first\./);
  assert.deepEqual(res.log.map((l) => l.argv[2]).slice(-1), ["atlassian"]);
  assert.ok(!(await r.run(["-Agent", "codex"])).log.some((l) => l.argv[0] === "mcp" && l.argv[1] === "remove"));
});

withRig("codex: an unreadable mcp_servers form (inline table, dotted keys) refuses", async (r) => {
  const forms = {
    inline: 'mcp_servers = { notion = { url = "https://x" } }\n',
    dotted: 'mcp_servers.notion.url = "https://x"\n',
    table: '[mcp_servers]\nnotion = { url = "https://x" }\n',
  };
  for (const [form, text] of Object.entries(forms)) {
    writeFileSync(join(r.dirs.codex, "config.toml"), text);
    const res = await r.run(["-Agent", "codex"]);
    assert.equal(res.status, 2, `${form}: ${res.text}`);
    assert.match(res.text, /notion: can't tell if notion exists; check config\.toml/);
    assert.equal(res.log.length, 0, form);
  }
  writeFileSync(join(r.dirs.codex, "config.toml"), '# mcp_servers live below\n[mcp_servers.other]\nurl = "https://o.example"\n');
  assert.equal((await r.run(["-Agent", "codex", "-WhatIf"])).status, 0);
});

describe("hosted-add.ps1", { concurrency: 8 }, () => {
  for (const { name, fn } of cases) {
    test(name, { skip }, async () => {
      const r = rig();
      try {
        await fn(r);
      } finally {
        r.cleanup();
      }
    });
  }
});

test("the script file is UTF-8 without a BOM", () => {
  const bytes = readFileSync(SCRIPT);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(pathToFileURL(SCRIPT).href.endsWith("hosted-add.ps1"));
});
