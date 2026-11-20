export type BrowserNotificationPermission =
  | NotificationPermission
  | "unsupported";

export interface NativeNotificationDeepLink {
  kind: "chat" | "command" | "approval" | "worker";
  targetId?: string;
  tab?: "control" | "brain" | "memory" | "safety";
}

interface ShowBrowserNotificationOptions {
  title: string;
  body?: string;
  subtitle?: string;
  tag?: string;
  deepLink?: NativeNotificationDeepLink;
  /** When true, delivers to macOS native Notification Center even if app is focused (e.g. approval gate on another view). */
  allowWhileFocused?: boolean;
  sound?: "default" | "none";
}

function getNativeBridge(): { postMessage: (msg: unknown) => void } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    webkit?: {
      messageHandlers?: {
        antigravityNative?: { postMessage: (msg: unknown) => void };
      };
    };
  };
  return w.webkit?.messageHandlers?.antigravityNative ?? null;
}

export function isNativeNotificationBridgeAvailable(): boolean {
  return getNativeBridge() !== null;
}

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (isNativeNotificationBridgeAvailable()) {
    return "granted";
  }
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    typeof window.Notification === "undefined"
  ) {
    return "unsupported";
  }

  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (isNativeNotificationBridgeAvailable()) {
    return "granted";
  }
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    typeof window.Notification === "undefined"
  ) {
    return "unsupported";
  }

  return window.Notification.requestPermission();
}

export function shouldShowBrowserNotification(): boolean {
  if (typeof document === "undefined") return true;

  if (document.hidden) return true;
  if (typeof document.hasFocus === "function") {
    return !document.hasFocus();
  }

  return false;
}

export function showBrowserNotification({
  title,
  body,
  subtitle,
  tag,
  deepLink,
  allowWhileFocused = false,
  sound = "default",
}: ShowBrowserNotificationOptions): boolean {
  const needsAttention = allowWhileFocused || shouldShowBrowserNotification();
  if (!needsAttention) return false;

  const nativeBridge = getNativeBridge();
  if (nativeBridge) {
    try {
      nativeBridge.postMessage({
        action: "notify",
        id: tag ?? `antigravity-jp:${Date.now()}`,
        title,
        subtitle: subtitle ?? "",
        body: body ?? "",
        sound,
        deepLink: deepLink ?? { kind: "command", tab: "control" },
      });
      return true;
    } catch {
      // Fall through to browser Notification API if native bridge fails
    }
  }

  if (getBrowserNotificationPermission() !== "granted") return false;

  try {
    const notification = new window.Notification(title, {
      body,
      tag,
      icon: "/icons/icon-192.png",
    });

    notification.onclick = () => {
      window.focus();
      if (deepLink) {
        window.dispatchEvent(
          new CustomEvent("antigravity-jp-navigate", { detail: deepLink }),
        );
      }
      notification.close();
    };

    window.setTimeout(() => notification.close(), 10_000);
    return true;
  } catch {
    return false;
  }
}
