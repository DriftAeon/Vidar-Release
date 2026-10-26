// open, send, answer, state, shortcut, paste, card: the verbs that call window.__vidarDrive.
// openArg, pasteArg and cardOpts are parsed before the budget step by vidar-drive.mjs.

export const open = ({ openArg, evalJs }) =>
  evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.openTab(${JSON.stringify(openArg)}); })()`);

export const send = ({ a1, a2, evalJs, q }) =>
  evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.send(${q(a1)}, ${q(a2)}); })()`);

export async function answer({ a1, a2, evalJs, q, attestSandbox }) {
  await attestSandbox();
  return evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.answer(${q(a1)}, ${a2}); })()`);
}

export const state = ({ evalJs }) =>
  evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.state(); })()`);

export const shortcut = ({ a1, evalJs, q }) =>
  evalJs(`(() => { if (!window.__vidarDrive?.shortcut) throw new Error("no __vidarDrive.shortcut — old build?"); return window.__vidarDrive.shortcut(${q(a1)}); })()`);

export const paste = ({ a1, pasteArg, evalJs, q }) =>
  evalJs(`(() => { if (!window.__vidarDrive?.paste) throw new Error("no __vidarDrive.paste — old build?"); return window.__vidarDrive.paste(${q(a1)}, ${JSON.stringify(pasteArg)}); })()`);

export async function card({ a1, a2, cardOpts, evalJs, q, attestSandbox }) {
  await attestSandbox();
  return evalJs(`(() => { if (!window.__vidarDrive?.card) throw new Error("no __vidarDrive.card — old build?"); return window.__vidarDrive.card(${q(a1)}, ${q(a2)}, ${cardOpts ?? "{}"}); })()`);
}
