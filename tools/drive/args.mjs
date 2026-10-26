// Flag parser for the verbs that take `--flag value` / `--flag` after their positionals.
// Positionals are the leading tokens up to the first `--` token; a flag takes the next token as
// its value unless that is absent or another flag (then it is `true`). Existing verbs read
// positionals straight from argv and ignore flags.
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  let i = 0;
  while (i < argv.length && !argv[i].startsWith("--")) positionals.push(argv[i++]);
  while (i < argv.length) {
    const tok = argv[i++];
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2);
    if (i < argv.length && !argv[i].startsWith("--")) flags[name] = argv[i++];
    else flags[name] = true;
  }
  return { positionals, flags };
}
