/**
 * The floating prayer button (Android only): the times payload the
 * native pill counts down from, and the sync that starts/stops it.
 *
 * The payload is the meta segments up front — the pill's shape, the
 * Hijri date, the tap panel's title and its open-app label, the
 * glance card's and quick menu's labels and the adhan player's stop
 * label — then today's five prayers plus tomorrow's Fajr, as
 * "name|epochMs|HH:MM|Key" — the wire format the old Flutter Salaty
 * used, which FloatingButtonService parses and persists. The clock
 * time rides in the payload because native code never formats a time
 * (`__tests__/noNativeTimeParsing.test.ts`), and the canonical key
 * rides with it so the overlay can mute or stop that prayer's adhan.
 * The instants come from `eventAt`, the one place that knows which
 * date a row's clock time falls on (an Isha past midnight belongs to
 * the next date). A payload without the meta segments, the clock field
 * or the key (v1/v2) still parses on the native side: the panel then
 * shows without the Hijri line and with the app name on its title and
 * open rows, the pill draws in the large shape, and a prayer without
 * a clock shows its name alone.
 */
import { Platform } from 'react-native';
import { readFileSync } from 'fs';
import path from 'path';
import i18n from '../src/i18n';
import {
  buildOverlayTimesPayload,
  consumePendingHide,
  syncFloatingButton,
} from '../src/services/floatingButton';
import {
  consumePendingHide as consumePendingHideNative,
  startFloatingButton,
  stopFloatingButton,
} from '../src/native/FloatingButton';

jest.mock('../src/native/FloatingButton', () => ({
  floatingButtonAvailable: true,
  startFloatingButton: jest.fn().mockResolvedValue(true),
  stopFloatingButton: jest.fn().mockResolvedValue(undefined),
  hasOverlayPermission: jest.fn().mockResolvedValue(true),
  openOverlayPermissionSettings: jest.fn().mockResolvedValue(undefined),
  consumePendingHide: jest.fn().mockResolvedValue(false),
}));

const mockedStart = startFloatingButton as jest.Mock;
const mockedStop = stopFloatingButton as jest.Mock;
const mockedConsumeHide = consumePendingHideNative as jest.Mock;

const TODAY = {
  Fajr: '05:12',
  Sunrise: '06:30',
  Dhuhr: '12:05',
  Asr: '15:30',
  Maghrib: '18:02',
  Isha: '19:35',
};
const TOMORROW = {
  Fajr: '05:11',
  Sunrise: '06:29',
  Dhuhr: '12:05',
  Asr: '15:30',
  Maghrib: '18:03',
  Isha: '19:36',
};

