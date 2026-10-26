// Gate fixture hook (tests/fixtures/rune-vault): allows every call. GATE-HOOK-GATE-HOOK-RUN
// Usage: node gate-hook-run.mjs < hook-input.json
// Refuses nothing; never reads or writes files.
process.stdout.write("{}");
