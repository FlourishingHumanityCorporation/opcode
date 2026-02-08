export const STALE_INPUT_THRESHOLD_MS = 8_000;
export const STALE_RECOVERY_GRACE_MS = 1_200;
export const STALE_RECOVERY_COOLDOWN_MS = 2_500;
export const TERMINAL_SCROLLBACK_LINES = 20_000;
export const WHEEL_PIXEL_DELTA_PER_LINE = 16;
export const WHEEL_DELTA_MODE_PIXEL = 0;
export const WHEEL_DELTA_MODE_LINE = 1;
export const WHEEL_DELTA_MODE_PAGE = 2;

export const FALLBACK_BLOCKED_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);
