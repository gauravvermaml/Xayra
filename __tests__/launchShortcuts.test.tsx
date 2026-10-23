/**
 * Android launcher shortcuts ("Record with Xayra" / "Ask Xayra"): routing,
 * consume-once auto-start, and the safety rules around it.
 */
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AppState } from "react-native";

jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: jest.fn() }));
jest.mock("../services/ai/localLlama", () => ({ cancelActiveLlamaCompletion: jest.fn() }));

import { redirectSystemPath } from "../app/+native-intent";
import {
  useDiscardShortcutsDuringSetup,
  useLaunchShortcut,
  useShortcutLaunchTransaction,
} from "../hooks/useLaunchShortcut";
import {
  decideCentralTap,
  ManualUtteranceController,
  recordCompletionSpeech,
  type UtteranceMode,
} from "../services/audio/manualUtterance";
import {
  canAdoptShortcutMode,
  decideShortcutLaunch,
  peekPendingShortcut,
  discardPendingShortcut,
  hasPendingShortcut,
  parseShortcutUrl,
  setPendingShortcut,
  takePendingShortcut,
  type PendingShortcut,
} from "../services/shortcuts/launchShortcut";

const withAppShortcuts = require("../plugins/withAppShortcuts");

// AppState: controllable foreground/background, with captured listeners.
let mockAppState = "active";
const appStateListeners = new Set<(s: string) => void>();
beforeEach(() => {
  discardPendingShortcut();
  mockAppState = "active";
  appStateListeners.clear();
  Object.defineProperty(AppState, "currentState", { get: () => mockAppState, configurable: true });
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, listener: (s: string) => void) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  }) as never);
});
// Every rendered tree is unmounted after its test, so no earlier test's
// subscription can take a later test's shortcut.
const mounted: ReactTestRenderer[] = [];
function track(tree: ReactTestRenderer): ReactTestRenderer {
  mounted.push(tree);
  return tree;
}
afterEach(() => {
  act(() => mounted.splice(0).forEach((t) => t.unmount()));
  jest.restoreAllMocks();
});
function setAppState(next: string) {
  mockAppState = next;
  act(() => appStateListeners.forEach((l) => l(next)));
}

describe("shortcut links", () => {
  it("Record shortcut resolves to Record, Ask to Ask — for both app schemes", () => {
    expect(parseShortcutUrl("xayra://shortcut?mode=record")).toBe("record");
    expect(parseShortcutUrl("xayra://shortcut?mode=ask")).toBe("ask");
    expect(parseShortcutUrl("xayra-dev://shortcut?mode=record")).toBe("record");
    expect(parseShortcutUrl("xayra-dev://shortcut/?mode=ask")).toBe("ask");
  });

  it("ignores everything else", () => {
    for (const url of ["xayra://dev-seed", "xayra://shortcut?mode=delete", "xayra://shortcut", "", null, "https://x.test/shortcut?mode=ask"]) {
      expect(parseShortcutUrl(url)).toBeNull();
    }
  });

  it("native intent: a shortcut link becomes a pending shortcut and routes Home; other links pass through", () => {
    expect(redirectSystemPath({ path: "xayra://shortcut?mode=ask", initial: true })).toBe("/");
    expect(takePendingShortcut()?.mode).toBe("ask");
    expect(redirectSystemPath({ path: "xayra-dev://dev-seed", initial: false })).toBe("xayra-dev://dev-seed");
    expect(hasPendingShortcut()).toBe(false);
  });

  it("a pending shortcut is consumed once", () => {
    setPendingShortcut("record");
    expect(takePendingShortcut()?.mode).toBe("record");
    expect(takePendingShortcut()).toBeNull();
  });
});

describe("decideShortcutLaunch", () => {
  const ready = {
    manualPhase: "idle" as const,
    isProcessing: false,
    isRecorderBusy: false,
    isHandsfreeActive: false,
    isMicInUse: false,
    micPermissionGranted: true,
  };

  it("starts recording when Xayra is idle, set up, and has mic permission", () => {
    expect(decideShortcutLaunch(ready)).toBe("start");
  });
  it("never starts a competing session while another utterance records or processes", () => {
    expect(decideShortcutLaunch({ ...ready, manualPhase: "recording" })).toBe("busy");
    expect(decideShortcutLaunch({ ...ready, manualPhase: "processing" })).toBe("busy");
    expect(decideShortcutLaunch({ ...ready, isProcessing: true })).toBe("busy");
    expect(decideShortcutLaunch({ ...ready, isRecorderBusy: true })).toBe("busy");
  });
  it("never creates a second native mic owner, even one this screen doesn't know about", () => {
    // e.g. a capture left by a screen that went away
    expect(decideShortcutLaunch({ ...ready, isMicInUse: true })).toBe("busy");
  });
  it("leaves Handsfree's microphone session alone", () => {
    expect(decideShortcutLaunch({ ...ready, isHandsfreeActive: true })).toBe("handsfree");
  });
  it("without mic permission it only selects the mode (the tap then shows the normal prompt)", () => {
    expect(decideShortcutLaunch({ ...ready, micPermissionGranted: false })).toBe("select-only");
  });
});

