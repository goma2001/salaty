package com.goma.salat

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.app.NotificationManagerCompat

/**
 * Floating prayer button as a system overlay: a small dark-green pill
 * with gold text drawn above every app, even when صلاتي itself is
 * closed.
 *
 * Ported from the old Flutter Salaty's OverlayService
 * (com.goma.salaty): the same foreground service, the same pill, the
 * same wire format — the times arrive from JavaScript as
 * "style|<large|compact|icon>;hijri|<Hijri date>;title|<panel
 * title>;openapp|<open-app label>;nextlabel|…;quickmenu|…;qibla|…;
 * mute|…;azkar|…;hide|…;stop|…;adhannow|…;name|epochMs|HH:MM|Key;…"
 * (today's five prayers plus tomorrow's Fajr) and are persisted in
 * this service's own SharedPreferences, so a reboot restores the
 * last-known countdown without the app. The clock time rides in the
 * payload because native code never formats a time
 * (__tests__/noNativeTimeParsing.test.ts), and each entry carries its
 * canonical key (`Fajr`, `Dhuhr`, …) so the overlay can mute or stop
 * that prayer's adhan (the notification id is `pt-<epochMs>-<Key>`).
 * Payloads without the meta segments, the clock field or the key
 * (v1/v2) still parse: the panel then shows without the Hijri line and
 * with the app name on its title and open rows, a prayer without a
 * clock shows its name alone, the pill draws in the large shape, and
 * an entry without a key simply cannot be muted or stopped from the
 * overlay.
 *
 * - Foreground service (START_STICKY): the system restarts it if it
 *   is killed, and it survives the app being swiped away.
 * - Three shapes, chosen in Settings (1.0.11): large — the two-line
 *   pill ("العصر 15:08" above, the live countdown below, larger and
 *   bolder); compact — the same two texts on one line, about 45%
 *   smaller; icon — a small emerald circle with the app's glyph and a
 *   progress ring that drains as the next prayer approaches. The pill
 *   is draggable (position saved as screen fractions). A tap toggles
 *   the day's-times panel on the large and compact pills: today's five
 *   prayers with their times, the Hijri date on top, and a row that
 *   opens the app. The panel never takes focus; a tap outside it, the
 *   ✕, or another tap on the pill dismisses it. When a prayer time is
 *   reached the pill shows "حان الآن — <name>" for 60 seconds, then
 *   rolls to the next prayer automatically.
 * - The icon-only pill (1.0.11) carries four behaviours in one small
 *   circle: a single tap opens a glance card (the next prayer and its
 *   live countdown, closing itself after five seconds with a draining
 *   bar); a long-press opens a quick menu (live countdown on top, then
 *   open the app, the Qibla, mute the Fajr adhan, the adhkar, hide the
 *   button); the ring turns gold in the last hour before the next
 *   prayer, shows the minutes left as a badge, and pulses in the last
 *   ten minutes; and at the moment of the adhan it becomes a mini
 *   player — a sound wave, the prayer's name, a bar draining over the
 *   minute, and mute (silence this prayer's adhan next time) and stop
 *   (stop the adhan playing now) buttons. The adhan itself is the
 *   notification channel's sound, fired by the app's scheduled alert
 *   at the prayer time; the player is driven by the same instant this
 *   service already watches (the 60-second "حان الآن" window), and
 *   stop is cancelling that notification — the same as the full-screen
 *   alarm's Stop (PrayerAlarmActivity).
 * - Started ONLY from user action (the Settings toggle, through
 *   FloatingButtonModule) or from FloatingButtonBootReceiver after a
 *   reboot. Never started from app launch.
 * - If the overlay permission is revoked while running, the service
 *   stops itself instead of crashing.
 */
class FloatingButtonService : Service() {
  companion object {
    const val PREFS_NAME = "salaty_floating_button_prefs"
    const val KEY_ENABLED = "enabled"
    const val KEY_TIMES = "times" // "style|…;hijri|…;title|…;openapp|…;name|epochMs;…"
    const val KEY_POS_X = "pos_x" // pill-centre fraction of width
    const val KEY_POS_Y = "pos_y" // pill-centre fraction of height
    /** The pill's shape ('large' default). */
    const val KEY_STYLE = "style"
    /** Set by the quick menu's Hide; the app drains it and turns the
     *  Settings toggle off, so the next sync does not restart a pill
     *  the user just hid. */
    const val KEY_PENDING_HIDE = "pending_hide"
    const val ACTION_START = "com.goma.salat.overlay.START"
    const val ACTION_STOP = "com.goma.salat.overlay.STOP"
    private const val NOTIF_ID = 1001
    private const val CHANNEL_ID = "salaty_floating_button"
    private const val NOW_WINDOW_MS = 60_000L
    private const val LONG_PRESS_MS = 500L
    private const val GLANCE_MS = 5_000L
    private const val LAST_HOUR_MS = 60 * 60_000L
    private const val LAST_MINUTES_MS = 10 * 60_000L
    private const val MINUTE_MS = 60_000L
    /** The ring's calm green — the app's success green (tokens.ts). */
    private const val RING_CALM = "#3D9270"
    private const val GOLD = "#C9A227"
  }

  /** One parsed payload: the times plus the overlay's display strings. */
  private data class OverlayPayload(
    val times: List<PrayerTime>,
    val style: String?,
    val hijriDate: String?,
    val panelTitle: String?,
    val openAppLabel: String?,
    val nextPrayerLabel: String?,
    val quickMenuTitle: String?,
    val qiblaLabel: String?,
    val muteLabel: String?,
    val azkarLabel: String?,
    val hideLabel: String?,
    val stopLabel: String?,
    val adhanNowLabel: String?,
  )

  /** One prayer from the payload: name, instant, clock time, key. */
  private data class PrayerTime(
    val name: String,
    val at: Long,
    val clock: String?,
    val key: String?,
  )

