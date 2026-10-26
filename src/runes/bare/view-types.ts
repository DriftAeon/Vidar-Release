// Card helpers share this vault-derived shape.
import type { BareActiveLibrary } from "./flow";
export type ViewLib = BareActiveLibrary & { onDemand?: BareActiveLibrary["bricks"] };
