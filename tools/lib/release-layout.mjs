// Repo folders the release tooling reads, resolved through the paths contract (contracts/paths.json)
// so tools/release/*.mjs carry no layout literals (tests/paths-contract.test.mjs).
import { join } from "node:path";
import { rel, resolve } from "./paths.mjs";

/** content/packs under `root`. */
export const packsDir = (root) => resolve("packs", { root });

/** tools/release under `root`: build sets, ship-list, trace allow list. */
export const releaseDir = (root) => join(resolve("tools", { root }), "release");

/** The docs folder's repo-relative prefix, with a trailing slash. */
export const docsPrefix = () => `${rel("docs")}/`;