describe('buildOverlayTimesPayload', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('is the meta segments, then today’s five prayers plus tomorrow’s Fajr', () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    const payload = buildOverlayTimesPayload(TODAY, TOMORROW, now, 'large');
    expect(payload).toBe(
      [
        'style|large',
        'hijri|9 Jumada II 1448',
        "title|Today's prayer times",
        'openapp|Open the app',
        'nextlabel|Next prayer',
        'quickmenu|Quick options',
        'qibla|Qibla',
        'mute|Mute Fajr adhan',
        'azkar|Azkar',
        'hide|Hide the button',
        'stop|Stop',
        'adhannow|Adhan now',
        `Fajr|${new Date(2026, 10, 19, 5, 12).getTime()}|05:12|Fajr`,
        `Dhuhr|${new Date(2026, 10, 19, 12, 5).getTime()}|12:05|Dhuhr`,
        `Asr|${new Date(2026, 10, 19, 15, 30).getTime()}|15:30|Asr`,
        `Maghrib|${new Date(2026, 10, 19, 18, 2).getTime()}|18:02|Maghrib`,
        `Isha|${new Date(2026, 10, 19, 19, 35).getTime()}|19:35|Isha`,
        `Fajr|${new Date(2026, 10, 20, 5, 11).getTime()}|05:11|Fajr`,
      ].join(';'),
    );
  });

  it('carries the pill’s shape in the payload', () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    expect(buildOverlayTimesPayload(TODAY, TOMORROW, now, 'compact')).toContain(
      'style|compact;',
    );
    expect(buildOverlayTimesPayload(TODAY, TOMORROW, now, 'icon')).toContain(
      'style|icon;',
    );
  });

  it('names the Hijri date, panel title and open-app label in the app’s language', async () => {
    await i18n.changeLanguage('ar');
    const now = new Date(2026, 10, 19, 10, 0, 0);
    const payload = buildOverlayTimesPayload(TODAY, TOMORROW, now, 'large');
    expect(payload).toContain('hijri|٩ جمادى الآخرة ١٤٤٨');
    expect(payload).toContain('title|مواقيت اليوم');
    expect(payload).toContain('openapp|فتح التطبيق');
    expect(payload).toContain('العصر|');
    expect(payload).toContain('|15:30');
    await i18n.changeLanguage('en');
  });

  it('names the prayers in the app’s language', async () => {
    await i18n.changeLanguage('ar');
    const now = new Date(2026, 10, 19, 10, 0, 0);
    const payload = buildOverlayTimesPayload(TODAY, TOMORROW, now, 'large');
    expect(payload).toContain('الفجر|');
    expect(payload).toContain('الظهر|');
    expect(payload).toContain('العصر|');
    expect(payload).toContain('المغرب|');
    expect(payload).toContain('العشاء|');
    await i18n.changeLanguage('en');
  });

  it('puts an Isha past midnight on the next date', () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    const payload = buildOverlayTimesPayload(
      { ...TODAY, Isha: '00:02' },
      TOMORROW,
      now,
      'large',
    );
    expect(payload).toContain(
      `Isha|${new Date(2026, 10, 20, 0, 2).getTime()}`,
    );
  });

  it('is null when the day’s times are not there yet', () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    expect(buildOverlayTimesPayload(null, TOMORROW, now, 'large')).toBeNull();
    expect(buildOverlayTimesPayload(undefined, TOMORROW, now, 'large')).toBeNull();
    expect(
      buildOverlayTimesPayload(
        { ...TODAY, Fajr: undefined } as never,
        TOMORROW,
        now,
        'large',
      ),
    ).toBeNull();
    expect(buildOverlayTimesPayload(TODAY, null, now, 'large')).toBeNull();
    expect(
      buildOverlayTimesPayload(
        TODAY,
        { ...TOMORROW, Fajr: undefined } as never,
        now,
        'large',
      ),
    ).toBeNull();
  });
});

describe('syncFloatingButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
  });

  it('starts the pill with the payload when enabled', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    await syncFloatingButton({ enabled: true, style: 'large', today: TODAY, tomorrow: TOMORROW, now });
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][0]).toContain(
      `Fajr|${new Date(2026, 10, 19, 5, 12).getTime()}`,
    );
    expect(mockedStop).not.toHaveBeenCalled();
  });

  it('passes the shape, the Hijri date and panel labels up front', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    await syncFloatingButton({ enabled: true, style: 'large', today: TODAY, tomorrow: TOMORROW, now });
    const payload = mockedStart.mock.calls[0][0] as string;
    expect(payload.startsWith('style|large;')).toBe(true);
    expect(payload).toContain('hijri|9 Jumada II 1448;');
    expect(payload).toContain("title|Today's prayer times;");
    expect(payload).toContain('openapp|Open the app;');
  });

  it('passes the chosen shape through', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    await syncFloatingButton({ enabled: true, style: 'icon', today: TODAY, tomorrow: TOMORROW, now });
    const payload = mockedStart.mock.calls[0][0] as string;
    expect(payload.startsWith('style|icon;')).toBe(true);
  });

  it('stops the pill when disabled, and never starts it', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    await syncFloatingButton({ enabled: false, style: 'large', today: TODAY, tomorrow: TOMORROW, now });
    expect(mockedStop).toHaveBeenCalledTimes(1);
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it('does nothing when the times are not there yet', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    await syncFloatingButton({ enabled: true, style: 'large', today: null, tomorrow: TOMORROW, now });
    expect(mockedStart).not.toHaveBeenCalled();
    expect(mockedStop).not.toHaveBeenCalled();
  });

  it('is an Android-only no-op elsewhere', async () => {
    const now = new Date(2026, 10, 19, 10, 0, 0);
    Platform.OS = 'ios';
    await syncFloatingButton({ enabled: true, style: 'large', today: TODAY, tomorrow: TOMORROW, now });
    expect(mockedStart).not.toHaveBeenCalled();
    expect(mockedStop).not.toHaveBeenCalled();
  });
});

