package com.goma.salat

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JavaScript bridge for the floating prayer button
 * (FloatingButtonService): the Settings toggle's way in.
 *
 * - `hasPermission`: Settings.canDrawOverlays (SYSTEM_ALERT_WINDOW).
 * - `openPermissionSettings`: the system "Draw over other apps" page
 *   for this app (falls back to the app's settings page on shells
 *   that hide the dedicated page).
 * - `start(times)`: persists enabled + the times
 *   ("name|epochMs;..." — today's 5 prayers + tomorrow's Fajr, see
 *   src/services/floatingButton.ts) and starts the service. Returns
 *   false when the overlay permission is not granted, so the caller
 *   can send the user to the system page instead of pretending the
 *   pill is up.
 * - `stop`: persists disabled and stops the service.
 * - `consumePendingHide`: whether the user hid the pill from its own
 *   quick menu while the app was closed. The menu stops the service
 *   and leaves a flag behind; this reads and clears it, so the app
 *   can turn the Settings toggle off instead of the next sync
 *   restarting a pill the user just hid.
 *
 * Every method resolves rather than rejecting: a caller that cannot
 * reach the native side (tests, a build without the module) gets a
 * plain false / no-op, never a crash.
 */
class FloatingButtonModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun hasPermission(promise: Promise) {
    promise.resolve(Settings.canDrawOverlays(reactContext))
  }

  @ReactMethod
  fun openPermissionSettings(promise: Promise) {
    val pkg = reactContext.packageName
    val overlayIntent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      Uri.parse("package:$pkg"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { reactContext.startActivity(overlayIntent) }
      .onSuccess { promise.resolve(null) }
      .onFailure {
        // Some shells hide the overlay page; the app's settings page
        // is the next best place.
        runCatching {
          reactContext.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
              .setData(Uri.parse("package:$pkg"))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
        promise.resolve(null)
      }
  }

  @ReactMethod
  fun start(times: String?, promise: Promise) {
    if (!Settings.canDrawOverlays(reactContext)) {
      promise.resolve(false)
      return
    }
    reactContext.getSharedPreferences(
      FloatingButtonService.PREFS_NAME,
      Context.MODE_PRIVATE,
    ).edit().putBoolean(FloatingButtonService.KEY_ENABLED, true).apply()
    val intent = Intent(reactContext, FloatingButtonService::class.java).apply {
      action = FloatingButtonService.ACTION_START
      if (!times.isNullOrEmpty()) {
        putExtra(FloatingButtonService.KEY_TIMES, times)
      }
    }
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
    }
      .onSuccess { promise.resolve(true) }
      .onFailure { promise.resolve(false) }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    reactContext.getSharedPreferences(
      FloatingButtonService.PREFS_NAME,
      Context.MODE_PRIVATE,
    ).edit().putBoolean(FloatingButtonService.KEY_ENABLED, false).apply()
    val intent = Intent(reactContext, FloatingButtonService::class.java).apply {
      action = FloatingButtonService.ACTION_STOP
    }
    runCatching { reactContext.startService(intent) }
    promise.resolve(null)
  }

  @ReactMethod
  fun consumePendingHide(promise: Promise) {
    val prefs = reactContext.getSharedPreferences(
      FloatingButtonService.PREFS_NAME,
      Context.MODE_PRIVATE,
    )
    val hidden = prefs.getBoolean(FloatingButtonService.KEY_PENDING_HIDE, false)
    if (hidden) {
      prefs.edit().remove(FloatingButtonService.KEY_PENDING_HIDE).apply()
    }
    promise.resolve(hidden)
  }

  companion object {
    const val NAME = "FloatingButton"
  }
}
