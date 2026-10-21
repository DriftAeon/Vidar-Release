// Workbench bridge: publish what the Document tab has open so a tab can read the
// same file the user is looking at. Path only, and only when the open document
// CHANGES.
//
// Deliberately no dirty flag: `draft` is set on every input event, so publishing
// it would mean one atomic write plus an fsync per keystroke. A consumer that
// cares whether the file moved can compare its mtime, and a dirty flag would not
// have protected it from reading a half-saved file anyway.

import { invoke } from "../ipc";

export function publishDocument(doc: { path: string; name: string } | null) {
  if (!doc) return void invoke("delete_workbench_entry", { name: "document" }).catch(() => {});
  const entry = { name: "document", kind: "document", path: doc.path, title: doc.name };
  void invoke("write_workbench_entry", { name: "document", json: JSON.stringify(entry) }).catch(() => {});
}
