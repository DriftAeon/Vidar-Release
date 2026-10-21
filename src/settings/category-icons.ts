// Settings category id → rail icon. Ids without an entry get an empty slot.

import type { ColorIcon } from "../icon-img";

export const CATEGORY_ICONS: Readonly<Record<string, ColorIcon>> = {
  all: "set-all",
  workspaces: "set-workspaces",
  characters: "set-characters",
  agents: "set-agents",
  keybinds: "set-keybinds",
  audio: "set-audio",
  dependencies: "set-dependencies",
  general: "set-general",
  cards: "set-cards",
  flow: "flow",
  modules: "set-all",
  build: "set-build",
};
