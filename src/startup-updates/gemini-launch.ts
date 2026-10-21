// Gemini's detached npm updater lacks windowsHide (installed 0.63.0 source).
// A Node preload travels through Gemini's relaunch and hides its detached child windows only;
// attached children (its shell tools) keep their normal console behaviour.
export const GEMINI_HIDDEN_PRELOAD = `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
const hide = (o) => o && o.detached === true ? { ...o, windowsHide: true } : o;
cp.spawn = function(command, args, options) {
  if (Array.isArray(args) || args == null) return original.call(this, command, args, hide(options));
  return original.call(this, command, hide(args));
};
syncBuiltinESMExports();`;

const preload = `--import=data:text/javascript;base64,${btoa(GEMINI_HIDDEN_PRELOAD)}`;

/** Apply at launch so configured Gemini rows receive the same flag as built-ins. */
export function geminiHiddenArgs(args: string[] | undefined, shell?: string): string[] | undefined {
  if (!args) return args;
  if (shell && !/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) return args;
  const index = args.findIndex((arg) => /^-(command|c)$/i.test(arg));
  if (index < 0 || !args[index + 1]) return args;
  const result = [...args];
  result[index + 1] = `$vidarGeminiNodeOptions = $env:NODE_OPTIONS; try { $env:NODE_OPTIONS = (@($vidarGeminiNodeOptions, '${preload}') | Where-Object { $_ }) -join ' '; ${args[index + 1]} } finally { $env:NODE_OPTIONS = $vidarGeminiNodeOptions }`;
  return result;
}
