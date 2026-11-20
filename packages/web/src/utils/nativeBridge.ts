/**
 * Mac ネイティブ .app（WKWebView）と Web UI をつなぐ軽量ブリッジ。
 * 通常ブラウザで開いた場合は安全に標準 Web API へフォールバックする。
 */

interface WebKitMessageHandler {
  postMessage: (message: unknown) => void;
}

interface NativeWindow extends Window {
  webkit?: {
    messageHandlers?: {
      agJpNative?: WebKitMessageHandler;
    };
  };
}

export function isMacNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as NativeWindow).webkit?.messageHandlers?.agJpNative);
}

export function postNativeMessage(payload: Record<string, unknown>): boolean {
  if (typeof window === "undefined") return false;
  const handler = (window as NativeWindow).webkit?.messageHandlers?.agJpNative;
  if (!handler) return false;
  try {
    handler.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

export async function copyTextSafe(text: string): Promise<void> {
  if (postNativeMessage({ type: "copy", text })) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

export function sendNativeNotification(title: string, body?: string): boolean {
  return postNativeMessage({
    type: "notify",
    title,
    body: body ?? "",
  });
}
