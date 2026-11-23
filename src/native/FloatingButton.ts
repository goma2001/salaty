/**
 * JS wrapper around the native `FloatingButton` module — the floating
 * prayer button (Android only).
 *
 * The module draws a small pill above other apps (next prayer + live
 * countdown) through a foreground service; see
 * `FloatingButtonService.kt`. No-ops on iOS, on the web and on a build
 * without the module, so callers can simply call.
 */
import { NativeModules, Platform } from 'react-native';

type FloatingButtonNative = {
  hasPermission(): Promise<boolean>;
  openPermissionSettings(): Promise<void>;
  start(times: string): Promise<boolean>;
  stop(): Promise<void>;
  consumePendingHide(): Promise<boolean>;
};

const native: FloatingButtonNative | undefined =
  Platform.OS === 'android'
    ? (NativeModules as Record<string, FloatingButtonNative | undefined>)
        .FloatingButton
    : undefined;

/** Whether this build can draw the floating button at all. */
export const floatingButtonAvailable = native != null;

/** Whether the system currently lets this app draw over other apps. */
export async function hasOverlayPermission(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.hasPermission();
  } catch {
    return false;
  }
}

/** Open the system page where "Draw over other apps" is granted. */
export async function openOverlayPermissionSettings(): Promise<void> {
  if (!native) return;
  try {
    await native.openPermissionSettings();
  } catch (e) {
    console.warn('FloatingButton.openPermissionSettings:', e);
  }
}

/**
 * Start (or refresh the times of) the floating button. `times` is the
 * wire format from `src/services/floatingButton.ts`:
 * "name|epochMs;name|epochMs;...". Returns false when the overlay
 * permission is not granted or the native side refused.
 */
export async function startFloatingButton(times: string): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.start(times);
  } catch {
    return false;
  }
}

/** Stop the floating button. */
export async function stopFloatingButton(): Promise<void> {
  if (!native) return;
  try {
    await native.stop();
  } catch (e) {
    console.warn('FloatingButton.stop:', e);
  }
}

/**
 * Whether the user hid the pill from its own quick menu while the app
 * was closed (see src/services/floatingButton.ts). Reads and clears
 * the flag the menu leaves behind; false without the module.
 */
export async function consumePendingHide(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.consumePendingHide();
  } catch {
    return false;
  }
}
