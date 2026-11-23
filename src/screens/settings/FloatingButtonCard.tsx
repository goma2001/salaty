import { memo, useEffect, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useLiveActivitySettings } from '../../context/PrayerSettingsContext';
import { useAppPalette } from '../../hooks/useAppPalette';
import {
  hasOverlayPermission,
  openOverlayPermissionSettings,
} from '../../native/FloatingButton';
import {
  SettingsBlock,
  SettingsGroup,
  SettingsLinkRow,
  SettingsToggleRow,
} from './SettingsGroup';
import { RADIUS, SPACING } from '../../theme/tokens';
import { TYPE } from '../../theme/typography';
import type { FloatingButtonStyle } from '../../services/floatingButton';

/**
 * Whether the system currently lets the app draw over other apps,
 * asked when the page opens and each time the app comes back to the
 * front — which is how the reader returns from the system page that
 * grants it. Asked even while the toggle is off, so turning it on
 * knows at once whether to send the reader to the system page.
 * Null while unasked (or not Android).
 */
function useOverlayPermission(): boolean | null {
  const [permitted, setPermitted] = useState<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let live = true;
    const ask = () => {
      void hasOverlayPermission().then(p => {
        if (live) setPermitted(p);
      });
    };
    ask();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') ask();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return permitted;
}

const STYLE_OPTIONS: { id: FloatingButtonStyle; labelKey: string }[] = [
  { id: 'large', labelKey: 'settings.floatingButtonStyleLarge' },
  { id: 'compact', labelKey: 'settings.floatingButtonStyleCompact' },
  { id: 'icon', labelKey: 'settings.floatingButtonStyleIcon' },
];

/**
 * Floating prayer button card (Android only).
 *
 * A small pill drawn above other apps — next prayer + live countdown —
 * through a foreground service (FloatingButtonService). The toggle is
 * the master switch; the pill's times are pushed from the home screen
 * whenever the day's times change (see src/services/floatingButton.ts).
 * The shape picker (large two-line pill, compact one-line pill, or a
 * small circular icon with a progress ring) is the same choice the
 * service draws; changing it re-pushes the pill at once through the
 * home screen's sync.
 *
 * The pill needs the system's "Draw over other apps" permission. When
 * the toggle is on and the permission is missing, a link row sends the
 * reader to the system page that grants it; turning the toggle on
 * without the permission opens that page straight away. Off by default
 * — existing users see no change unless they opt in.
 */
function FloatingButtonCardImpl() {
  const { t } = useTranslation();
  const { slice: settings, update } = useLiveActivitySettings();
  const { palette } = useAppPalette();
  const permitted = useOverlayPermission();

  // No overlay exists on iOS, on the web or on desktop — hide the card.
  if (Platform.OS !== 'android') return null;

  const blocked =
    settings.floatingButtonEnabled && permitted === false;

  // Coerce any legacy stored value to the current options.
  const style: FloatingButtonStyle =
    settings.floatingButtonStyle === 'compact'
      ? 'compact'
      : settings.floatingButtonStyle === 'icon'
        ? 'icon'
        : 'large';

  return (
    <SettingsGroup title={t('settings.floatingButton')}>
      <SettingsToggleRow
        title={t('settings.floatingButton')}
        help={t('settings.floatingButtonHelp')}
        value={settings.floatingButtonEnabled}
        onValueChange={v => {
          update({ floatingButtonEnabled: v });
          // Turning it on without the permission: take the reader to
          // the system page that grants it, so the pill can start.
          if (v && permitted === false) {
            void openOverlayPermissionSettings();
          }
        }}
      />

      {settings.floatingButtonEnabled ? (
        <SettingsBlock>
          <Text style={[styles.label, { color: palette.muted }]}>
            {t('settings.floatingButtonStyleLabel', { defaultValue: 'Shape' })}
          </Text>
          <View style={styles.optionRow}>
            {STYLE_OPTIONS.map(opt => {
              const selected = style === opt.id;
              return (
                <Pressable
                  key={opt.id}
                  testID={`floating-button-style-${opt.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => update({ floatingButtonStyle: opt.id })}
                  style={[
                    styles.option,
                    {
                      borderColor: selected ? palette.accent : palette.border,
                      backgroundColor: selected ? palette.accentBg : 'transparent',
                      borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                    },
                  ]}>
                  <Text
                    style={[
                      styles.optionLabel,
                      { color: selected ? palette.accent : palette.text },
                    ]}>
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.help, { color: palette.muted }]}>
            {t('settings.floatingButtonStyleHelp')}
          </Text>
        </SettingsBlock>
      ) : null}

      {blocked ? (
        <SettingsLinkRow
          testID="floating-button-blocked"
          title={t('settings.floatingButtonPermissionTitle')}
          value={t('settings.floatingButtonPermissionAction')}
          help={t('settings.floatingButtonPermissionHelp')}
          onPress={() => void openOverlayPermissionSettings()}
        />
      ) : null}
    </SettingsGroup>
  );
}

export const FloatingButtonCard = memo(FloatingButtonCardImpl);

const styles = StyleSheet.create({
  label: { fontSize: TYPE.footnote.fontSize, fontWeight: '400' },
  help: { fontSize: TYPE.footnote.fontSize, marginTop: SPACING.sm },
  optionRow: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.sm },
  option: {
    flex: 1,
    borderRadius: RADIUS.md,
    padding: SPACING.sm,
    alignItems: 'center',
  },
  optionLabel: { fontSize: TYPE.footnote.fontSize, fontWeight: '400' },
});
