// Kokoro ownership is a cross-language
// contract carried by the lifecycle token {owner} (contracts/voice-slots.json lifecycle.owner).
// speak.rs passes it to every speak.py spawn as --owner and fills it into the tts slot's own
// stop/status; speak.py hands its --owner to the tts adapter as {owner} (it no longer reads
// KOKORO_OWNER); the stock tts manifests put {owner} in every command; tts_kokoro.py tags the
// warm process with it. A link that drops the owner leaves a warm process the launch stop
// (src/capabilities/stops/speak.ts) can never end, or ends one a terminal owns.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const count = (text, needle) => text.split(needle).length - 1;

test("{owner} reaches the tts adapter process from speak.rs, directly and through speak.py", () => {
  const owner = JSON.parse(read("contracts/voice-slots.json")).lifecycle.owner;
  const rs = read("src-tauri/src/speak.rs");
  assert.match(rs, new RegExp(`const OWNER: &str = "${owner}";`), "speak.rs OWNER is not the contract's lifecycle.owner");
  const spawns = count(rs, "Command::new(crate::paths::local_voice_python())");
  assert.ok(spawns > 0, "no speak.py spawn found in speak.rs");
  assert.equal(count(rs, '"--owner", OWNER'), spawns, "a speak.py spawn does not pass --owner OWNER");
  assert.match(rs, /\.replace\("\{owner\}", OWNER\)/, "speak.rs does not fill {owner} in the tts stop/status");
  assert.doesNotMatch(rs, /KOKORO_OWNER/);

  const py = read("content/local-voice/speak.py");
  assert.match(py, /ap\.add_argument\("--owner"/);
  assert.match(py, /"owner": owner/, "speak.py does not put its --owner into the tts tokens");
  assert.doesNotMatch(py, /KOKORO_OWNER/);

  const pack = JSON.parse(read("content/packs/voice-stock/pack.json"));
  assert.ok(pack.slots.tts.length > 0, "the stock pack lists no tts adapter");
  for (const file of pack.slots.tts) {
    const m = JSON.parse(read(`content/packs/voice-stock/${file}`));
    for (const k of ["run", "warm", "stop", "status"]) {
      if (!m[k]) continue;
      const args = m[k].args;
      assert.equal(args[args.indexOf("--owner") + 1], "{owner}", `${file} ${k} does not pass --owner {owner}`);
    }
  }
  const adapter = read("content/local-voice/tts_kokoro.py");
  assert.match(adapter, /"--owner", args\.owner/, "tts_kokoro.py does not tag the warm process with --owner");
});
