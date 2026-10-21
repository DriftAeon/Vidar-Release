// file:line links in terminal tabs: a link provider that finds Windows source paths across
// wrapped rows and opens them in the editor (Rider) through open_in_editor.
import type { ILink, Terminal } from "@xterm/xterm";
import { invoke } from "../../ipc";
import { showSessionsToast } from "./zoom";

/* ---- file:line links -> Rider ---- */

// Path body excludes ':' entirely (kills NTFS ADS by construction); drive
// letter mandatory (kills UNC / NTLM-leak paths). Rust re-validates all of it.
const FILE_LINK_RE =
  /([A-Za-z]:\\[^:<>|?*"\r\n]+?\.(?:c|cc|cpp|h|hpp|inl|cs|usf|ush|ini|txt|md|json|ts|tsx|js|rs|py|toml|yaml|yml|xml|log|csv))(?:\((\d+)(?:,\d+)?\)|:(\d+))/g;

const MAX_SCAN_CHARS = 2048;

export function registerFileLinks(term: Terminal) {
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      callback(computeFileLinks(term, bufferLineNumber));
    },
  });
}

// UE paths wrap constantly at terminal widths: reconstruct the full logical
// line across wrapped rows (the in-tree WebLinkProvider pattern), scan once,
// then map string offsets back to buffer coordinates.
function computeFileLinks(term: Terminal, bufferLineNumber: number): ILink[] | undefined {
  const buf = term.buffer.active;
  const cols = term.cols;
  let first = bufferLineNumber - 1; // to 0-based
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;

  let text = "";
  let idx = first;
  while (idx < buf.length && text.length < MAX_SCAN_CHARS) {
    const line = buf.getLine(idx);
    if (!line) break;
    if (idx > first && !line.isWrapped) break;
    const next = buf.getLine(idx + 1);
    const isLast = !next || !next.isWrapped;
    // non-last wrapped rows are full-width; only trim the final row
    text += line.translateToString(isLast);
    idx++;
  }

  const links: ILink[] = [];
  FILE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    const path = m[1];
    const line = parseInt(m[2] ?? m[3], 10);
    const startOff = m.index;
    const endOff = m.index + m[0].length - 1;
    links.push({
      range: {
        start: { x: (startOff % cols) + 1, y: first + Math.floor(startOff / cols) + 1 },
        end: { x: (endOff % cols) + 1, y: first + Math.floor(endOff / cols) + 1 },
      },
      text: m[0],
      activate: (ev) => {
        if (ev.button === 0) {
          invoke("open_in_editor", { path, line }).catch((e) =>
            showSessionsToast(`Can't Open In Editor: ${String(e)}`, 6000),
          );
        }
      },
    });
  }
  return links.length ? links : undefined;
}