  /** One row of the times panel, kept to refresh its highlight. */
  private data class PanelRowView(
    val name: TextView,
    val time: TextView,
    val at: Long,
  )

  private var windowManager: WindowManager? = null
  private var pillView: View? = null
  private var pillLine1: TextView? = null
  private var pillLine2: TextView? = null
  private var iconRing: ProgressBar? = null
  private var iconBadge: TextView? = null
  private var layoutParams: WindowManager.LayoutParams? = null
  private var pillShown = false
  private var currentStyle = "large"
  private var panelScrim: View? = null
  private var panelView: View? = null
  private var panelRowViews: List<PanelRowView> = emptyList()
  private var panelShown = false
  private var glanceScrim: View? = null
  private var glanceLine1: TextView? = null
  private var glanceLine2: TextView? = null
  private var glanceProgress: ProgressBar? = null
  private var glanceShown = false
  private var glanceShownAt = 0L
  private var menuScrim: View? = null
  private var menuCountdown: TextView? = null
  private var menuMuteRow: TextView? = null
  private var menuShown = false
  private var playerScrim: View? = null
  private var playerProgress: ProgressBar? = null
  private var playerShown = false
  private var playerPrayer: PrayerTime? = null
  /** Where the player anchors: under the pill's last place. */
  private var playerAnchorX = 0
  private var playerAnchorY = 0
  /** The prayer whose adhan the user stopped: its minute must not
   *  re-open the player while the window is still running. */
  private var stoppedAdhanEpoch: Long? = null
  private var waveAnimators: List<ObjectAnimator> = emptyList()
  private var pulseAnimator: ObjectAnimator? = null
  private val handler = Handler(Looper.getMainLooper())
  private var times: List<PrayerTime> = emptyList()
  private var hijriDate: String? = null
  private var panelTitle: String? = null
  private var openAppLabel: String? = null
  private var nextPrayerLabel: String? = null
  private var quickMenuTitle: String? = null
  private var qiblaLabel: String? = null
  private var muteLabel: String? = null
  private var azkarLabel: String? = null
  private var hideLabel: String? = null
  private var stopLabel: String? = null
  private var adhanNowLabel: String? = null
  private var ticking = false

  private val ticker = object : Runnable {
    override fun run() {
      updateOverlays()
      if (ticking) handler.postDelayed(this, 1000)
    }
  }

  private val glanceDismiss = Runnable { dismissGlance() }

  private val longPressRunnable = Runnable {
    if (pillShown && currentStyle == "icon" && !dragMoved) {
      longPressFired = true
      showQuickMenu()
    }
  }

