// The git-setup prompt the Changes pane types into the focused tab for a folder that is not a repo.
// One line on purpose: a newline typed into a terminal tab would submit it.
// @ts-ignore TS5097: node --test loads this module directly
import { cleanSend } from "../browser/send.ts";

export function gitInitPrompt(cwd: string): string {
  const dir = cleanSend(cwd, Infinity).trim();
  const where = dir ? ` in ${dir}` : "";
  return `Set up git${where}: run git init, add a .gitignore that fits what is in this folder, stage everything, and make an initial commit. Show me the file list before committing, and ask before adding a remote or pushing.`;
}
