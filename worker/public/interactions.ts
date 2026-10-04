/** Mobile feedback primitives shared by the Canvas action buttons. */

export type HapticKind = "light" | "medium" | "success" | "error";

interface TelegramHaptic {
  impactOccurred?: (style: string) => void;
  notificationOccurred?: (type: string) => void;
}

interface TelegramHost {
  Telegram?: { WebApp?: { HapticFeedback?: TelegramHaptic } };
}

/** Best-effort Telegram haptics; no-ops outside Telegram. */
export function haptic(kind: HapticKind = "light"): void {
  // Unchecked cast: the Telegram WebApp global is absent outside Telegram.
  const host = window as TelegramHost;
  const feedback = host.Telegram?.WebApp?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === "success" || kind === "error") feedback.notificationOccurred?.(kind);
    else feedback.impactOccurred?.(kind);
  } catch {
    /* haptics are optional */
  }
}

export interface ActionLabels {
  busy: string;
  error: string;
}

let invocation = 0;

/**
 * Async button action with pending state and duplicate-tap blocking. The
 * invocation token stops a stale completion from reviving a newer action on the
 * same reused button; `isCurrent` (render generation) stops stale repaints.
 * `action` resolves with the success label, or `false` on failure.
 */
export async function runPendingAction(
  button: HTMLButtonElement,
  action: () => Promise<string | false>,
  labels: ActionLabels,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (button.dataset.pending) return;
  const token = String(++invocation);
  button.dataset.pending = token;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = labels.busy;
  let result: string | false;
  try {
    result = await action();
  } catch {
    result = false;
  }
  if (button.dataset.pending !== token) return; // superseded by cleanup or a newer action
  delete button.dataset.pending;
  button.disabled = false;
  button.removeAttribute("aria-busy");
  if (!isCurrent()) return; // stale render: leave shared UI untouched
  button.textContent = result === false ? labels.error : result;
  haptic(result === false ? "error" : "success");
}