describe('the native side is wired up', () => {
  const repo = (...parts: string[]) =>
    readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const kt = (name: string) =>
    repo('android', 'app', 'src', 'main', 'java', 'com', 'goma', 'salat', `${name}.kt`);
  const manifest = repo('android', 'app', 'src', 'main', 'AndroidManifest.xml');

  it('the manifest declares the permission, the service and the boot receiver', () => {
    expect(manifest).toContain(
      '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />',
    );
    expect(manifest).toMatch(/android:name="\.FloatingButtonService"/);
    expect(manifest).toMatch(/android:foregroundServiceType="specialUse"/);
    expect(manifest).toMatch(/android:name="\.FloatingButtonBootReceiver"/);
    expect(manifest).toMatch(/android\.intent\.action\.BOOT_COMPLETED/);
  });

  it('the module is registered with React Native', () => {
    expect(kt('MainApplication')).toContain('add(FloatingButtonPackage())');
    expect(kt('FloatingButtonPackage')).toMatch(
      /listOf\(FloatingButtonModule\(reactContext\)\)/,
    );
    expect(kt('FloatingButtonModule')).toContain('override fun getName(): String = NAME');
    expect(kt('FloatingButtonModule')).toContain('const val NAME = "FloatingButton"');
  });

  it('the service is a sticky foreground service that draws an overlay pill', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/return START_STICKY/);
    expect(service).toMatch(/TYPE_APPLICATION_OVERLAY/);
    expect(service).toMatch(/Settings\.canDrawOverlays\(this\)/);
    expect(service).toMatch(/R\.layout\.overlay_pill/);
    expect(service).toMatch(/حان الآن/);
    expect(service).toMatch(/FOREGROUND_SERVICE_TYPE_SPECIAL_USE/);
  });

  it('the service stops, rather than starting, when told to stop', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(
      /if \(intent\?\.action == ACTION_STOP\) \{\s*stopSelf\(\)/,
    );
  });

  it('the boot receiver only restarts the pill when the user enabled it', () => {
    const receiver = kt('FloatingButtonBootReceiver');
    expect(receiver).toMatch(/ACTION_BOOT_COMPLETED/);
    expect(receiver).toMatch(
      /if \(!prefs\.getBoolean\(FloatingButtonService\.KEY_ENABLED, false\)\) return/,
    );
  });

  it('the pill layout is the deep-emerald pill with gold text', () => {
    const layout = repo('android', 'app', 'src', 'main', 'res', 'layout', 'overlay_pill.xml');
    expect(layout).toContain('android:background="@drawable/overlay_pill_bg"');
    expect(layout).toContain('android:textColor="#C9A227"');
    const bg = repo('android', 'app', 'src', 'main', 'res', 'drawable', 'overlay_pill_bg.xml');
    expect(bg).toContain('<solid android:color="#01543F" />');
    expect(bg).toContain('<stroke android:width="1dp" android:color="#C9A227" />');
  });
});

