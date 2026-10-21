import contract from "../../contracts/modules.json" with { type: "json" };
import { defineModuleRegistry, type ModuleDecl } from "../modules/types";
import type { ColorIcon } from "../icon-img";

const SURFACES = (contract.core as ModuleDecl[])
  .filter((entry) => entry.kind === "surface" && entry.surface?.placement === "workbench")
  .sort((a, b) => (a.surface?.order ?? 0) - (b.surface?.order ?? 0));

/** Workbench surfaces that declare an `icon` in the contract (Jira, Notion, Slack): id to icon, then id to label. */
export const SURFACE_ICONS: Record<string, ColorIcon> = Object.fromEntries(
  SURFACES.filter((entry) => entry.surface?.icon).map((entry) => [entry.id, entry.surface!.icon as ColorIcon]),
);
export const SURFACE_LABELS: string[] = SURFACES.filter((entry) => entry.surface?.icon).map((entry) => entry.label);

/** Optional workbench tabs in button order; the workbench mounts each one that is not switched off. */
export const OPTIONAL_SURFACE_IDS: string[] = SURFACES.filter((entry) => entry.level === "optional").map((entry) => entry.id);

/** Core contract supplies bench metadata; workbench.ts owns view wiring and selection. */
export const WORKBENCH_MODULES = defineModuleRegistry(
  (contract.core as ModuleDecl[])
    .filter((entry) => entry.kind === "surface" && entry.surface?.placement === "workbench")
    .sort((a, b) => (a.surface?.order ?? 0) - (b.surface?.order ?? 0))
    .map(({ id, label, level }) => ({ id: id as ColorIcon, label, level })),
);
