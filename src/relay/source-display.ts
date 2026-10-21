// Display-gate files as Relay items: a request-id file with no current decision is pending.

import { invoke, listen } from "../ipc";
import { hasRequestId, readDisplayDecision, saveDisplayDecision } from "../panels/display-decision";
import { shownName } from "../panels/display-name";
import { setItems, type RelayItem, type RelayVerdict } from "./store";


const SOURCE = "display";
let latest = 0;

function titleOf(path: string): string {
  const name = path.split("\\").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return shownName(stem.replace(/-[0-9a-f]{8}$/, "") + ext);
}

type ListedFile = Awaited<ReturnType<typeof listFiles>>[number];
const listFiles = async () => (await invoke("list_display")).files;

function itemFor(f: ListedFile, error?: string): RelayItem {
  const item: RelayItem = {
    id: f.path,
    kind: "display",
    source: SOURCE,
    title: titleOf(f.path),
    sinceMs: f.mtime_ms,
    view: { type: "display", path: f.path, fileKind: f.kind as "png" | "svg" | "html", mtimeMs: f.mtime_ms },
    async resolve(v: RelayVerdict) {
      if (!v.binding) throw new Error("no binding");
      if (v.binding.path !== f.path) throw new Error("binding is for another file");
      await saveDisplayDecision(f.path, v.binding.sha256, v.verdict, v.comment);
      await refresh();
    },
  };
  if (error !== undefined) item.error = error;
  return item;
}

export async function refresh(): Promise<void> {
  const gen = ++latest;
  const files = await listFiles();
  const out: RelayItem[] = [];
  for (const f of files) {
    if (!hasRequestId(f.path)) continue;
    try {
      const d = await readDisplayDecision(f.path);
      if (d === null || !d.current) out.push(itemFor(f));
    } catch (e) {
      out.push(itemFor(f, e instanceof Error ? e.message : String(e)));
    }
  }
  if (gen !== latest) return;
  setItems(SOURCE, out);
}

export function startDisplaySource(): void {
  void listen("display-update", () => { void refresh(); });
  void refresh();
}