describe("launch transaction (replaces the 20 s expiry)", () => {
  function Root() {
    useShortcutLaunchTransaction();
    return null;
  }
  function Home({ enabled, onShortcut }: { enabled: boolean; onShortcut: (s: PendingShortcut) => void }) {
    useLaunchShortcut({ enabled, onShortcut });
    return null;
  }
  async function render(el: React.ReactElement) {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = track(create(el));
    });
    return tree;
  }

  it("a slow fingerprint unlock in the same launch still starts — however long it takes", async () => {
    await render(<Root />);
    // Cold launch: the link arrives while the app is foreground, then the
    // biometric prompt (which does not background the app) takes 10 minutes.
    setPendingShortcut("record", Date.now() - 10 * 60_000);
    const onShortcut = jest.fn();
    const home = await render(<Home enabled={false} onShortcut={onShortcut} />);
    await act(async () => home.update(<Home enabled onShortcut={onShortcut} />));
    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(onShortcut.mock.calls[0][0].mode).toBe("record");
  });

  it("is abandoned when the app goes to the background before Home uses it", async () => {
    await render(<Root />);
    setPendingShortcut("ask"); // foreground cold launch, Home not ready yet
    setAppState("background"); // user pressed Home / screen locked mid-unlock
    expect(hasPendingShortcut()).toBe(false);
  });

  it("a warm launch's own pre-foreground background state doesn't abandon it", async () => {
    await render(<Root />);
    mockAppState = "background";
    setPendingShortcut("record"); // link lands before the app is visible
    setAppState("background"); // still the same launch, not yet foreground
    expect(hasPendingShortcut()).toBe(true);
    setAppState("active");
    expect(hasPendingShortcut()).toBe(true); // ready for Home
    setAppState("background"); // left before Home took it
    expect(hasPendingShortcut()).toBe(false);
  });

  it("a normal later launch does not replay an abandoned shortcut", async () => {
    await render(<Root />);
    setPendingShortcut("record");
    setAppState("background");
    const onShortcut = jest.fn();
    await render(<Home enabled onShortcut={onShortcut} />);
    setAppState("active"); // the user opens Xayra normally later
    expect(onShortcut).not.toHaveBeenCalled();
  });

  it("a second shortcut replaces the first launch safely", () => {
    setPendingShortcut("record");
    const first = peekPendingShortcut()!;
    setPendingShortcut("ask");
    const taken = takePendingShortcut()!;
    expect(taken.mode).toBe("ask");
    expect(taken.launch).toBeGreaterThan(first.launch);
    expect(takePendingShortcut()).toBeNull();
  });

  it("nothing survives a process restart (in-memory only)", () => {
    setPendingShortcut("record");
    jest.isolateModules(() => {
      const fresh = require("../services/shortcuts/launchShortcut");
      expect(fresh.hasPendingShortcut()).toBe(false);
    });
  });
});

