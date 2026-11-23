/**
 * The floating prayer button's JavaScript side (Android only).
 *
 * The native service (FloatingButtonService) draws the pill and ticks
 * the countdown; all it needs from here is the times, in the wire
 * format the old Flutter Salaty used, extended with meta segments up
 * front (v2 — the pill's tap panel; v3 — the pill's shape and the
 * icon-only pill's glance card, quick menu and adhan mini player) and
 * the clock time on each entry (v2 — native code never formats a time;
 * see __tests__/noNativeTimeParsing.test.ts):
 *
 *   "style|<large|compact|icon>;hijri|<Hijri date label>;title|<panel
 *   title>;openapp|<open-app label>;nextlabel|<next-prayer label>;
 *   quickmenu|<quick-menu title>;qibla|<Qibla label>;mute|<mute-Fajr
 *   label>;azkar|<Azkar label>;hide|<hide-button label>;stop|<stop
 *   label>;adhannow|<adhan-now label>;name|epochMs|HH:MM|Key;name|epochMs|HH:MM|Key;..."
 *
 * — the pill's shape (large: the two-line pill; compact: one line;
 *   icon: a small circular icon with a progress ring), the Hijri date
 *   for today (the home card's day, `formatHijriLabel`, in the app's
 *   language), the panel's title and its "open the app" row, the
 *   glance card's and quick menu's labels and the adhan player's stop
 *   label and "adhan now" title, then today's five prayers plus tomorrow's Fajr, so the
 *   countdown keeps working after Isha. Each entry carries its clock
 *   time as the canonical 24-hour `HH:mm` the app computed
 *   (`formatLocalTime`), so the pill's first line and the panel's rows
 *   show it without native code ever parsing or formatting a time —
 *   and its canonical key (`Fajr`, `Dhuhr`, …), so the native side can
 *   tell which entry a Fajr is when the quick menu mutes its adhan or
 *   the mini player stops it (the notification id is
 *   `pt-<epochMs>-<Key>`). The service parses the meta segments by
 *   prefix and tolerates a payload without them (a v1 payload, or one
 *   stored before the update) — the panel then shows without the Hijri
 *   line and with the app name on its title and open rows, the pill
 *   draws in the large shape, and entries without the clock field (a
 *   v1 payload's "name|epochMs") show the name alone; an entry without
 *   a key simply cannot be muted or stopped from the overlay. The
 *   service persists the payload itself, so a reboot restores the
 *   last-known countdown without the app.
 *
 * `syncFloatingButton` is called from the same two places as
 * `syncLiveActivity` (HomeScreen focus + prayer-data change), so the
 * pill's times stay in step with the home screen. It never throws:
 * a missing module, missing times or a refused start is a silent
 * no-op — the Settings toggle is the source of truth, and the next
 * sync retries.
 *
 * The quick menu's Hide button stops the pill while the app is closed
 * and leaves a flag in the service's own preferences; `consumePendingHide`
 * reads (and clears) it, so the next sync can turn the Settings toggle
 * off instead of restarting a pill the user just hid.
 */
import { Platform } from 'react-native';
import i18n from '../i18n';
import { formatHijriLabel } from '../hijri/formatHijriLabel';
import type { TimingsMap } from '../types/prayer';
import type { PrayerAppSettings } from '../settings/types';
import { addDays, eventAt, formatLocalTime } from '../utils/prayerTimes';
import { WIDGET_ROW_KEYS } from '../widget/buildWidgetPayload';
import {
  consumePendingHide as consumePendingHideNative,
  floatingButtonAvailable,
  startFloatingButton,
  stopFloatingButton,
} from '../native/FloatingButton';

export type FloatingButtonStyle = PrayerAppSettings['floatingButtonStyle'];

