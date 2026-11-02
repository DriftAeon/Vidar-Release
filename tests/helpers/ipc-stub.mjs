// IPC stub factory for src/ipc imports in jsdom tests: returns the source of a data: module that
// answers invoke() from globalThis.__domMount.answers (a value, or a function of the args), records every
// call in .invoked, and captures listen() handlers in .listeners. A command with no answer rejects, or
// resolves null with { unstubbed: "null" }. dom-mount.mjs owns globalThis.__domMount (setupDom).
export function ipcStubSource({ unstubbed = "reject" } = {}) {
  const miss = unstubbed === "null" ? "Promise.resolve(null)" : `Promise.reject(new Error("unstubbed invoke: " + cmd))`;
  return `export function invoke(cmd, args) {
    const h = globalThis.__domMount; h.invoked.push(cmd);
    if (Object.hasOwn(h.answers, cmd)) { const a = h.answers[cmd]; return Promise.resolve(typeof a === "function" ? a(args) : a); }
    return ${miss};
  }
  export function listen(ev, cb) { const h = globalThis.__domMount; h.invoked.push("listen:" + ev); h.listeners[ev] = cb; return Promise.resolve(() => {}); }`;
}
