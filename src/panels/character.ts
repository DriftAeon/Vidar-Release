import { invoke } from "../ipc";
import { invalidateConfig, loadConfig, onSettingsChanged } from "../config";
import { getPref, setPref } from "../prefs";
import type { CharacterRenderer } from "../character/renderer";
import type { CharacterArena } from "../character/arena";
import type { CharacterId } from "../character/catalog";
import { characterList, characterRevision, ensureCharacters, onCharactersChanged, setStyleNote } from "../character/packs";
import { resolveCharacter, type Resolution } from "../character/resolve";
import { emptyStage } from "../character/empty-stage";
import type { CharacterActivityDetail, CharacterCompletionDetail, CharacterStatusDetail } from "../character/events";
import { characterLoop, reduceLowContext } from "../character/behavior";
import { getFocusedSession, type FocusedSession } from "./sessions";
import { watchCodexModel } from "./codex-model";
import type { View } from "../character/view";
import { openPopover, type ClosePopover } from "../modules/popover";

interface SessionCharacterState {
  agent: string;
  model: string | null;
  contextUsedPercentage: number | null;
  contextFresh: boolean;
  active: boolean;
}

// Keep the Three.js chunk out of startup/terminal code until the panel loads.
export function initCharacter(
  panel: HTMLElement,
  readModel: (id: CharacterId) => Promise<ArrayBuffer> = (id) => invoke("read_character_model", { id }),
): () => void {
  const stage = panel.querySelector<HTMLElement>(".character-stage")!;
  const status = panel.querySelector<HTMLElement>(".character-status")!;
  const select = panel.querySelector<HTMLSelectElement>(".character-animation")!;
  const listeners = new AbortController();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const sessionState = new Map<string, SessionCharacterState>();
  let renderer: CharacterRenderer | undefined;
  let arena: CharacterArena | undefined;
  let loading: AbortController | undefined;
  let disposed = false;
  let focused: FocusedSession | null = null;
  // What is on stage: the resolution it came from, keyed with the catalogue revision so a
  // re-pin or edit of the same id reloads (packs.ts bumps it after every mutation).
  let character: Resolution = resolveCharacter(characterList(), { agent: getFocusedSession()?.agent ?? "" });
  let shownKey: string | null = null;
  let lowContext = false;
  let active = false;
  let manualCode: string | null = null;
  let panelVisible = true;
  // The arena (a WebGL context and the Three.js chunk) is created only once the host has been
  // on screen; a load that comes earlier waits here for the first intersection.
  let hostSeen = false;
  let loadWaiting = false;
  let listFailed = false;
  let addButton: HTMLButtonElement | undefined;
  // Per-character saved default view (vidar.json `characterViews`), loaded on first use and kept
  // in sync locally on save/delete so a reload of the same character sees its own change right
  // away. A `settings-changed` (another writer, or `reload_config`) drops it for a fresh read.
  let characterViews: Record<string, unknown> = {};
  let viewsLoaded: Promise<void> | null = null;
  const stopSettings = onSettingsChanged((e) => {
    viewsLoaded = null;
    if (e.keys.includes("characterStage")) void applyStage();
  });
  function ensureViewsLoaded(): Promise<void> {
    if (!viewsLoaded) {
      // A copy: the save/delete below edit this panel's view, not config.ts's shared memo.
      viewsLoaded = loadConfig().then((res) => { characterViews = { ...res.config.characterViews }; });
    }
    return viewsLoaded;
  }
  let viewMenu: HTMLDivElement | undefined;
  let closeMenu: ClosePopover | undefined;

  const setControls = (enabled: boolean) => { select.disabled = !enabled; };
  // "Animation Dropdown" flag (right-click menu). Off removes the select from layout, not just
  // from view; local UI preference, so vidar-state.json (prefs) rather than vidar.json.
  const applyDropdown = () => { select.hidden = getPref("character.animationDropdown") === "off"; };
  applyDropdown();
  const canAnimate = () => !reducedMotion.matches && !document.hidden && panelVisible;
  // The stage fallback note stands whenever the character has nothing to say.
  let stageNote = "";
  let lastReport = "";
  function report(message: string): void {
    lastReport = message;
    status.textContent = message || stageNote;
    status.hidden = !status.textContent;
  }
  // The arena (and its stage) exists from the host's first visible moment, character or not.
  let arenaReady: Promise<CharacterArena> | null = null;
  let stageRequest = 0;
  function ensureArena(): Promise<CharacterArena> {
    if (arena?.unavailable) { arena.dispose(); arena = undefined; arenaReady = null; }
    arenaReady ??= (async () => {
      // The pick resolves alongside the arena import, so a picked pack is the first stage drawn
      // (no default-dome flash). A failed resolve starts on the default; the note still shows.
      const request = ++stageRequest;
      const resolving = resolveStageSafe();
      const { createCharacterArena } = await import("../character/arena");
      const resolved = await resolving;
      if (disposed) {
        resolved?.factory.discard?.();
        throw new DOMException("The character panel closed.", "AbortError");
      }
      if (arena) {
        resolved?.factory.discard?.();
        void applyStage();
        return arena;
      }
      const fresh = resolved && request === stageRequest ? resolved : null;
      if (resolved && !fresh) resolved.factory.discard?.(); // a newer pick is already resolving
      arena = createCharacterArena(stage, (message) => { report(message); setControls(false); }, fresh?.factory);
      if (fresh) {
        stageNote = fresh.note ?? "";
        report(lastReport);
      } else if (!resolved) {
        void applyStage();
      }
      return arena;
    })();
    const ready = arenaReady;
    ready.catch(() => { if (arenaReady === ready) arenaReady = null; });
    return ready;
  }
  type ResolvedStage = Awaited<ReturnType<typeof import("../character/stage-pack").resolveStage>>;
  async function resolveStageSafe(): Promise<ResolvedStage | null> {
    try {
      const { resolveStage } = await import("../character/stage-pack");
      return await resolveStage();
    } catch (error) {
      console.warn("stage: resolve failed", error); // the stage on the arena stands
      return null;
    }
  }
  /** Puts the vidar.json `characterStage` pick on the arena; the newest call wins. */
  async function applyStage(): Promise<void> {
    const target = arena;
    if (!target || target.unavailable) return;
    const request = ++stageRequest;
    const resolved = await resolveStageSafe();
    if (!resolved) return;
    const { factory, note } = resolved;
    if (request !== stageRequest || disposed || arena !== target || target.unavailable) { factory.discard?.(); return; }
    target.setStage(factory);
    stageNote = note ?? "";
    report(lastReport);
  }
  function desiredCharacter(): Resolution {
    const cached = focused ? sessionState.get(focused.id) : undefined;
    return resolveCharacter(characterList(), focused ? { agent: focused.agent, model: cached?.model ?? focused.model, role: focused.role } : null);
  }
  function stageKey(res: Resolution): string {
    return `${res.id ?? ""}|${res.usable ? "ok" : res.entry?.status ?? "none"}|${characterRevision()}`;
  }
  /** Why a matched pack shows the placeholder; "" for no match (an empty stage is normal). */
  function placeholderNote(res: Resolution): string {
    if (!res.entry) return "";
    const name = res.entry.pack?.name ?? res.entry.folder;
    const what = { ok: "Could Not Load", missing: "Model Missing", changed: "Changed Since Pinned", invalid: "Pack Invalid" }[res.entry.status];
    return `${name}: ${what}. Fix It In Settings › Characters.`;
  }
  function currentModel(): string | null {
    const cached = focused ? sessionState.get(focused.id) : undefined;
    return (cached?.model ?? focused?.model) ?? null;
  }
  function applyRendererState(): void {
    if (!renderer) return;
    renderer.setPlaying(canAnimate());
    if (manualCode !== null) {
      const clip = renderer.clips.find((item) => item.name.endsWith(`_${manualCode}`))
        ?? renderer.clips.find((item) => item.name === renderer!.initialClip);
      if (clip) { select.value = clip.name; renderer.selectClip(clip.name); }
      return;
    }
    select.value = "";
    renderer.setLoop(characterLoop(active, lowContext, currentModel()));
  }
  function unload(): void {
    loading?.abort();
    loading = undefined;
    renderer?.dispose();
    renderer = undefined;
    select.replaceChildren();
    setControls(false);
    stage.setAttribute("aria-busy", "false");
  }
  /** Remove the old character immediately while retaining the arena. */
  async function load(): Promise<void> {
    if (disposed) return;
    loading?.abort();
    unload();
    if (!hostSeen) { loadWaiting = true; return; }
    const request = new AbortController();
    loading = request;
    const res = character;
    // Not usable (no match, or a matched pack that is missing, changed or invalid): the
    // placeholder is the empty arena, never a model and never a fall-through to another pack.
    const pack = res.usable ? res.entry?.pack : undefined;
    const id = res.id;
    stage.setAttribute("aria-busy", "true");
    setControls(false);
    // The model read starts now but is awaited only after the arena exists, so a read that
    // fails (file gone or changed since the list) still leaves the placeholder stage.
    const reading = pack && id ? readModel(id) : null;
    reading?.catch(() => {}); // handled below; avoids an unhandled rejection while imports load
    try {
      report(pack ? `Loading ${pack.name}…` : placeholderNote(res));
      const [{ createCharacterRenderer }, onStage] = await Promise.all([
        import("../character/renderer"), ensureArena(), ensureViewsLoaded(),
      ]);
      request.signal.throwIfAborted();
      if (!pack || !id || !reading) { onStage.render(); return; }
      let bytes: ArrayBuffer;
      try {
        bytes = await reading;
      } catch (error) {
        request.signal.throwIfAborted();
        console.warn(`character ${id}: model load failed`, error);
        onStage.render();
        report(placeholderNote(res));
        return;
      }
      request.signal.throwIfAborted();
      const created = await createCharacterRenderer(onStage, bytes, request.signal, (message) => {
        if (!request.signal.aborted) { report(message); setControls(false); }
      }, pack, characterViews[id]);
      // A newer load (another tab, or a revision bump) started while this one was in flight.
      if (request.signal.aborted || disposed || loading !== request) { created.dispose(); return; }
      setStyleNote(id, created.styleNote);
      renderer?.dispose();
      renderer = created;
      select.replaceChildren(new Option("Auto", ""));
      for (const clip of created.clips) select.add(new Option(clip.label, clip.name));
      applyRendererState();
      report("");
      setControls(true);
    } catch (error) {
      if (!request.signal.aborted) {
        // A matched pack that fails to build (bad GLB, renderer error) shows the same
        // placeholder notice as an unusable one; the detail goes to the console.
        console.warn(`character ${id ?? "-"}: load failed`, error);
        report(res.entry ? placeholderNote(res) : error instanceof Error ? error.message : String(error));
        setControls(!!renderer);
      }
    } finally {
      if (loading === request) { loading = undefined; stage.setAttribute("aria-busy", "false"); }
    }
  }
  /** Add Character shows only for a loaded list with no packs (a loading or failed list shows none). */
  function updateEmptyStage(): void {
    const add = emptyStage(characterList(), listFailed) === "add";
    if (add && !addButton) {
      addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "character-add";
      addButton.textContent = "Add Character";
      addButton.addEventListener("click", () => {
        void import("../settings/modal").then(({ openShortcutsModal }) => openShortcutsModal("characters"));
      }, { signal: listeners.signal });
      stage.append(addButton);
    }
    if (addButton) addButton.hidden = !add;
  }
  function reconcileCharacter(): void {
    updateEmptyStage();
    const next = desiredCharacter();
    const key = stageKey(next);
    if (key === shownKey) {
      applyRendererState();
      return;
    }
    character = next;
    shownKey = key;
    void load();
  }

  select.addEventListener("change", () => {
    if (!renderer) return;
    if (!select.value) {
      manualCode = null;
      applyRendererState();
      return;
    }
    manualCode = select.value.replace(/^chr\d+_/, "");
    renderer.selectClip(select.value);
  }, { signal: listeners.signal });

  // Outside close and Escape are popover.ts's (capture-phase mousedown). The menu opens on
  // contextmenu, which follows its own mousedown, so the opening press never closes it.
  function closeViewMenu(): void { closeMenu?.(); }
  function openViewMenu(x: number, y: number): void {
    closeMenu?.(); // a second right-click rebuilds the rows at the new point
    if (!viewMenu) {
      viewMenu = document.createElement("div");
      viewMenu.id = "character-view-menu";
      viewMenu.className = "hidden";
      document.body.appendChild(viewMenu);
    }
    viewMenu.innerHTML = "";
    const row = (text: string, onPick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.addEventListener("click", () => { closeViewMenu(); onPick(); });
      viewMenu!.appendChild(b);
    };
    const id = character.id;
    row("Reframe Default", () => {
      if (!renderer || !id) return;
      const view: View = renderer.captureView();
      characterViews[id] = view;
      renderer.applyView(view, true);
      // save_character_view emits no settings-changed: drop config.ts's memo so it is not stale.
      void invoke("save_character_view", { id, view })
        .then(() => invalidateConfig(), (e) => report(String(e)));
    });
    row("Reset Default", () => {
      if (!id) return;
      delete characterViews[id];
      void invoke("save_character_view", { id, view: null })
        .then(() => invalidateConfig(), (e) => report(String(e)))
        .finally(() => { if (!disposed) void load(); });
    });
    row("Reset View", () => renderer?.resetView());
    row(`${select.hidden ? "" : "✓ "}Animation Dropdown`, () => {
      setPref("character.animationDropdown", select.hidden ? "on" : "off");
      applyDropdown();
    });
    const close = openPopover({
      el: viewMenu, persistent: true, keys: "document", place: { x, y },
      onClose: () => { if (closeMenu === close) closeMenu = undefined; },
    });
    closeMenu = close;
  }
  stage.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!renderer || (event.target as HTMLElement)?.tagName !== "CANVAS") return;
    openViewMenu(event.clientX, event.clientY);
  }, { signal: listeners.signal });

  const sidebar = panel.parentElement!;
  const resize = new ResizeObserver(() => {
    const size = Math.max(0, Math.min(sidebar.clientWidth - 12, /* 2 x --bar-inset (leftbar.css) */ sidebar.clientHeight * 0.38 - 82, 320));
    panel.style.setProperty("--character-size", `${Math.floor(size)}px`);
  });
  resize.observe(sidebar);
  const visibility = new IntersectionObserver(([entry]) => {
    panelVisible = entry.isIntersecting;
    if (panelVisible && !hostSeen) {
      hostSeen = true;
      // The default stage shows with no character (and behind Add Character with no packs).
      ensureArena().then((created) => created.render(), (error) => {
        if (!disposed) report(error instanceof Error ? error.message : String(error));
      });
      if (loadWaiting) { loadWaiting = false; void load(); }
    }
    applyRendererState();
  });
  visibility.observe(stage);
  const motionChanged = () => applyRendererState();
  reducedMotion.addEventListener("change", motionChanged, { signal: listeners.signal });
  document.addEventListener("visibilitychange", motionChanged, { signal: listeners.signal });

  function applyFocus(next: FocusedSession | null): void {
    const changed = next?.id !== focused?.id;
    focused = next;
    if (next) {
      const cached = sessionState.get(next.id);
      sessionState.set(next.id, {
        agent: next.agent,
        model: cached?.model ?? next.model ?? null,
        contextUsedPercentage: cached?.contextUsedPercentage ?? null,
        contextFresh: cached?.contextFresh ?? false,
        active: cached?.active ?? false,
      });
    }
    if (changed) {
      lowContext = false;
      active = false;
      const cached = next ? sessionState.get(next.id) : undefined;
      if (cached) {
        lowContext = reduceLowContext(false, cached.contextUsedPercentage, cached.contextFresh);
        active = cached.active;
      }
    }
  }
  // The capability mounts once its gate settles (up to 8 s after boot), unordered against
  // initSessions: a tab opened or adopted before then fired its `vidar-focus` with no listener
  // here. Seed from the current focus (null with no tab), and let the
  // ensureCharacters() reconcile below put it on stage.
  applyFocus(getFocusedSession());
  document.addEventListener("vidar-focus", (event) => {
    applyFocus((event as CustomEvent<FocusedSession | null>).detail);
    reconcileCharacter();
  }, { signal: listeners.signal });
  document.addEventListener("vidar-character-status", (event) => {
    const detail = (event as CustomEvent<CharacterStatusDetail>).detail;
    const previous = sessionState.get(detail.id);
    const state: SessionCharacterState = {
      agent: previous?.agent ?? (focused?.id === detail.id ? focused.agent : ""),
      model: detail.model ?? previous?.model ?? null,
      contextUsedPercentage: detail.contextUsedPercentage,
      contextFresh: detail.fresh,
      active: previous?.active ?? false,
    };
    sessionState.set(detail.id, state);
    if (focused?.id !== detail.id) return;
    lowContext = reduceLowContext(lowContext, state.contextUsedPercentage, state.contextFresh);
    reconcileCharacter();
  }, { signal: listeners.signal });
  document.addEventListener("vidar-character-activity", (event) => {
    const detail = (event as CustomEvent<CharacterActivityDetail>).detail;
    const previous = sessionState.get(detail.id);
    sessionState.set(detail.id, {
      agent: previous?.agent ?? (focused?.id === detail.id ? focused.agent : ""),
      model: previous?.model ?? null,
      contextUsedPercentage: previous?.contextUsedPercentage ?? null,
      contextFresh: previous?.contextFresh ?? false,
      active: detail.active,
    });
    if (focused?.id !== detail.id) return;
    active = detail.active;
    applyRendererState();
  }, { signal: listeners.signal });
  document.addEventListener("vidar-character-completion", (event) => {
    const detail = (event as CustomEvent<CharacterCompletionDetail>).detail;
    if (focused?.id === detail.id && manualCode === null && canAnimate() && !loading) renderer?.playOnce("yes", 10);
  }, { signal: listeners.signal });
  // A raw Codex tab has no statusline: its model arrives as a vidar-character-status from here.
  watchCodexModel(listeners.signal);

  // Packs load once at start; every later list (a Settings edit, re-pin, add or remove)
  // bumps the revision and re-resolves the focused tab.
  const stopCharacters = onCharactersChanged(() => { if (!disposed) reconcileCharacter(); });
  void ensureCharacters().then(
    () => { if (!disposed) reconcileCharacter(); },
    (e) => { listFailed = true; updateEmptyStage(); report(`Characters Not Loaded: ${String(e)}`); },
  );
  return () => {
    disposed = true;
    stopSettings();
    stopCharacters();
    unload();
    arena?.dispose();
    arena = undefined;
    listeners.abort();
    // The menu lives on document.body, outside the host the registry restores.
    closeMenu?.(); // drops the popover's document listeners
    viewMenu?.remove();
    viewMenu = undefined;
    resize.disconnect();
    visibility.disconnect();
  };
}
