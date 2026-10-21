// Driver Mode for a bare Falcon session (the launcher's Falcon row): reads/writes the truth file
// through Rust (driver_mode.rs, the file tools\falcon\driver-mode.ps1 shares).
import { invoke } from "../../ipc";

/** Driver Mode state for a bare Falcon session (a Jettisoned one has no tab); false when unreadable. */
export const readDriverOn = (session: string) => invoke("driver_mode_get", { session }).catch(() => false);

/** Set Driver Mode for a bare Falcon session. */
export const setDriverOn = (session: string, on: boolean) => invoke("driver_mode_set", { session, on });
