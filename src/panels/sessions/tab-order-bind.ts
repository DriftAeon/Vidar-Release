// Runtime wiring for the pure tab-order calculation and saved strip order.
import { getPref, setPref } from "../../prefs";
import { moveTabFamily } from "./tab-agents";
import { bindTabOrder, placeRestoredTab, saveTabOrder } from "./tab-order";
import type { TerminalSession } from "./types";

export { placeRestoredTab, saveTabOrder };

export function bindSessionTabOrder(sessions: ReadonlyMap<string, TerminalSession>, orderedIds: () => string[]): void {
  bindTabOrder({
    sessions, orderedIds,
    moveBefore: (id, before) => {
      const button = sessions.get(id)?.button;
      if (button) moveTabFamily(button, before ? sessions.get(before)?.button ?? null : null);
    },
    read: () => getPref("rendered.tabOrder"),
    write: (order) => { setPref("rendered.tabOrder", order); },
  });
}