describe("useLaunchShortcut — consume-once auto-start", () => {
  function Harness({ enabled, onShortcut }: { enabled: boolean; onShortcut: (s: PendingShortcut) => void }) {
    useLaunchShortcut({ enabled, onShortcut });
    return null;
  }
  async function mount(enabled: boolean, onShortcut: jest.Mock, strict = false) {
    let tree!: ReactTestRenderer;
    const el = <Harness enabled={enabled} onShortcut={onShortcut} />;
    await act(async () => {
      tree = track(create(strict ? <StrictMode>{el}</StrictMode> : el));
    });
    return tree;
  }

  it("cold start: waits for Home to be ready, then acts exactly once", async () => {
    setPendingShortcut("record"); // set by +native-intent before Home mounts
    const onShortcut = jest.fn();
    const tree = await mount(false, onShortcut);
    expect(onShortcut).not.toHaveBeenCalled();
    await act(async () => tree.update(<Harness enabled onShortcut={onShortcut} />));
    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(onShortcut.mock.calls[0][0].mode).toBe("record");
    // Re-renders and focus toggles don't act again.
    await act(async () => tree.update(<Harness enabled onShortcut={onShortcut} />));
    await act(async () => tree.update(<Harness enabled={false} onShortcut={onShortcut} />));
    await act(async () => tree.update(<Harness enabled onShortcut={onShortcut} />));
    setAppState("background");
    setAppState("active");
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it("Strict Mode's double effects still act once", async () => {
    setPendingShortcut("ask");
    const onShortcut = jest.fn();
    await mount(true, onShortcut, true);
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it("warm launch: a shortcut arriving while Home is open acts once", async () => {
    const onShortcut = jest.fn();
    await mount(true, onShortcut);
    act(() => setPendingShortcut("ask"));
    expect(onShortcut).toHaveBeenCalledTimes(1);
    expect(onShortcut.mock.calls[0][0].mode).toBe("ask");
    setAppState("background");
    setAppState("active");
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it("warm launch from the background waits for the foreground before starting", async () => {
    const onShortcut = jest.fn();
    await mount(true, onShortcut);
    setAppState("background");
    act(() => setPendingShortcut("record"));
    expect(onShortcut).not.toHaveBeenCalled();
    setAppState("active");
    expect(onShortcut).toHaveBeenCalledTimes(1);
  });

  it.each(["record", "ask"] as const)(
    "warm onNewIntent %s: the mode is announced on arrival (before the app is visible), started once in the foreground",
    async (mode) => {
      const onShortcut = jest.fn();
      const onArrive = jest.fn();
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = track(create(<ArriveHarness enabled onShortcut={onShortcut} onArrive={onArrive} />));
      });
      setAppState("background");
      // A warm launch reaches JS as a normal deep-link "url" event (initial: false).
      act(() => {
        expect(redirectSystemPath({ path: `xayra://shortcut?mode=${mode}`, initial: false })).toBe("/");
      });
      expect(onArrive).toHaveBeenCalledTimes(1);
      expect(onArrive.mock.calls[0][0].mode).toBe(mode);
      expect(onShortcut).not.toHaveBeenCalled(); // not yet foreground
      setAppState("active");
      expect(onShortcut).toHaveBeenCalledTimes(1);
      expect(onShortcut.mock.calls[0][0].mode).toBe(mode);
      // Arrival was announced before the start, so the mode is authoritative first.
      expect(onArrive.mock.invocationCallOrder[0]).toBeLessThan(onShortcut.mock.invocationCallOrder[0]);
      setAppState("background");
      setAppState("active");
      await act(async () => tree.update(<ArriveHarness enabled onShortcut={onShortcut} onArrive={onArrive} />));
      expect(onShortcut).toHaveBeenCalledTimes(1);
      expect(onArrive).toHaveBeenCalledTimes(1);
    }
  );

  it("cold start: Home can read the requested mode for its first render", () => {
    redirectSystemPath({ path: "xayra://shortcut?mode=ask", initial: true });
    // What Home's useState initializer does — without consuming it.
    expect(peekPendingShortcut()?.mode ?? "record").toBe("ask");
    expect(hasPendingShortcut()).toBe(true);
  });

  it("a normal icon launch (no shortcut link) replays nothing", async () => {
    const onShortcut = jest.fn();
    expect(redirectSystemPath({ path: "xayra://", initial: true })).toBe("xayra://");
    await mount(true, onShortcut);
    setAppState("background");
    setAppState("active");
    expect(onShortcut).not.toHaveBeenCalled();
  });

  it("two shortcut taps in a row are two separate launches, each acted on once", async () => {
    const onShortcut = jest.fn();
    await mount(true, onShortcut);
    act(() => setPendingShortcut("record"));
    act(() => setPendingShortcut("ask"));
    expect(onShortcut.mock.calls.map((c) => c[0].mode)).toEqual(["record", "ask"]);
  });
});

function ArriveHarness({
  enabled,
  onShortcut,
  onArrive,
}: {
  enabled: boolean;
  onShortcut: (s: PendingShortcut) => void;
  onArrive: (s: PendingShortcut) => void;
}) {
  useLaunchShortcut({ enabled, onShortcut, onArrive });
  return null;
}

describe("adopting the shortcut's mode on arrival", () => {
  const idle = { manualPhase: "idle" as const, isProcessing: false, isRecorderBusy: false, isHandsfreeActive: false, isMicInUse: false };
  it("adopts it when nothing is in flight", () => {
    expect(canAdoptShortcutMode(idle)).toBe(true);
  });
  it.each([
    ["an utterance is recording", { manualPhase: "recording" as const }],
    ["an utterance is processing", { manualPhase: "processing" as const }],
    ["a typed request is processing", { isProcessing: true }],
    ["the recorder is mid-transition", { isRecorderBusy: true }],
    ["Handsfree is on", { isHandsfreeActive: true }],
    ["another session owns the mic", { isMicInUse: true }],
  ])("never mutates the mode while %s", (_l, override) => {
    expect(canAdoptShortcutMode({ ...idle, ...override })).toBe(false);
  });
});

describe("no speech, no 'Saved.'", () => {
  it("is only spoken when a note was actually written", () => {
    expect(recordCompletionSpeech(true)).toBe("Saved.");
    expect(recordCompletionSpeech(false)).toBeNull();
    expect(recordCompletionSpeech(undefined)).toBeNull();
  });
});

describe("setup not complete", () => {
  function Gate({ setupComplete }: { setupComplete: boolean | null }) {
    useDiscardShortcutsDuringSetup(setupComplete);
    return null;
  }

  it("drops a pending shortcut, and any arriving later, while onboarding shows", async () => {
    setPendingShortcut("record");
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = track(create(<Gate setupComplete={false} />));
    });
    expect(hasPendingShortcut()).toBe(false);
    act(() => setPendingShortcut("ask"));
    expect(hasPendingShortcut()).toBe(false);
    // Setup finishes later: nothing is left to start a recording.
    await act(async () => tree.update(<Gate setupComplete />));
    expect(hasPendingShortcut()).toBe(false);
  });

  it("keeps it while setup is still being checked (normal cold start)", async () => {
    setPendingShortcut("record");
    await act(async () => {
      track(create(<Gate setupComplete={null} />));
    });
    expect(hasPendingShortcut()).toBe(true);
  });
});

describe("the shortcut's mode is the utterance's mode", () => {
  function controller(processed: UtteranceMode[]) {
    let autoStop: (() => void) | undefined;
    const c = new ManualUtteranceController({
      startRecording: async (o) => {
        autoStop = o.onAutoStop;
      },
      stopRecording: async () => "file:///fake.wav",
      discardRecording: async () => {},
      processUtterance: async (_uri, mode) => {
        processed.push(mode);
      },
    });
    return { c, finishBySilence: () => autoStop?.() };
  }

  it("overrides a stale opposite UI mode and stays frozen for that utterance", async () => {
    let uiMode: UtteranceMode = "record"; // left in Record last time
    const shortcut: PendingShortcut = { mode: "ask", receivedAt: Date.now(), launch: 1, foregrounded: true };
    const processed: UtteranceMode[] = [];
    const { c, finishBySilence } = controller(processed);
    // What Home does on "start": select the shortcut's mode, start with it.
    uiMode = shortcut.mode;
    await c.start(shortcut.mode);
    uiMode = "record"; // can't happen (pill is locked) — and wouldn't matter
    finishBySilence();
    await new Promise((r) => setImmediate(r));
    expect(processed).toEqual(["ask"]);
    expect(uiMode).toBe("record");
  });

  it("the central button's own flow is unchanged", () => {
    const idle = { manualPhase: "idle" as const, isProcessing: false, isHandsfreeActive: false, isRecorderTransitioning: false };
    expect(decideCentralTap(idle)).toBe("start-manual");
    expect(decideCentralTap({ ...idle, manualPhase: "recording" })).toBe("finish-manual");
    expect(decideCentralTap({ ...idle, manualPhase: "processing" })).toBe("ignore");
    expect(decideCentralTap({ ...idle, isHandsfreeActive: true })).toBe("cancel-handsfree-capture");
  });
});

describe("native shortcuts config (plugins/withAppShortcuts.js)", () => {
  it("declares exactly the two shortcuts with their labels", () => {
    expect(withAppShortcuts.SHORTCUTS.map((s: { longLabel: string; mode: string }) => [s.longLabel, s.mode])).toEqual([
      ["Record with Xayra", "record"],
      ["Ask Xayra", "ask"],
    ]);
  });

  it("shortcuts target the trampoline, which forwards only shortcut links to MainActivity in a new task", () => {
    const xml = withAppShortcuts.buildShortcutsXml({ packageName: "com.anonymous.silentconfidant", scheme: "xayra" });
    expect(xml).toContain('android:targetClass="com.anonymous.silentconfidant.ShortcutLaunchActivity"');
    expect(xml).not.toContain('android:targetClass="com.anonymous.silentconfidant.MainActivity"');
    const kt = withAppShortcuts.buildTrampolineKotlin("com.anonymous.silentconfidant.dev");
    expect(kt).toContain("package com.anonymous.silentconfidant.dev");
    // singleTop MainActivity: CLEAR_TOP | SINGLE_TOP reuse the running
    // instance (onNewIntent, no remount) exactly as singleTask did; CLEAR_TASK
    // — which re-created MainActivity — is never used.
    expect(kt).toContain("Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP");
    expect(kt).toContain('data.host == "shortcut"');
    expect(kt).not.toMatch(/FLAG_ACTIVITY_CLEAR_TASK/);
    expect(kt).toContain("finish()");
  });

  it("MainActivity is singleTop, so returning from the launcher never clears Google Play's purchase screen", () => {
    const manifest = {
      manifest: {
        application: [{ $: { "android:name": ".MainApplication" }, activity: [{ $: { "android:name": ".MainActivity", "android:launchMode": "singleTask" }, "intent-filter": [{ action: [{ $: { "android:name": "android.intent.action.MAIN" } }], category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }] }] }] }],
      },
    };
    const { withAndroidManifest } = require("@expo/config-plugins");
    let captured: unknown = null;
    const config = withAppShortcuts({ name: "Xayra", slug: "x", scheme: "xayra", android: { package: "com.anonymous.silentconfidant" } });
    // Run only the manifest mod against a minimal manifest.
    const mod = config.mods?.android?.manifest;
    expect(typeof mod).toBe("function");
    return mod({ ...config, modResults: manifest, modRequest: { platform: "android" } }).then((result: { modResults: typeof manifest }) => {
      captured = result.modResults.manifest.application[0].activity.find((a: { $: Record<string, string> }) => a.$["android:name"] === ".MainActivity");
      expect((captured as { $: Record<string, string> }).$["android:launchMode"]).toBe("singleTop");
      expect(withAndroidManifest).toBeDefined();
    });
  });

  it("production and Xayra Dev shortcuts each target only their own package and scheme", () => {
    const prod = withAppShortcuts.buildShortcutsXml({ packageName: "com.anonymous.silentconfidant", scheme: "xayra" });
    const dev = withAppShortcuts.buildShortcutsXml({ packageName: "com.anonymous.silentconfidant.dev", scheme: "xayra-dev" });
    expect(prod).toContain('android:targetPackage="com.anonymous.silentconfidant"');
    expect(prod).toContain('android:targetClass="com.anonymous.silentconfidant.ShortcutLaunchActivity"');
    expect(prod).toContain('android:data="xayra://shortcut?mode=record"');
    expect(prod).toContain('android:data="xayra://shortcut?mode=ask"');
    expect(prod).not.toContain(".dev");
    expect(prod).not.toContain("xayra-dev");
    expect(dev).toContain('android:targetPackage="com.anonymous.silentconfidant.dev"');
    expect(dev).toContain('android:targetClass="com.anonymous.silentconfidant.dev.ShortcutLaunchActivity"');
    expect(dev).toContain('android:data="xayra-dev://shortcut?mode=ask"');
    // Every generated link is one the app itself recognises.
    for (const xml of [prod, dev]) {
      const links = [...xml.matchAll(/android:data="([^"]+)"/g)].map((m) => m[1]);
      expect(links.map(parseShortcutUrl)).toEqual(["record", "ask"]);
    }
  });

  it("app.config.js keeps the two variants distinct", () => {
    const appConfig = require("../app.config.js");
    const base = require("../app.json").expo;
    const saved = process.env.APP_VARIANT;
    try {
      delete process.env.APP_VARIANT;
      const prod = appConfig({ config: base });
      process.env.APP_VARIANT = "development";
      const dev = appConfig({ config: base });
      expect([prod.scheme, prod.android.package]).toEqual(["xayra", "com.anonymous.silentconfidant"]);
      expect([dev.scheme, dev.android.package]).toEqual(["xayra-dev", "com.anonymous.silentconfidant.dev"]);
      expect(base.plugins).toContain("./plugins/withAppShortcuts");
    } finally {
      if (saved === undefined) delete process.env.APP_VARIANT;
      else process.env.APP_VARIANT = saved;
    }
  });

  it("adds the Recents-replay guard to MainActivity once, before super.onCreate", () => {
    const src = "class MainActivity {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)\n  }\n}\n";
    const once = withAppShortcuts.addActivityGuard(src);
    expect(once).toContain("FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY");
    expect(once).toContain('intent.data?.host == "shortcut"');
    expect(once.indexOf("FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY")).toBeLessThan(once.indexOf("super.onCreate"));
    expect(withAppShortcuts.addActivityGuard(once)).toBe(once);
  });
});