  /** Drag state, shared with the long-press detector. */
  private var dragMoved = false
  private var longPressFired = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    loadTimesFromPrefs()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    intent?.getStringExtra(KEY_TIMES)?.let { raw ->
      val parsed = parseOverlayPayload(raw)
      if (parsed.times.isNotEmpty()) {
        applyPayload(parsed)
        saveTimesToPrefs(raw)
      }
    }
    if (times.isEmpty()) loadTimesFromPrefs()
    startAsForeground()
    showPill()
    startTicking()
    return START_STICKY
  }

  override fun onDestroy() {
    stopTicking()
    dismissPanel()
    dismissGlance()
    dismissQuickMenu()
    dismissPlayer()
    stopPulse()
    removePill()
    try {
      stopForeground(true)
    } catch (_: Exception) {
      // Already stopped; nothing to remove.
    }
    super.onDestroy()
  }

  // ---- foreground notification ----

  private fun startAsForeground() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
      val channel =
        NotificationChannel(
          CHANNEL_ID,
          "الزر العائم",
          NotificationManager.IMPORTANCE_LOW,
        )
      channel.description = "إشعار دائم أثناء عمل الزر العائم فوق التطبيقات"
      nm.createNotificationChannel(channel)
    }
    val openIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val notification = builder
      .setContentTitle("صلاتي")
      .setContentText("الزر العائم يعمل — الصلاة القادمة تظهر فوق التطبيقات")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(pending)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIF_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      @Suppress("DEPRECATION")
      startForeground(NOTIF_ID, notification)
    }
  }

  // ---- overlay pill ----

  private fun pillLayoutFor(style: String): Int =
    when (style) {
      "compact" -> R.layout.overlay_pill_compact
      "icon" -> R.layout.overlay_pill_icon
      else -> R.layout.overlay_pill
    }

  private fun showPill() {
    if (playerShown) return
    val style = currentStyle
    if (pillShown) {
      // The pill may be hidden behind the adhan player: bring it back.
      pillView?.visibility = View.VISIBLE
      updatePillText()
      return
    }
    if (!Settings.canDrawOverlays(this)) {
      // Permission revoked while running: stop instead of crashing.
      stopSelf()
      return
    }
    val wm = getSystemService(WINDOW_SERVICE) as WindowManager
    windowManager = wm
    val view = LayoutInflater.from(this).inflate(pillLayoutFor(style), null)
    pillLine1 = view.findViewById(R.id.overlay_pill_line1)
    pillLine2 = view.findViewById(R.id.overlay_pill_line2)
    iconRing = view.findViewById(R.id.overlay_icon_ring)
    iconBadge = view.findViewById(R.id.overlay_icon_badge)
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    // Measure first so the saved centre fractions place the pill
    // exactly (not its top-left corner).
    view.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val fx = prefs.getFloat(KEY_POS_X, 0.90f)
    val fy = prefs.getFloat(KEY_POS_Y, 0.10f)
    params.x = centreToX(fx, view.measuredWidth)
    params.y = centreToY(fy, view.measuredHeight)
    layoutParams = params
    attachDrag(view)
    try {
      wm.addView(view, params)
      pillView = view
      pillShown = true
    } catch (_: Exception) {
      // Overlay not allowed (permission revoked between the check
      // and the add): stop instead of crashing.
      stopSelf()
      return
    }
    updatePillText()
  }

  private fun removePill() {
    stopPulse()
    val view = pillView
    if (view != null && pillShown) {
      try {
        windowManager?.removeView(view)
      } catch (_: Exception) {
        // Already removed.
      }
    }
    pillView = null
    pillLine1 = null
    pillLine2 = null
    iconRing = null
    iconBadge = null
    layoutParams = null
    pillShown = false
  }

  /** Hide the pill behind the adhan player, remembering where it was
   *  so the player anchors under it. The view stays added (and its
   *  layout params stay put) — only its visibility goes. */
  private fun hidePillForPlayer() {
    val density = resources.displayMetrics.density
    playerAnchorX = layoutParams?.x ?: 0
    playerAnchorY =
      (layoutParams?.y ?: 0) + (pillView?.measuredHeight ?: 0) + (8 * density).toInt()
    pillView?.visibility = View.GONE
  }

  /** Re-draw the pill in a new shape (the setting changed). */
  private fun rebuildPill() {
    dismissPanel()
    dismissGlance()
    dismissQuickMenu()
    dismissPlayer()
    removePill()
    showPill()
  }

  private fun centreToX(fx: Float, pillWidth: Int): Int {
    val screenW = resources.displayMetrics.widthPixels
    val centre = (fx * screenW).toInt()
    return (centre - pillWidth / 2).coerceIn(0, (screenW - pillWidth).coerceAtLeast(0))
  }

  private fun centreToY(fy: Float, pillHeight: Int): Int {
    val screenH = resources.displayMetrics.heightPixels
    val centre = (fy * screenH).toInt()
    return (centre - pillHeight / 2).coerceIn(0, (screenH - pillHeight).coerceAtLeast(0))
  }

  private fun attachDrag(view: View) {
    val density = resources.displayMetrics.density
    val tapSlopPx = (12 * density).toInt()
    var downRawX = 0f
    var downRawY = 0f
    var startX = 0
    var startY = 0
    view.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          downRawX = event.rawX
          downRawY = event.rawY
          startX = layoutParams?.x ?: 0
          startY = layoutParams?.y ?: 0
          dragMoved = false
          longPressFired = false
          if (currentStyle == "icon") {
            handler.postDelayed(longPressRunnable, LONG_PRESS_MS)
          }
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = (event.rawX - downRawX).toInt()
          val dy = (event.rawY - downRawY).toInt()
          if (!dragMoved && dx * dx + dy * dy > tapSlopPx * tapSlopPx) {
            dragMoved = true
            handler.removeCallbacks(longPressRunnable)
          }
          if (dragMoved && !longPressFired) {
            val params = layoutParams
            if (params != null) {
              params.x = (startX + dx).coerceIn(
                0,
                (resources.displayMetrics.widthPixels - (pillView?.measuredWidth ?: 0)).coerceAtLeast(0),
              )
              params.y = (startY + dy).coerceIn(
                0,
                (resources.displayMetrics.heightPixels - (pillView?.measuredHeight ?: 0)).coerceAtLeast(0),
              )
              try {
                windowManager?.updateViewLayout(view, params)
              } catch (_: Exception) {
                // View gone; ignore.
              }
            }
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          handler.removeCallbacks(longPressRunnable)
          if (longPressFired) {
            // The menu is already open; the lift is not a tap.
            longPressFired = false
          } else if (!dragMoved) {
            onPillTap()
          } else {
            savePosition()
          }
          dragMoved = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          handler.removeCallbacks(longPressRunnable)
          dragMoved = false
          longPressFired = false
          true
        }
        else -> false
      }
    }
  }

  /** A tap: the times panel on the large and compact pills, the
   *  glance card on the icon-only pill. */
  private fun onPillTap() {
    if (currentStyle == "icon") {
      if (glanceShown) dismissGlance() else showGlance()
    } else {
      togglePanel()
    }
  }

  private fun savePosition() {
    val params = layoutParams ?: return
    val view = pillView ?: return
    val screenW = resources.displayMetrics.widthPixels.toFloat()
    val screenH = resources.displayMetrics.heightPixels.toFloat()
    if (screenW <= 0 || screenH <= 0) return
    val fx = (params.x + view.measuredWidth / 2f) / screenW
    val fy = (params.y + view.measuredHeight / 2f) / screenH
    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putFloat(KEY_POS_X, fx.coerceIn(0f, 1f))
      .putFloat(KEY_POS_Y, fy.coerceIn(0f, 1f))
      .apply()
  }

  private fun openApp() {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    startActivity(intent)
  }

  /**
   * Open the app on a `salaty://` route — the same explicit intent the
   * home-screen widgets use (GlanceSupport.openRoute): an ACTION_VIEW
   * intent with the app's package set, so the OS hands it to this app
   * and React Navigation's linking table does the rest.
   */
  private fun openRoute(uri: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    runCatching { startActivity(intent) }
  }

  // ---- today's-times panel ----

  private fun togglePanel() {
    if (panelShown) dismissPanel() else showPanel()
  }

  private fun showPanel() {
    if (panelShown) return
    val wm = windowManager ?: return
    if (!Settings.canDrawOverlays(this)) return
    val inflater = LayoutInflater.from(this)
    // A fullscreen transparent scrim: taps outside the panel dismiss
    // it, taps inside reach the panel. It never takes focus, so the
    // app underneath keeps what it was doing.
    val scrim = FrameLayout(this)
    val panel = inflater.inflate(R.layout.overlay_times_panel, scrim, false)
    val titleView = panel.findViewById<TextView>(R.id.overlay_panel_title)
    titleView.text = panelTitle ?: "صلاتي"
    val hijriView = panel.findViewById<TextView>(R.id.overlay_panel_hijri)
    if (hijriDate.isNullOrEmpty()) {
      hijriView.visibility = View.GONE
    } else {
      hijriView.visibility = View.VISIBLE
      hijriView.text = hijriDate
    }
    val rowsContainer = panel.findViewById<LinearLayout>(R.id.overlay_panel_rows)
    rowsContainer.removeAllViews()
    val rows = mutableListOf<PanelRowView>()
    // Today's five prayers: the payload's first five entries (the
    // sixth is tomorrow's Fajr, for the countdown past Isha).
    for ((name, at, clock) in times.take(5)) {
      val row = inflater.inflate(R.layout.overlay_times_row, rowsContainer, false)
      val nameView = row.findViewById<TextView>(R.id.overlay_row_name)
      val timeView = row.findViewById<TextView>(R.id.overlay_row_time)
      nameView.text = name
      if (clock == null) {
        // A v1 payload's entry has no clock: the name alone.
        timeView.visibility = View.GONE
      } else {
        timeView.visibility = View.VISIBLE
        timeView.text = clock
      }
      rowsContainer.addView(row)
      rows.add(PanelRowView(nameView, timeView, at))
    }
    panelRowViews = rows
    val openAppView = panel.findViewById<TextView>(R.id.overlay_panel_open_app)
    openAppView.text = openAppLabel ?: "صلاتي"
    openAppView.setOnClickListener {
      dismissPanel()
      openApp()
    }
    panel.findViewById<TextView>(R.id.overlay_panel_close)
      .setOnClickListener { dismissPanel() }
    // Measure first, then anchor under the pill, clamped on screen.
    val density = resources.displayMetrics.density
    panel.minimumWidth = (220 * density).toInt()
    panel.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    val screenW = resources.displayMetrics.widthPixels
    val screenH = resources.displayMetrics.heightPixels
    val pillParams = layoutParams
    val pillH = pillView?.measuredHeight ?: 0
    var x = pillParams?.x ?: 0
    var y = (pillParams?.y ?: 0) + pillH + (8 * density).toInt()
    x = x.coerceIn(0, (screenW - panel.measuredWidth).coerceAtLeast(0))
    y = y.coerceIn(0, (screenH - panel.measuredHeight).coerceAtLeast(0))
    val panelParams = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.WRAP_CONTENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.START,
    )
    panelParams.leftMargin = x
    panelParams.topMargin = y
    scrim.addView(panel, panelParams)
    panelView = panel
    scrim.setOnTouchListener { _, event ->
      if (event.action == MotionEvent.ACTION_DOWN) {
        val loc = IntArray(2)
        panel.getLocationOnScreen(loc)
        val inside = event.rawX >= loc[0] && event.rawX < loc[0] + panel.width &&
          event.rawY >= loc[1] && event.rawY < loc[1] + panel.height
        if (!inside) {
          dismissPanel()
          true
        } else {
          false
        }
      } else {
        false
      }
    }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    try {
      wm.addView(scrim, params)
      panelScrim = scrim
      panelShown = true
    } catch (_: Exception) {
      // Overlay not allowed: stay with the pill only.
      panelScrim = null
      panelView = null
      panelRowViews = emptyList()
      return
    }
    refreshPanelHighlight()
  }

  private fun dismissPanel() {
    val scrim = panelScrim
    if (scrim != null && panelShown) {
      try {
        windowManager?.removeView(scrim)
      } catch (_: Exception) {
        // Already removed.
      }
    }
    panelScrim = null
    panelView = null
    panelRowViews = emptyList()
    panelShown = false
  }

  /** Gold + bold for the next prayer's row, plain white for the rest. */
  private fun refreshPanelHighlight() {
    if (!panelShown) return
    val now = System.currentTimeMillis()
    val next = times.firstOrNull { it.at > now }
    val gold = Color.parseColor(GOLD)
    for (row in panelRowViews) {
      val isNext = next != null && row.at == next.at
      row.name.setTextColor(if (isNext) gold else Color.WHITE)
      row.name.setTypeface(null, if (isNext) Typeface.BOLD else Typeface.NORMAL)
    }
  }

  // ---- glance card (icon-only pill, single tap) ----

  private fun showGlance() {
    if (glanceShown) return
    val wm = windowManager ?: return
    if (!Settings.canDrawOverlays(this)) return
    val inflater = LayoutInflater.from(this)
    val scrim = FrameLayout(this)
    val card = inflater.inflate(R.layout.overlay_glance_card, scrim, false)
    val titleView = card.findViewById<TextView>(R.id.overlay_glance_title)
    titleView.text = nextPrayerLabel ?: "صلاتي"
    glanceLine1 = card.findViewById(R.id.overlay_glance_line1)
    glanceLine2 = card.findViewById(R.id.overlay_glance_line2)
    glanceProgress = card.findViewById(R.id.overlay_glance_progress)
    // Measure first, then anchor under the pill, clamped on screen —
    // the same anchoring as the times panel.
    val density = resources.displayMetrics.density
    card.minimumWidth = (200 * density).toInt()
    card.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    val screenW = resources.displayMetrics.widthPixels
    val screenH = resources.displayMetrics.heightPixels
    val pillParams = layoutParams
    val pillH = pillView?.measuredHeight ?: 0
    var x = pillParams?.x ?: 0
    var y = (pillParams?.y ?: 0) + pillH + (8 * density).toInt()
    x = x.coerceIn(0, (screenW - card.measuredWidth).coerceAtLeast(0))
    y = y.coerceIn(0, (screenH - card.measuredHeight).coerceAtLeast(0))
    val cardParams = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.WRAP_CONTENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.START,
    )
    cardParams.leftMargin = x
    cardParams.topMargin = y
    scrim.addView(card, cardParams)
    scrim.setOnTouchListener { _, event ->
      if (event.action == MotionEvent.ACTION_DOWN) {
        val loc = IntArray(2)
        card.getLocationOnScreen(loc)
        val inside = event.rawX >= loc[0] && event.rawX < loc[0] + card.width &&
          event.rawY >= loc[1] && event.rawY < loc[1] + card.height
        if (!inside) {
          dismissGlance()
          true
        } else {
          false
        }
      } else {
        false
      }
    }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    try {
      wm.addView(scrim, params)
    } catch (_: Exception) {
      glanceLine1 = null
      glanceLine2 = null
      glanceProgress = null
      return
    }
    glanceScrim = scrim
    glanceShown = true
    glanceShownAt = SystemClock.elapsedRealtime()
    handler.postDelayed(glanceDismiss, GLANCE_MS)
    updateGlance()
  }

  private fun dismissGlance() {
    handler.removeCallbacks(glanceDismiss)
    val scrim = glanceScrim
    if (scrim != null && glanceShown) {
      try {
        windowManager?.removeView(scrim)
      } catch (_: Exception) {
        // Already removed.
      }
    }
    glanceScrim = null
    glanceLine1 = null
    glanceLine2 = null
    glanceProgress = null
    glanceShown = false
  }

  /** The glance card's countdown and its five-second bar. */
  private fun updateGlance() {
    if (!glanceShown) return
    val now = System.currentTimeMillis()
    val next = times.firstOrNull { it.at > now }
    val line1 = glanceLine1
    val line2 = glanceLine2
    if (line1 != null && line2 != null) {
      if (next == null) {
        line1.text = "صلاتي"
        line2.visibility = View.GONE
      } else {
        line2.visibility = View.VISIBLE
        line1.text = if (next.clock != null) "${next.name} ${next.clock}" else next.name
        line2.text = formatHms(next.at - now)
      }
    }
    val elapsed = SystemClock.elapsedRealtime() - glanceShownAt
    glanceProgress?.progress = ((1f - elapsed.toFloat() / GLANCE_MS).coerceIn(0f, 1f) * 1000).toInt()
  }

  // ---- quick menu (icon-only pill, long-press) ----

  private fun showQuickMenu() {
    if (menuShown) return
    val wm = windowManager ?: return
    if (!Settings.canDrawOverlays(this)) return
    dismissGlance()
    val inflater = LayoutInflater.from(this)
    val scrim = FrameLayout(this)
    val menu = inflater.inflate(R.layout.overlay_quick_menu, scrim, false)
    val titleView = menu.findViewById<TextView>(R.id.overlay_menu_title)
    titleView.text = quickMenuTitle ?: "صلاتي"
    menuCountdown = menu.findViewById(R.id.overlay_menu_countdown)
    val openAppRow = menu.findViewById<TextView>(R.id.overlay_menu_open_app)
    openAppRow.text = openAppLabel ?: "صلاتي"
    openAppRow.setOnClickListener {
      dismissQuickMenu()
      openApp()
    }
    val qiblaRow = menu.findViewById<TextView>(R.id.overlay_menu_qibla)
    qiblaRow.text = qiblaLabel ?: "القبلة"
    qiblaRow.setOnClickListener {
      dismissQuickMenu()
      openRoute("salaty://qibla")
    }
    menuMuteRow = menu.findViewById(R.id.overlay_menu_mute)
    val muteRow = menuMuteRow
    if (muteRow != null) {
      muteRow.text = muteLabel ?: "كتم أذان الفجر"
      // Only when the payload names a Fajr to mute: an entry with the
      // canonical key, still ahead. A v1/v2 payload carries no keys,
      // and then the row stays hidden rather than muting the wrong one.
      val fajr = nextFajr()
      if (fajr == null) {
        muteRow.visibility = View.GONE
      } else {
        muteRow.visibility = View.VISIBLE
        muteRow.setOnClickListener {
          dismissQuickMenu()
          setAlertModeSilent(fajr.at, fajr.key ?: "Fajr", fajr.name)
        }
      }
    }
    val azkarRow = menu.findViewById<TextView>(R.id.overlay_menu_azkar)
    azkarRow.text = azkarLabel ?: "الأذكار"
    azkarRow.setOnClickListener {
      dismissQuickMenu()
      openRoute("salaty://duas")
    }
    val hideRow = menu.findViewById<TextView>(R.id.overlay_menu_hide)
    hideRow.text = hideLabel ?: "إخفاء الزر"
    hideRow.setOnClickListener { hideFromMenu() }
    // Measure first, then anchor under the pill, clamped on screen —
    // the same anchoring as the times panel.
    val density = resources.displayMetrics.density
    menu.minimumWidth = (220 * density).toInt()
    menu.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    val screenW = resources.displayMetrics.widthPixels
    val screenH = resources.displayMetrics.heightPixels
    val pillParams = layoutParams
    val pillH = pillView?.measuredHeight ?: 0
    var x = pillParams?.x ?: 0
    var y = (pillParams?.y ?: 0) + pillH + (8 * density).toInt()
    x = x.coerceIn(0, (screenW - menu.measuredWidth).coerceAtLeast(0))
    y = y.coerceIn(0, (screenH - menu.measuredHeight).coerceAtLeast(0))
    val menuParams = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.WRAP_CONTENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.START,
    )
    menuParams.leftMargin = x
    menuParams.topMargin = y
    scrim.addView(menu, menuParams)
    scrim.setOnTouchListener { _, event ->
      if (event.action == MotionEvent.ACTION_DOWN) {
        val loc = IntArray(2)
        menu.getLocationOnScreen(loc)
        val inside = event.rawX >= loc[0] && event.rawX < loc[0] + menu.width &&
          event.rawY >= loc[1] && event.rawY < loc[1] + menu.height
        if (!inside) {
          dismissQuickMenu()
          true
        } else {
          false
        }
      } else {
        false
      }
    }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    try {
      wm.addView(scrim, params)
    } catch (_: Exception) {
      menuCountdown = null
      menuMuteRow = null
      return
    }
    menuScrim = scrim
    menuShown = true
    updateMenuCountdown()
  }

  private fun dismissQuickMenu() {
    val scrim = menuScrim
    if (scrim != null && menuShown) {
      try {
        windowManager?.removeView(scrim)
      } catch (_: Exception) {
        // Already removed.
      }
    }
    menuScrim = null
    menuCountdown = null
    menuMuteRow = null
    menuShown = false
  }

  /** The quick menu's header countdown. */
  private fun updateMenuCountdown() {
    if (!menuShown) return
    val now = System.currentTimeMillis()
    val next = times.firstOrNull { it.at > now }
    val view = menuCountdown ?: return
    if (next == null) {
      view.text = "صلاتي"
      return
    }
    val name = if (next.clock != null) "${next.name} ${next.clock}" else next.name
    view.text = "$name — ${formatHms(next.at - now)}"
  }

  /** The next Fajr still ahead — the one the menu can mute. */
  private fun nextFajr(): PrayerTime? {
    val now = System.currentTimeMillis()
    return times.firstOrNull { it.key == "Fajr" && it.at > now }
  }

  /**
   * Set one occurrence's alert mode to silent — the quick menu's "mute
   * the Fajr adhan" and the mini player's mute. The same broadcast the
   * Live Activity's own mute button sends (MihrabLiveActivityActionReceiver),
   * so the same HeadlessJS task re-creates (here: cancels) the alert,
   * and the same override is stored for the resync. Works with the app
   * closed; the receiver refuses a past instant, so a stale tap mutes
   * nothing.
   */
  private fun setAlertModeSilent(epoch: Long, key: String, title: String) {
    val intent = Intent(this, MihrabLiveActivityActionReceiver::class.java).apply {
      action = MihrabLiveActivityActionReceiver.ACTION_SET_ALERT_MODE
      putExtra(MihrabLiveActivityActionReceiver.EXTRA_EPOCH, epoch)
      putExtra(MihrabLiveActivityActionReceiver.EXTRA_NAME, key)
      putExtra(MihrabLiveActivityActionReceiver.EXTRA_MODE, "silent")
      putExtra("title", title)
    }
    runCatching { sendBroadcast(intent) }
  }

  /** Hide the pill from the quick menu: stop now, and leave a flag the
   *  app drains on its next launch so the Settings toggle follows. */
  private fun hideFromMenu() {
    dismissQuickMenu()
    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_ENABLED, false)
      .putBoolean(KEY_PENDING_HIDE, true)
      .apply()
    stopSelf()
  }

  // ---- adhan mini player (icon-only pill, at the prayer time) ----

  /** The prayer whose time has just arrived, if one is in its minute. */
  private fun prayerInNowWindow(now: Long): PrayerTime? {
    val last = times.lastOrNull { it.at <= now } ?: return null
    return if (now - last.at < NOW_WINDOW_MS) last else null
  }

  private fun showPlayer(prayer: PrayerTime) {
    if (playerShown) return
    val wm = windowManager ?: return
    if (!Settings.canDrawOverlays(this)) return
    dismissGlance()
    dismissQuickMenu()
    val inflater = LayoutInflater.from(this)
    val scrim = FrameLayout(this)
    val player = inflater.inflate(R.layout.overlay_adhan_player, scrim, false)
    val titleView = player.findViewById<TextView>(R.id.overlay_player_title)
    titleView.text = adhanNowLabel ?: "الأذان الآن"
    val nameView = player.findViewById<TextView>(R.id.overlay_player_name)
    nameView.text = prayer.name
    playerProgress = player.findViewById(R.id.overlay_player_progress)
    val muteButton = player.findViewById<TextView>(R.id.overlay_player_mute)
    muteButton.text = muteLabel ?: "كتم أذان الفجر"
    // Mute silences this prayer's adhan the NEXT time it comes, so it
    // is offered only when a next occurrence is in the payload (for
    // Fajr, tomorrow's — the sixth entry; other prayers have none).
    val nextSame = times.firstOrNull { it.key == prayer.key && it.at > prayer.at }
    if (nextSame == null || prayer.key == null) {
      muteButton.visibility = View.GONE
    } else {
      muteButton.visibility = View.VISIBLE
      muteButton.setOnClickListener {
        setAlertModeSilent(nextSame.at, prayer.key, prayer.name)
      }
    }
    val stopButton = player.findViewById<TextView>(R.id.overlay_player_stop)
    stopButton.text = stopLabel ?: "إيقاف"
    stopButton.setOnClickListener { stopCurrentAdhan(prayer) }
    // Measure first, then anchor under the pill's place, clamped on
    // screen — the same anchoring as the times panel.
    val density = resources.displayMetrics.density
    player.minimumWidth = (220 * density).toInt()
    player.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    val screenW = resources.displayMetrics.widthPixels
    val screenH = resources.displayMetrics.heightPixels
    var x = playerAnchorX
    var y = playerAnchorY
    x = x.coerceIn(0, (screenW - player.measuredWidth).coerceAtLeast(0))
    y = y.coerceIn(0, (screenH - player.measuredHeight).coerceAtLeast(0))
    val playerParams = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.WRAP_CONTENT,
      FrameLayout.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.START,
    )
    playerParams.leftMargin = x
    playerParams.topMargin = y
    scrim.addView(player, playerParams)
    // No outside-tap dismiss: the player stays for its minute (or
    // until Stop), and taps outside it reach the app underneath — the
    // scrim is only the anchor, and it takes no touches itself.
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.START
    try {
      wm.addView(scrim, params)
    } catch (_: Exception) {
      playerProgress = null
      return
    }
    playerScrim = scrim
    playerShown = true
    playerPrayer = prayer
    startWave(player)
    updatePlayerProgress()
  }

  private fun dismissPlayer() {
    stopWave()
    val scrim = playerScrim
    if (scrim != null && playerShown) {
      try {
        windowManager?.removeView(scrim)
      } catch (_: Exception) {
        // Already removed.
      }
    }
    playerScrim = null
    playerProgress = null
    playerShown = false
    playerPrayer = null
  }

  /** The player's bar, draining over the minute after the prayer time. */
  private fun updatePlayerProgress() {
    if (!playerShown) return
    val prayer = playerPrayer ?: return
    val elapsed = System.currentTimeMillis() - prayer.at
    playerProgress?.progress =
      ((1f - elapsed.toFloat() / NOW_WINDOW_MS).coerceIn(0f, 1f) * 1000).toInt()
  }

  /**
   * Stop the adhan playing now: cancelling its notification is what
   * stops the channel's sound — the full-screen alarm's Stop does the
   * same (PrayerAlarmActivity: notifee posts with no tag and the id
   * string's hashCode). The player is then dismissed for this
   * prayer's minute, so the ticker does not re-open it at once.
   */
  private fun stopCurrentAdhan(prayer: PrayerTime) {
    val key = prayer.key
    if (key != null) {
      val id = "pt-${prayer.at}-$key"
      runCatching {
        NotificationManagerCompat.from(this).cancel(null, id.hashCode())
      }
    }
    stoppedAdhanEpoch = prayer.at
    dismissPlayer()
    showPill()
  }

  /** The sound wave: four bars rising and falling out of step. */
  private fun startWave(player: View) {
    stopWave()
    val bars = listOf(
      player.findViewById<View>(R.id.overlay_player_bar1),
      player.findViewById<View>(R.id.overlay_player_bar2),
      player.findViewById<View>(R.id.overlay_player_bar3),
      player.findViewById<View>(R.id.overlay_player_bar4),
    )
    val animators = mutableListOf<ObjectAnimator>()
    val durations = listOf(520L, 680L, 460L, 600L)
    val delays = listOf(0L, 160L, 320L, 90L)
    for ((i, bar) in bars.withIndex()) {
      bar.post { bar.pivotY = bar.height.toFloat() }
      val anim = ObjectAnimator.ofFloat(bar, "scaleY", 0.45f, 1f).apply {
        duration = durations[i]
        startDelay = delays[i]
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
      }
      anim.start()
      animators.add(anim)
    }
    waveAnimators = animators
  }

  private fun stopWave() {
    for (anim in waveAnimators) anim.cancel()
    waveAnimators = emptyList()
  }

  // ---- countdown ----

  private fun startTicking() {
    if (ticking) return
    ticking = true
    handler.post(ticker)
  }

  private fun stopTicking() {
    ticking = false
    handler.removeCallbacks(ticker)
  }

  /** One tick: the pill (or its player), and whatever overlay is open. */
  private fun updateOverlays() {
    if (currentStyle == "icon") {
      val now = System.currentTimeMillis()
      val inNow = prayerInNowWindow(now)
      if (inNow != null && inNow.at != stoppedAdhanEpoch) {
        if (!playerShown) {
          hidePillForPlayer()
          showPlayer(inNow)
        } else if (playerPrayer?.at != inNow.at) {
          // A new prayer arrived while the player was up.
          dismissPlayer()
          showPlayer(inNow)
        }
        updatePlayerProgress()
      } else {
        if (playerShown) {
          dismissPlayer()
          showPill()
        }
        updatePillText()
      }
    } else {
      updatePillText()
    }
    if (glanceShown) updateGlance()
    if (menuShown) updateMenuCountdown()
    if (panelShown) refreshPanelHighlight()
  }

  private fun updatePillText() {
    if (currentStyle == "icon") {
      updateIconPill()
      return
    }
    val line1 = pillLine1 ?: return
    val line2 = pillLine2 ?: return
    val now = System.currentTimeMillis()
    if (times.isEmpty()) {
      line1.text = "صلاتي"
      line2.visibility = View.GONE
      return
    }
    line2.visibility = View.VISIBLE
    // "حان الآن" for 60s after a prayer time, then roll on.
    val last = times.lastOrNull { it.at <= now }
    if (last != null && now - last.at < NOW_WINDOW_MS) {
      line1.text = "حان الآن — ${last.name}"
      val next = times.firstOrNull { it.at > now }
      if (next != null) {
        line2.text = formatHms(next.at - now)
      } else {
        line2.visibility = View.GONE
      }
      if (panelShown) refreshPanelHighlight()
      return
    }
    val next = times.firstOrNull { it.at > now }
    if (next == null) {
      // All stored times are past (stale — the app pushes fresh
      // times on the next launch).
      line1.text = "صلاتي"
      line2.visibility = View.GONE
      return
    }
    line1.text = if (next.clock != null) "${next.name} ${next.clock}" else next.name
    line2.text = formatHms(next.at - now)
    if (panelShown) refreshPanelHighlight()
  }

  /**
   * The icon-only pill: the ring drains as the next prayer approaches
   * — calm green most of the day, gold in the last hour, with the
   * minutes left as a badge, and pulsing in the last ten minutes.
   * The fraction is the wait that is left over the wait between the
   * previous prayer and the next; with no previous prayer in the
   * payload (the first Fajr of the day) the ring stays full.
   */
  private fun updateIconPill() {
    val ring = iconRing ?: return
    val badge = iconBadge
    val now = System.currentTimeMillis()
    if (times.isEmpty()) {
      ring.progress = 1000
      ring.progressTintList = ColorStateList.valueOf(Color.parseColor(RING_CALM))
      badge?.visibility = View.GONE
      stopPulse()
      return
    }
    val next = times.firstOrNull { it.at > now } ?: run {
      ring.progress = 0
      ring.progressTintList = ColorStateList.valueOf(Color.parseColor(GOLD))
      badge?.visibility = View.GONE
      stopPulse()
      return
    }
    val remaining = next.at - now
    val prev = times.lastOrNull { it.at <= now }
    val fraction = if (prev != null && next.at > prev.at) {
      (remaining.toFloat() / (next.at - prev.at)).coerceIn(0f, 1f)
    } else {
      1f
    }
    ring.progress = (fraction * 1000).toInt()
    when {
      remaining <= LAST_MINUTES_MS -> {
        ring.progressTintList = ColorStateList.valueOf(Color.parseColor(GOLD))
        badge?.let {
          it.visibility = View.VISIBLE
          it.text = ((remaining / MINUTE_MS).coerceAtLeast(1)).toString()
        }
        startPulse()
      }
      remaining <= LAST_HOUR_MS -> {
        ring.progressTintList = ColorStateList.valueOf(Color.parseColor(GOLD))
        badge?.let {
          it.visibility = View.VISIBLE
          it.text = ((remaining / MINUTE_MS).coerceAtLeast(1)).toString()
        }
        stopPulse()
      }
      else -> {
        ring.progressTintList = ColorStateList.valueOf(Color.parseColor(RING_CALM))
        badge?.visibility = View.GONE
        stopPulse()
      }
    }
  }

  private fun startPulse() {
    val view = pillView ?: return
    if (pulseAnimator != null) return
    val anim = ObjectAnimator.ofFloat(view, "alpha", 1f, 0.55f, 1f).apply {
      duration = 1200L
      repeatCount = ValueAnimator.INFINITE
    }
    anim.start()
    pulseAnimator = anim
  }

  private fun stopPulse() {
    pulseAnimator?.cancel()
    pulseAnimator = null
    pillView?.alpha = 1f
  }

  private fun formatHms(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return String.format("%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
  }

  // ---- persistence (this service's own prefs file) ----

  private fun applyPayload(payload: OverlayPayload) {
    val newStyle = payload.style?.takeIf { it in setOf("large", "compact", "icon") } ?: "large"
    val styleChanged = newStyle != currentStyle
    times = payload.times
    currentStyle = newStyle
    hijriDate = payload.hijriDate
    panelTitle = payload.panelTitle
    openAppLabel = payload.openAppLabel
    nextPrayerLabel = payload.nextPrayerLabel
    quickMenuTitle = payload.quickMenuTitle
    qiblaLabel = payload.qiblaLabel
    muteLabel = payload.muteLabel
    azkarLabel = payload.azkarLabel
    hideLabel = payload.hideLabel
    stopLabel = payload.stopLabel
    adhanNowLabel = payload.adhanNowLabel
    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_STYLE, newStyle)
      .apply()
    if (styleChanged && pillShown) {
      // A new shape while the pill is up: re-draw it (and drop any
      // overlay anchored to the old one).
      rebuildPill()
      return
    }
    if (panelShown) {
      // Fresh times while the panel is open: rebuild it.
      dismissPanel()
      showPanel()
    }
    // Fresh times make the glance card, the quick menu and the player
    // stale: close them rather than show yesterday's prayer.
    if (glanceShown) dismissGlance()
    if (menuShown) dismissQuickMenu()
    if (playerShown) {
      dismissPlayer()
      showPill()
    }
  }

  /**
   * The wire format (see src/services/floatingButton.ts):
   * "style|…;hijri|…;title|…;openapp|…;nextlabel|…;quickmenu|…;
   * qibla|…;mute|…;azkar|…;hide|…;stop|…;adhannow|…;
   * name|epochMs|HH:MM|Key;…". Every meta segment is optional, and so
   * are the clock field and the key — a v1 payload ("name|epochMs;…")
   * parses to times with no labels, no clock and no key.
   */
  private fun parseOverlayPayload(raw: String): OverlayPayload {
    val times = mutableListOf<PrayerTime>()
    var style: String? = null
    var hijri: String? = null
    var title: String? = null
    var openApp: String? = null
    var nextLabel: String? = null
    var quickMenu: String? = null
    var qibla: String? = null
    var mute: String? = null
    var azkar: String? = null
    var hide: String? = null
    var stop: String? = null
    var adhanNow: String? = null
    for (part in raw.split(";")) {
      when {
        part.startsWith("style|") ->
          style = part.removePrefix("style|").takeIf { it.isNotEmpty() }
        part.startsWith("hijri|") ->
          hijri = part.removePrefix("hijri|").takeIf { it.isNotEmpty() }
        part.startsWith("title|") ->
          title = part.removePrefix("title|").takeIf { it.isNotEmpty() }
        part.startsWith("openapp|") ->
          openApp = part.removePrefix("openapp|").takeIf { it.isNotEmpty() }
        part.startsWith("nextlabel|") ->
          nextLabel = part.removePrefix("nextlabel|").takeIf { it.isNotEmpty() }
        part.startsWith("quickmenu|") ->
          quickMenu = part.removePrefix("quickmenu|").takeIf { it.isNotEmpty() }
        part.startsWith("qibla|") ->
          qibla = part.removePrefix("qibla|").takeIf { it.isNotEmpty() }
        part.startsWith("mute|") ->
          mute = part.removePrefix("mute|").takeIf { it.isNotEmpty() }
        part.startsWith("azkar|") ->
          azkar = part.removePrefix("azkar|").takeIf { it.isNotEmpty() }
        part.startsWith("hide|") ->
          hide = part.removePrefix("hide|").takeIf { it.isNotEmpty() }
        part.startsWith("stop|") ->
          stop = part.removePrefix("stop|").takeIf { it.isNotEmpty() }
        part.startsWith("adhannow|") ->
          adhanNow = part.removePrefix("adhannow|").takeIf { it.isNotEmpty() }
        else -> {
          val fields = part.split("|")
          if (fields.size < 2) continue
          val ms = fields[1].toLongOrNull() ?: continue
          val clock = fields.getOrNull(2)?.takeIf { it.isNotEmpty() }
          val key = fields.getOrNull(3)?.takeIf { it.isNotEmpty() }
          times.add(PrayerTime(fields[0], ms, clock, key))
        }
      }
    }
    return OverlayPayload(
      times,
      style,
      hijri,
      title,
      openApp,
      nextLabel,
      quickMenu,
      qibla,
      mute,
      azkar,
      hide,
      stop,
      adhanNow,
    )
  }

  private fun saveTimesToPrefs(raw: String) {
    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_TIMES, raw)
      .apply()
  }

  private fun loadTimesFromPrefs() {
    val raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getString(KEY_TIMES, null) ?: return
    val parsed = parseOverlayPayload(raw)
    if (parsed.times.isNotEmpty()) applyPayload(parsed)
  }
}
