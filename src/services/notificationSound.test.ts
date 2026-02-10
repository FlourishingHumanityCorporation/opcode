import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPrefs = vi.hoisted(() => ({
  readNotificationPreferencesFromStorage: vi.fn((): {
    enabled_done: boolean;
    enabled_needs_input: boolean;
    sound_enabled: boolean;
    sound_kind: "needs_input_only" | "all";
  } => ({
    enabled_done: true,
    enabled_needs_input: true,
    sound_enabled: true,
    sound_kind: "needs_input_only",
  })),
}));

vi.mock("@/lib/notificationPreferences", () => mockPrefs);

describe("notificationSound", () => {
  let mockOscillator: any;
  let mockGain: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.resetModules();

    mockOscillator = {
      type: "sine",
      frequency: { value: 440 },
      connect: vi.fn().mockReturnThis(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn().mockReturnThis(),
    };

    mockCtx = {
      state: "running",
      currentTime: 0,
      destination: {},
      resume: vi.fn(),
      createOscillator: vi.fn(() => mockOscillator),
      createGain: vi.fn(() => mockGain),
    };

    (globalThis as any).AudioContext = vi.fn(() => mockCtx);
  });

  afterEach(() => {
    delete (globalThis as any).AudioContext;
  });

  it("does not play when sound is disabled", async () => {
    mockPrefs.readNotificationPreferencesFromStorage.mockReturnValue({
      enabled_done: true,
      enabled_needs_input: true,
      sound_enabled: false,
      sound_kind: "needs_input_only",
    });

    const { playNotificationSound } = await import("@/services/notificationSound");
    await playNotificationSound("done");

    expect(mockCtx.createOscillator).not.toHaveBeenCalled();
  });

  it("does not play for 'done' when sound_kind is 'needs_input_only'", async () => {
    mockPrefs.readNotificationPreferencesFromStorage.mockReturnValue({
      enabled_done: true,
      enabled_needs_input: true,
      sound_enabled: true,
      sound_kind: "needs_input_only",
    });

    const { playNotificationSound } = await import("@/services/notificationSound");
    await playNotificationSound("done");

    expect(mockCtx.createOscillator).not.toHaveBeenCalled();
  });

  it("plays two-tone for needs_input", async () => {
    const { playNotificationSound } = await import("@/services/notificationSound");
    await playNotificationSound("needs_input");

    // Two tones = two oscillators
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
    expect(mockOscillator.start).toHaveBeenCalledTimes(2);
  });

  it("plays for 'done' when sound_kind is 'all'", async () => {
    mockPrefs.readNotificationPreferencesFromStorage.mockReturnValue({
      enabled_done: true,
      enabled_needs_input: true,
      sound_enabled: true,
      sound_kind: "all",
    });

    const { playNotificationSound } = await import("@/services/notificationSound");
    await playNotificationSound("done");

    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(1);
  });

  it("does not play for 'running' kind", async () => {
    const { playNotificationSound } = await import("@/services/notificationSound");
    await playNotificationSound("running");

    expect(mockCtx.createOscillator).not.toHaveBeenCalled();
  });
});