/**
 * The payload the native pill needs, or null when the day's times are
 * not available yet. Names are the prayer names in the app's language
 * (`prayer.Fajr` etc.); instants come from `eventAt`, the one place
 * that knows which date a row's clock time falls on (an Isha past
 * midnight belongs to the next date); each entry also carries its
 * clock time as canonical 24-hour `HH:mm` (`formatLocalTime`), so the
 * native pill and panel never format a time themselves, and its
 * canonical key, so the overlay can mute or stop that prayer's adhan.
 * The meta segments up front carry the pill's shape, the Hijri date
 * and the tap panel's, glance card's, quick menu's and adhan player's
 * labels, also in the app's language.
 */
export function buildOverlayTimesPayload(
  today: TimingsMap | null | undefined,
  tomorrow: TimingsMap | null | undefined,
  now: Date,
  style: FloatingButtonStyle,
): string | null {
  if (!today) return null;
  const entries: { name: string; at: number; clock: string; key: string }[] = [];
  for (const key of WIDGET_ROW_KEYS) {
    const raw = today[key];
    if (!raw) return null;
    const at = eventAt(key, today, now);
    entries.push({
      name: i18n.t(`prayer.${key}`),
      at: at.getTime(),
      clock: formatLocalTime(at),
      key,
    });
  }
  const tomorrowFajr = tomorrow?.Fajr;
  if (!tomorrowFajr) return null;
  const fajrAt = eventAt('Fajr', tomorrow, addDays(now, 1));
  entries.push({
    name: i18n.t('prayer.Fajr'),
    at: fajrAt.getTime(),
    clock: formatLocalTime(fajrAt),
    key: 'Fajr',
  });
  const meta = [
    `style|${style}`,
    `hijri|${formatHijriLabel(now)}`,
    `title|${i18n.t('settings.floatingButtonPanelTitle')}`,
    `openapp|${i18n.t('settings.floatingButtonOpenApp')}`,
    `nextlabel|${i18n.t('settings.floatingButtonNextPrayer')}`,
    `quickmenu|${i18n.t('settings.floatingButtonQuickMenu')}`,
    `qibla|${i18n.t('settings.floatingButtonQibla')}`,
    `mute|${i18n.t('settings.floatingButtonMuteFajr')}`,
    `azkar|${i18n.t('settings.floatingButtonAzkar')}`,
    `hide|${i18n.t('settings.floatingButtonHide')}`,
    `stop|${i18n.t('settings.floatingButtonStop')}`,
    `adhannow|${i18n.t('settings.floatingButtonAdhanNow')}`,
  ];
  return [
    ...meta,
    ...entries.map(e => `${e.name}|${e.at}|${e.clock}|${e.key}`),
  ].join(';');
}

export type FloatingButtonSyncArgs = {
  enabled: boolean;
  style: FloatingButtonStyle;
  today: TimingsMap | null | undefined;
  tomorrow: TimingsMap | null | undefined;
  now: Date;
};

/**
 * Drive the floating button to match the supplied state. Idempotent —
 * call on settings change, on prayer-day data update, and on AppState
 * 'active'. Android only; a no-op everywhere else.
 */
export async function syncFloatingButton(
  args: FloatingButtonSyncArgs,
): Promise<void> {
  if (Platform.OS !== 'android' || !floatingButtonAvailable) return;
  if (!args.enabled) {
    await stopFloatingButton();
    return;
  }
  const payload = buildOverlayTimesPayload(
    args.today,
    args.tomorrow,
    args.now,
    args.style,
  );
  if (!payload) return;
  await startFloatingButton(payload);
}

/**
 * Whether the user hid the pill from its own quick menu while the app
 * was closed. The menu stops the service and leaves a flag behind;
 * this reads and clears it, so the caller can turn the Settings toggle
 * off instead of the next sync restarting a pill the user just hid.
 * False when there is no such flag, on a build without the module, or
 * anywhere but Android.
 */
export async function consumePendingHide(): Promise<boolean> {
  if (Platform.OS !== 'android' || !floatingButtonAvailable) return false;
  return consumePendingHideNative();
}
