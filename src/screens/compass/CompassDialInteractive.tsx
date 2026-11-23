import { memo, useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { useAppPalette } from '../../hooks/useAppPalette';
import type { CompassMode } from './useCompassSensor';
import { describeTurn } from './turnGuidance';
import { ARCH_GOLD, SPACING } from '../../theme/tokens';
import { TABULAR_MAX_FONT_SCALE, tabularNumeralStyle } from '../../theme/textScale';
import { TYPE } from '../../theme/typography';

/**
 * The interactive Qibla dial (1.0.11) — the alternative to the classic
 * instrument dial, chosen under Settings → Appearance.
 *
 * The same bearing, drawn as something to follow rather than read: a
 * gold beam from the centre toward a pulsing Kaaba marker, a big
 * reading of how far is left to turn, and plain words for which way —
 * "turn your phone right 123°" — with a glow and a confirmation when
 * the phone is facing the Qibla. The degree ring, its ticks and the
 * Arabic cardinals are the classic dial's; the signal arc is not
 * redrawn here, because the signal indicator under the dial already
 * carries it.
 *
 * Geography, not typography: the cardinals and ticks mark directions,
 * so nothing in here follows the writing direction. East stays east in
 * Arabic.
 */
export const DIAL = 280;
const C = DIAL / 2;
/** The degree ring. */
const R = C - 22;
const KAABA = 16;
/** The beam's half-angle, and how far its tip reaches. */
const BEAM_HALF_DEG = 14;
const BEAM_R = R - 30;
/** The halo around the Kaaba marker. */
const HALO = 36;

type CompassDialInteractiveProps = {
  mode: CompassMode;
  /** 0-360. Rotation of the needle relative to "Phone front". */
  needleDeg: number;
};

/** A point on a circle of radius `r` at `deg` clockwise from twelve o'clock. */
function polar(r: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

/** The beam's wedge, drawn pointing up (the group rotates it). */
function beamPath(): string {
  const a = polar(BEAM_R, -BEAM_HALF_DEG);
  const b = polar(BEAM_R, BEAM_HALF_DEG);
  return `M ${C} ${C} L ${a.x} ${a.y} A ${BEAM_R} ${BEAM_R} 0 0 1 ${b.x} ${b.y} Z`;
}

/**
 * Where the Kaaba marker lands on screen, after the beam's rotation —
 * the halo is a plain View, so it is placed here rather than in the SVG.
 */
function kaabaPoint(needleDeg: number): { x: number; y: number } {
  const tip = polar(R - 48, 0);
  const a = (needleDeg * Math.PI) / 180;
  const dx = tip.x - C;
  const dy = tip.y - C;
  return {
    x: C + dx * Math.cos(a) - dy * Math.sin(a),
    y: C + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

function CompassDialInteractiveImpl({ mode, needleDeg }: CompassDialInteractiveProps) {
  const { t } = useTranslation();
  const { palette } = useAppPalette();
  const live = mode === 'live';
  const turn = describeTurn(needleDeg);
  const aligned = turn.direction === 'aligned';

  // The halo breathes around the Kaaba marker while the sensor is live.
  const halo = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!live) return;
    const loop = Animated.loop(
      Animated.timing(halo, {
        toValue: 1,
        duration: 1600,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      halo.setValue(0);
    };
  }, [live, halo]);
  const haloScale = halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] });
  const haloOpacity = halo.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });

  const a11yLabel =
    live
      ? t('compass.a11yDialLive', { deg: Math.round(needleDeg) })
      : mode === 'checking'
        ? t('compass.a11yDialChecking')
        : t('compass.a11yDialUnavailable');

  const ink = palette.textSolid;
  const quiet = palette.mutedSolid;
  const accent = ARCH_GOLD;

  const cardinals: Array<[number, string]> = [
    [0, t('compass.north')],
    [90, t('compass.east')],
    [180, t('compass.south')],
    [270, t('compass.west')],
  ];

  // Inside the numeral ring (which sits at R − 24), so the Kaaba never
  // covers the figure it happens to be pointing at.
  const tip = polar(R - 48, 0);
  const kaaba = kaabaPoint(needleDeg);

  const guidance =
    turn.direction === 'aligned'
      ? t('compass.aligned')
      : turn.direction === 'right'
        ? t('compass.turnRight', { deg: turn.degrees })
        : t('compass.turnLeft', { deg: turn.degrees });

  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={a11yLabel}
        style={[styles.dial, (mode === 'unsupported' || mode === 'permission_denied') && styles.unsupported]}>
        <Svg width={DIAL} height={DIAL} viewBox={`0 0 ${DIAL} ${DIAL}`}>
          {/* The ring and its ticks. */}
          <Circle
            cx={C}
            cy={C}
            r={R}
            stroke={aligned && live ? accent : quiet}
            strokeOpacity={aligned && live ? 0.9 : 0.45}
            strokeWidth={aligned && live ? 2 : 1}
            fill="none"
          />
          {Array.from({ length: 36 }, (_, i) => i * 10).map(deg => {
            const major = deg % 30 === 0;
            const a = polar(R, deg);
            const b = polar(R - (major ? 10 : 5), deg);
            return (
              <Line
                key={deg}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={major ? ink : quiet}
                strokeOpacity={major ? 0.8 : 0.5}
                strokeWidth={major ? 1.5 : 1}
                strokeLinecap="round"
              />
            );
          })}
          {/* Numerals at 30°, where there is no cardinal. */}
          {[30, 60, 120, 150, 210, 240, 300, 330].map(deg => {
            const p = polar(R - 24, deg);
            return (
              <SvgText
                key={deg}
                x={p.x}
                y={p.y + 3.5}
                fill={quiet}
                fontSize={10}
                fontWeight="400"
                textAnchor="middle">
                {deg}
              </SvgText>
            );
          })}
          {/* The cardinals. North is the one that matters, so it is the
              one in ink and weight; the others are lighter. */}
          {cardinals.map(([deg, label]) => {
            const p = polar(R - 24, deg);
            return (
              <SvgText
                key={deg}
                x={p.x}
                y={p.y + 5}
                fill={deg === 0 ? ink : quiet}
                fontSize={deg === 0 ? 15 : 13}
                fontWeight={deg === 0 ? '500' : '400'}
                textAnchor="middle">
                {label}
              </SvgText>
            );
          })}

          {/* Phone front: a small filled marker just outside the ring at
              twelve o'clock. The beam is read against it. */}
          <Path
            d={`M ${C - 6} ${C - R - 14} L ${C + 6} ${C - R - 14} L ${C} ${C - R - 4} Z`}
            fill={accent}
          />

          {live ? (
            <G transform={`rotate(${needleDeg} ${C} ${C})`}>
              {/* The beam: a wedge of gold from the centre to the Kaaba. */}
              <Path d={beamPath()} fill={accent} fillOpacity={0.16} />
              {/* Counterweight, so the beam reads as pivoting rather than
                  sprouting from the centre. */}
              <Line x1={C} y1={C} x2={C} y2={C + 26} stroke={quiet} strokeWidth={2.5} strokeLinecap="round" strokeOpacity={0.6} />
              {/* The needle. */}
              <Line x1={C} y1={C} x2={tip.x} y2={tip.y + KAABA / 2 + 2} stroke={accent} strokeWidth={2.5} strokeLinecap="round" />
              {/* The Kaaba at its tip: a cube with its band. */}
              <Rect x={C - KAABA / 2} y={tip.y - KAABA / 2} width={KAABA} height={KAABA} rx={2} fill={accent} />
              <Rect x={C - KAABA / 2} y={tip.y - KAABA / 2 + 4} width={KAABA} height={2.5} fill={palette.onAccent} opacity={0.9} />
            </G>
          ) : null}

          {/* The pin. */}
          <Circle cx={C} cy={C} r={5} fill={live ? accent : quiet} />
          <Circle cx={C} cy={C} r={2} fill={palette.onAccent} />

          {mode === 'unsupported' || mode === 'permission_denied' ? (
            <Line x1={C - 40} y1={C} x2={C + 40} y2={C} stroke={quiet} strokeWidth={2} strokeLinecap="round" />
          ) : null}
        </Svg>

        {/* The halo around the Kaaba marker, breathing while live. */}
        {live ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.halo,
              {
                left: kaaba.x - HALO / 2,
                top: kaaba.y - HALO / 2,
                borderColor: accent,
                opacity: haloOpacity,
                transform: [{ scale: haloScale }],
              },
            ]}
          />
        ) : null}

        {mode === 'checking' ? (
          <View style={styles.centre} pointerEvents="none">
            <ActivityIndicator size="large" color={palette.accent} />
          </View>
        ) : null}
      </View>

      {/* How far is left to turn, and which way — the big reading. */}
      {live ? (
        <View style={styles.reading} accessible accessibilityLabel={guidance}>
          <Text
            style={[styles.degrees, tabularNumeralStyle, { color: aligned ? accent : palette.text }]}
            maxFontSizeMultiplier={TABULAR_MAX_FONT_SCALE}
            accessibilityLanguage="en-US">
            {`${turn.degrees}°`}
          </Text>
          <Text style={[styles.guidance, { color: aligned ? accent : palette.muted }]}>
            {guidance}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const CompassDialInteractive = memo(CompassDialInteractiveImpl);

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: SPACING.sm },
  dial: { width: DIAL, height: DIAL, alignItems: 'center', justifyContent: 'center' },
  unsupported: { opacity: 0.5 },
  centre: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    borderWidth: 2,
  },
  reading: { alignItems: 'center', marginTop: SPACING.sm },
  degrees: {
    fontSize: TYPE.display.fontSize,
    lineHeight: TYPE.display.lineHeight,
    fontWeight: '400',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  guidance: { fontSize: TYPE.callout.fontSize, lineHeight: 20, textAlign: 'center', marginTop: 2 },
});
