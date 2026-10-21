// The app's hosted-name store: hosted-names.ts over the `rendered.hostedNames` pref.
import { getPref, setPref } from "../prefs";
import { createHostedNames } from "./hosted-names";

export const hostedNames = createHostedNames({
  get: () => getPref("rendered.hostedNames"),
  set: (m) => { setPref("rendered.hostedNames", m); },
});