describe('the v2 pill and times panel (native side)', () => {
  const repo = (...parts: string[]) =>
    readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const kt = (name: string) =>
    repo('android', 'app', 'src', 'main', 'java', 'com', 'goma', 'salat', `${name}.kt`);

  it('the pill has two lines: prayer + clock time above, countdown below, larger and bolder', () => {
    const layout = repo('android', 'app', 'src', 'main', 'res', 'layout', 'overlay_pill.xml');
    expect(layout).toContain('android:id="@+id/overlay_pill_line1"');
    expect(layout).toContain('android:id="@+id/overlay_pill_line2"');
    expect(layout).toContain('android:orientation="vertical"');
    expect(layout).toMatch(/overlay_pill_line1"[\s\S]*?android:textSize="12sp"/);
    expect(layout).toMatch(/overlay_pill_line2"[\s\S]*?android:textSize="18sp"/);
    expect(layout).toMatch(/overlay_pill_line2"[\s\S]*?android:textStyle="bold"/);
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/line1\.text = if \(next\.clock != null\) "\$\{next\.name\} \$\{next\.clock\}" else next\.name/);
    expect(service).toMatch(/line2\.text = formatHms\(next\.at - now\)/);
    expect(service).toContain('حان الآن');
    // The clock time comes from the payload, never from native
    // formatting (see noNativeTimeParsing.test.ts).
    expect(service).not.toContain('SimpleDateFormat');
    expect(service).not.toContain('formatClock');
  });

  it('the service parses the meta segments, and tolerates a v1 payload without them', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/part\.startsWith\("hijri\|"\)/);
    expect(service).toMatch(/part\.startsWith\("title\|"\)/);
    expect(service).toMatch(/part\.startsWith\("openapp\|"\)/);
    expect(service).toMatch(/val hijriDate: String\?/);
    expect(service).toMatch(/val panelTitle: String\?/);
    expect(service).toMatch(/val openAppLabel: String\?/);
    // A v1 entry has no clock field: the clock is optional.
    expect(service).toContain('fields.getOrNull(2)');
    expect(service).toMatch(/val clock = fields\.getOrNull\(2\)\?\.takeIf \{ it\.isNotEmpty\(\) \}/);
    // No Hijri date: the panel hides the line instead of crashing.
    expect(service).toMatch(/if \(hijriDate\.isNullOrEmpty\(\)\) \{\s*hijriView\.visibility = View\.GONE/);
    // No title or open-app label: the app name stands in.
    expect(service).toContain('titleView.text = panelTitle ?: "صلاتي"');
    expect(service).toContain('openAppView.text = openAppLabel ?: "صلاتي"');
  });

  it('a tap opens the panel on the large and compact pills, and the glance card on the icon pill', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/private fun onPillTap\(\) \{\s*if \(currentStyle == "icon"\) \{\s*if \(glanceShown\) dismissGlance\(\) else showGlance\(\)\s*\} else \{\s*togglePanel\(\)/);
    expect(service).toContain('R.layout.overlay_times_panel');
    expect(service).toContain('R.layout.overlay_times_row');
    // Today's five prayers (the sixth entry is tomorrow's Fajr).
    expect(service).toContain('times.take(5)');
    expect(service).toMatch(/timeView\.text = clock/);
    // A v1 entry without a clock shows its name alone.
    expect(service).toMatch(/if \(clock == null\) \{[\s\S]*?timeView\.visibility = View\.GONE/);
    // The panel's window is focus-free, like the pill's.
    expect(service).toMatch(
      /WindowManager\.LayoutParams\(/s,
    );
    expect(service).toMatch(/FLAG_NOT_FOCUSABLE/);
    // Tap outside, the ✕, or the open-app row dismisses it.
    expect(service).toContain('dismissPanel()');
    expect(service).toContain('overlay_panel_close');
    expect(service).toContain('overlay_panel_open_app');
    expect(service).toMatch(/openAppView\.setOnClickListener \{\s*dismissPanel\(\)\s*openApp\(\)/);
  });

  it('the panel layout has its title, Hijri line, rows and open-app row', () => {
    const layout = repo('android', 'app', 'src', 'main', 'res', 'layout', 'overlay_times_panel.xml');
    expect(layout).toContain('android:id="@+id/overlay_panel_title"');
    expect(layout).toContain('android:id="@+id/overlay_panel_hijri"');
    expect(layout).toContain('android:id="@+id/overlay_panel_rows"');
    expect(layout).toContain('android:id="@+id/overlay_panel_open_app"');
    expect(layout).toContain('android:background="@drawable/overlay_panel_bg"');
    const bg = repo('android', 'app', 'src', 'main', 'res', 'drawable', 'overlay_panel_bg.xml');
    expect(bg).toContain('<solid android:color="#01543F" />');
    expect(bg).toContain('<stroke android:width="1dp" android:color="#C9A227" />');
  });

  it('the panel highlights the next prayer in gold', () => {
    const service = kt('FloatingButtonService');
    expect(service).toContain('refreshPanelHighlight()');
    // The gold is a named constant now, shared with the icon ring.
    expect(service).toMatch(/val gold = Color\.parseColor\(GOLD\)/);
    expect(service).toContain('GOLD = "#C9A227"');
  });

  it('the release is 1.0.11', () => {
    const pkg = JSON.parse(repo('package.json')) as { version: string };
    expect(pkg.version).toBe('1.0.11');
    const gradle = repo('android', 'app', 'build.gradle');
    expect(gradle).toContain('versionCode 12');
    expect(gradle).toContain('versionName "1.0.11"');
  });
});

describe('the v3 pill shapes and the icon pill’s merged behaviours (native side)', () => {
  const repo = (...parts: string[]) =>
    readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const kt = (name: string) =>
    repo('android', 'app', 'src', 'main', 'java', 'com', 'goma', 'salat', `${name}.kt`);
  const layout = (name: string) =>
    repo('android', 'app', 'src', 'main', 'res', 'layout', `${name}.xml`);

  it('the service reads the shape from the payload and re-draws the pill when it changes', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/part\.startsWith\("style\|"\)/);
    expect(service).toMatch(/val newStyle = payload\.style\?\.takeIf \{ it in setOf\("large", "compact", "icon"\) \} \?: "large"/);
    expect(service).toMatch(/val styleChanged = newStyle != currentStyle/);
    expect(service).toContain('rebuildPill()');
    expect(service).toMatch(/private fun pillLayoutFor\(style: String\): Int =/);
    expect(service).toMatch(/"compact" -> R\.layout\.overlay_pill_compact/);
    expect(service).toMatch(/"icon" -> R\.layout\.overlay_pill_icon/);
    // The shape persists across a service restart, like the times.
    expect(service).toContain('KEY_STYLE');
  });

  it('the compact pill is a single horizontal line, the icon pill a 56dp circle with a ring', () => {
    const compact = layout('overlay_pill_compact');
    expect(compact).toContain('android:id="@+id/overlay_pill_line1"');
    expect(compact).toContain('android:id="@+id/overlay_pill_line2"');
    expect(compact).toContain('android:orientation="horizontal"');
    const icon = layout('overlay_pill_icon');
    expect(icon).toContain('android:id="@+id/overlay_icon_ring"');
    expect(icon).toContain('android:id="@+id/overlay_icon_glyph"');
    expect(icon).toContain('android:id="@+id/overlay_icon_badge"');
    expect(icon).toContain('android:layout_width="56dp"');
    expect(icon).toContain('android:layout_height="56dp"');
  });

  it('a long press on the icon pill opens the quick menu, a drag cancels it', () => {
    const service = kt('FloatingButtonService');
    expect(service).toContain('LONG_PRESS_MS = 500L');
    expect(service).toMatch(/if \(currentStyle == "icon"\) \{\s*handler\.postDelayed\(longPressRunnable, LONG_PRESS_MS\)/);
    // A drag past the tap slop cancels the pending long press.
    expect(service).toMatch(/dragMoved = true\s*handler\.removeCallbacks\(longPressRunnable\)/);
    // The lift after a long press is not a tap.
    expect(service).toMatch(/if \(longPressFired\) \{[\s\S]*?longPressFired = false\s*\} else if \(!dragMoved\) \{\s*onPillTap\(\)/);
  });

  it('the glance card shows the next prayer and countdown, and collapses after 5 seconds', () => {
    const service = kt('FloatingButtonService');
    expect(service).toContain('GLANCE_MS = 5_000L');
    expect(service).toMatch(/private fun showGlance\(\)/);
    expect(service).toContain('R.layout.overlay_glance_card');
    expect(service).toContain('overlay_glance_title');
    expect(service).toContain('overlay_glance_line1');
    expect(service).toContain('overlay_glance_line2');
    expect(service).toContain('overlay_glance_progress');
    const glance = layout('overlay_glance_card');
    expect(glance).toContain('android:id="@+id/overlay_glance_progress"');
    // The bar runs 1000 → 0 over the five seconds.
    expect(glance).toContain('android:max="1000"');
  });

  it('the quick menu has the live countdown header and its five actions', () => {
    const service = kt('FloatingButtonService');
    expect(service).toMatch(/private fun showQuickMenu\(\)/);
    expect(service).toContain('R.layout.overlay_quick_menu');
    for (const id of [
      'overlay_menu_title',
      'overlay_menu_countdown',
      'overlay_menu_open_app',
      'overlay_menu_qibla',
      'overlay_menu_mute',
      'overlay_menu_azkar',
      'overlay_menu_hide',
    ]) {
      expect(service).toContain(id);
    }
    expect(service).toMatch(/openRoute\("salaty:\/\/qibla"\)/);
    expect(service).toMatch(/openRoute\("salaty:\/\/duas"\)/);
  });

  it('the mute row sets the next Fajr’s alert mode directly, through the existing receiver', () => {
    const receiver = kt('MihrabLiveActivityActionReceiver');
    expect(receiver).toContain('ACTION_SET_ALERT_MODE');
    expect(receiver).toMatch(/"com\.goma\.salat\.ACTION_SET_ALERT_MODE"/);
    expect(receiver).toMatch(/LiveActivityAlertModes\.store\(prefs, epoch, name, coerced, ""\)/);
    const service = kt('FloatingButtonService');
    expect(service).toContain('ACTION_SET_ALERT_MODE');
    // A prayer without a next Fajr in the payload has no mute row.
    expect(service).toMatch(/val fajr = nextFajr\(\)/);
    expect(service).toMatch(/if \(fajr == null\) \{\s*muteRow\.visibility = View\.GONE/);
    expect(service).toContain('setAlertModeSilent(fajr.at, fajr.key ?: "Fajr", fajr.name)');
  });

  it('the icon ring turns gold in the last hour and pulses in the last 10 minutes', () => {
    const service = kt('FloatingButtonService');
    expect(service).toContain('LAST_HOUR_MS = 60 * 60_000L');
    expect(service).toContain('LAST_MINUTES_MS = 10 * 60_000L');
    // The calm green and the gold are named constants now.
    expect(service).toContain('RING_CALM = "#3D9270"');
    expect(service).toMatch(/ring\.progressTintList = ColorStateList\.valueOf\(Color\.parseColor\(RING_CALM\)\)/);
    expect(service).toMatch(/ring\.progressTintList = ColorStateList\.valueOf\(Color\.parseColor\(GOLD\)\)/);
    expect(service).toMatch(/it\.text = \(\(remaining \/ MINUTE_MS\)\.coerceAtLeast\(1\)\)\.toString\(\)/);
    expect(service).toContain('startPulse()');
    expect(service).toContain('stopPulse()');
  });

  it('the adhan mini player shows at the adhan moment, with mute, stop and a progress bar', () => {
    const service = kt('FloatingButtonService');
    expect(service).toContain('NOW_WINDOW_MS = 60_000L');
    expect(service).toMatch(/private fun showPlayer\(prayer: PrayerTime\)/);
    expect(service).toContain('R.layout.overlay_adhan_player');
    expect(service).toContain('overlay_player_mute');
    expect(service).toContain('overlay_player_stop');
    expect(service).toContain('overlay_player_progress');
    // Stop cancels the adhan notification the way PrayerAlarmActivity
    // does: the notification id is the prayer id's hash code.
    expect(service).toMatch(/val id = "pt-\$\{prayer\.at\}-\$key"/);
    expect(service).toMatch(/NotificationManagerCompat\.from\(this\)\.cancel\(null, id\.hashCode\(\)\)/);
  });

  it('the native module lets JS drain a hide left by the quick menu', () => {
    const module = kt('FloatingButtonModule');
    expect(module).toContain('consumePendingHide');
    expect(module).toContain('KEY_PENDING_HIDE');
    const service = kt('FloatingButtonService');
    expect(service).toContain('KEY_PENDING_HIDE');
  });

  it('the service still never formats a time of its own', () => {
    const service = kt('FloatingButtonService');
    expect(service).not.toContain('SimpleDateFormat');
    expect(service).not.toContain('formatClock');
    // The only time text the service writes is the countdown duration
    // and the strings the payload already carries.
    expect(service).toMatch(/private fun formatHms\(ms: Long\)/);
  });
});

describe('consumePendingHide', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
  });

  it('drains the flag the quick menu leaves behind', async () => {
    mockedConsumeHide.mockResolvedValueOnce(true);
    await expect(consumePendingHide()).resolves.toBe(true);
    expect(mockedConsumeHide).toHaveBeenCalledTimes(1);
  });

  it('is false when nothing was hidden', async () => {
    mockedConsumeHide.mockResolvedValueOnce(false);
    await expect(consumePendingHide()).resolves.toBe(false);
  });

  it('is an Android-only no-op elsewhere', async () => {
    Platform.OS = 'ios';
    await expect(consumePendingHide()).resolves.toBe(false);
    expect(mockedConsumeHide).not.toHaveBeenCalled();
  });
});
