import type { BrowserContext, BrowserContextOptions } from "playwright";

/**
 * Shared helpers for browser media permissions (copied from Uply-v2's
 * `services/runs/execute/browser/browser-media-permissions.ts`; message text changed to "PRVision").
 * The module keeps browser media permissions rules and transformations in one place for the render engine.
 */
const blockedMediaInitScript = `
(() => {
  const blockedMediaError = () => {
    try {
      return new DOMException("Camera, microphone, and screen capture are disabled in PRVision.", "NotAllowedError");
    } catch {
      const error = new Error("Camera, microphone, and screen capture are disabled in PRVision.");
      error.name = "NotAllowedError";
      return error;
    }
  };

  const replaceMethod = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: true, value });
    } catch {
      try {
        target[name] = value;
      } catch {}
    }
  };

  const rejectMediaRequest = () => Promise.reject(blockedMediaError());
  const rejectLegacyMediaRequest = (_constraints, _successCallback, errorCallback) => {
    if (typeof errorCallback === "function") {
      errorCallback(blockedMediaError());
    }
  };

  if (navigator.mediaDevices) {
    replaceMethod(navigator.mediaDevices, "getUserMedia", rejectMediaRequest);
    replaceMethod(navigator.mediaDevices, "getDisplayMedia", rejectMediaRequest);
  }

  replaceMethod(navigator, "getUserMedia", rejectLegacyMediaRequest);
  replaceMethod(navigator, "webkitGetUserMedia", rejectLegacyMediaRequest);
  replaceMethod(navigator, "mozGetUserMedia", rejectLegacyMediaRequest);
  replaceMethod(navigator, "msGetUserMedia", rejectLegacyMediaRequest);
})();
`;

/**
 * Creates browser context options that grant no permissions (camera, microphone, geolocation, …).
 *
 * @param options - Context options to extend.
 * @returns The options with `permissions: []`.
 */
export function browserContextWithBlockedMedia(options: BrowserContextOptions): BrowserContextOptions {
  return {
    ...options,
    permissions: []
  };
}

/**
 * Patches media APIs so permission prompts cannot block renders.
 *
 * Rendering must be deterministic and non-interactive, so camera, microphone and screen-capture requests fail
 * immediately inside the page.
 *
 * @param context - The browser context to patch (before any page loads).
 */
export async function blockBrowserContextMediaPermissions(context: BrowserContext): Promise<void> {
  await context.addInitScript(blockedMediaInitScript);
}
