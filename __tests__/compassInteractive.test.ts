/**
 * The interactive Qibla dial (1.0.11) — the alternative to the classic
 * instrument dial, chosen under Settings → Appearance.
 *
 * The bearing is untouched: `describeTurn` only turns the needle's
 * degrees into plain words ("turn your phone right 123°", or the
 * confirmation when it is facing the Qibla), and the dial draws the
 * same needle the classic one does, with a gold beam toward a pulsing
 * Kaaba marker. The setting defaults to the classic dial, so an
 * existing install sees nothing change until it chooses otherwise.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { DEFAULT_SETTINGS } from '../src/settings/types';
import { describeTurn } from '../src/screens/compass/turnGuidance';

const repo = (...parts: string[]) =>
  readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

describe('describeTurn', () => {
  it('is aligned at 0, and within 5° either way', () => {
    expect(describeTurn(0)).toEqual({ direction: 'aligned', degrees: 0 });
    expect(describeTurn(5)).toEqual({ direction: 'aligned', degrees: 0 });
    expect(describeTurn(-5)).toEqual({ direction: 'aligned', degrees: 0 });
    expect(describeTurn(359)).toEqual({ direction: 'aligned', degrees: 0 });
    expect(describeTurn(355)).toEqual({ direction: 'aligned', degrees: 0 });
  });

  it('turns right for a positive needle, left for a negative one', () => {
    expect(describeTurn(6)).toEqual({ direction: 'right', degrees: 6 });
    expect(describeTurn(90)).toEqual({ direction: 'right', degrees: 90 });
    expect(describeTurn(179)).toEqual({ direction: 'right', degrees: 179 });
    expect(describeTurn(-6)).toEqual({ direction: 'left', degrees: 6 });
    expect(describeTurn(-90)).toEqual({ direction: 'left', degrees: 90 });
    expect(describeTurn(-179)).toEqual({ direction: 'left', degrees: 179 });
  });

  it('takes the short way round, never more than 180°', () => {
    expect(describeTurn(270)).toEqual({ direction: 'left', degrees: 90 });
    expect(describeTurn(-270)).toEqual({ direction: 'right', degrees: 90 });
    expect(describeTurn(200)).toEqual({ direction: 'left', degrees: 160 });
    expect(describeTurn(-200)).toEqual({ direction: 'right', degrees: 160 });
    expect(describeTurn(180)).toEqual({ direction: 'right', degrees: 180 });
  });

  it('normalises a needle outside 0–360 first', () => {
    expect(describeTurn(366)).toEqual({ direction: 'right', degrees: 6 });
    expect(describeTurn(-366)).toEqual({ direction: 'left', degrees: 6 });
    expect(describeTurn(720)).toEqual({ direction: 'aligned', degrees: 0 });
  });
});

describe('the compass style setting', () => {
  it('defaults to the classic dial', () => {
    expect(DEFAULT_SETTINGS.compassStyle).toBe('classic');
  });

  it('is a segmented choice in Appearance, next to the sky band', () => {
    const card = repo('src', 'screens', 'settings', 'AppearanceCard.tsx');
    expect(card).toContain('appearance-compassStyle');
    expect(card).toContain('settings.compassStyleClassic');
    expect(card).toContain('settings.compassStyleInteractive');
    expect(card).toContain('settings.compassStyleHelp');
    expect(card).toMatch(/compassStyle === 'interactive'/);
  });

  it('switches the dial the compass screen draws', () => {
    const screen = repo('src', 'screens', 'CompassScreen.tsx');
    expect(screen).toContain('CompassDialInteractive');
    expect(screen).toMatch(/settings\.compassStyle === 'interactive'/);
    expect(screen).toContain('CompassDial');
  });
});

describe('the interactive dial', () => {
  const dial = repo('src', 'screens', 'compass', 'CompassDialInteractive.tsx');

  it('draws the degree ring, its ticks, numerals and Arabic cardinals', () => {
    expect(dial).toContain('compass.north');
    expect(dial).toContain('compass.east');
    expect(dial).toContain('compass.south');
    expect(dial).toContain('compass.west');
    expect(dial).toMatch(/Array\.from\(\{ length: 36 \}, \(_, i\) => i \* 10\)/);
    expect(dial).toContain('[30, 60, 120, 150, 210, 240, 300, 330]');
  });

  it('draws a gold beam toward the Kaaba, and a halo that breathes around it', () => {
    expect(dial).toContain('BEAM_HALF_DEG = 14');
    expect(dial).toMatch(/fillOpacity=\{0\.16\}/);
    expect(dial).toMatch(/duration: 1600/);
    expect(dial).toContain('haloScale');
    expect(dial).toContain('haloOpacity');
    // The halo is placed by rotating the tip point the same way the
    // SVG group rotates the beam, so it lands on the marker.
    expect(dial).toContain('kaabaPoint');
  });

  it('reads the remaining turn in big numerals, with plain words for which way', () => {
    expect(dial).toContain('compass.turnRight');
    expect(dial).toContain('compass.turnLeft');
    expect(dial).toContain('compass.aligned');
    expect(dial).toContain('describeTurn(needleDeg)');
    expect(dial).toMatch(/\{`\$\{turn\.degrees\}°`\}/);
  });

  it('glows gold on alignment, and keeps the classic a11y labels', () => {
    expect(dial).toMatch(/aligned && live \? accent : quiet/);
    expect(dial).toContain('compass.a11yDialLive');
    expect(dial).toContain('compass.a11yDialChecking');
    expect(dial).toContain('compass.a11yDialUnavailable');
  });

  it('does not touch the bearing maths', () => {
    expect(dial).not.toContain('qiblaBearingFrom');
    expect(dial).not.toContain('normalizeHeadingDeg');
  });
});

describe('the pill shape setting', () => {
  it('defaults to the large pill, as it has always been', () => {
    expect(DEFAULT_SETTINGS.floatingButtonStyle).toBe('large');
  });

  it('is a radio choice in the floating-button card, shown when enabled', () => {
    const card = repo('src', 'screens', 'settings', 'FloatingButtonCard.tsx');
    // The testIDs are built from the option id at run time.
    expect(card).toContain('`floating-button-style-${opt.id}`');
    expect(card).toContain("{ id: 'large', labelKey: 'settings.floatingButtonStyleLarge' }");
    expect(card).toContain("{ id: 'compact', labelKey: 'settings.floatingButtonStyleCompact' }");
    expect(card).toContain("{ id: 'icon', labelKey: 'settings.floatingButtonStyleIcon' }");
    expect(card).toContain('settings.floatingButtonStyleLabel');
    expect(card).toContain('settings.floatingButtonStyleHelp');
    expect(card).toMatch(/onPress=\{\(\) => update\(\{ floatingButtonStyle: opt\.id \}\)\}/);
  });

  it('reaches the service through the home screen, which drains a hide first', () => {
    const home = repo('src', 'screens', 'HomeScreen.tsx');
    expect(home).toContain('consumePendingHide');
    expect(home).toMatch(/style: settings\.floatingButtonStyle/);
    expect(home).toContain('floatingButtonStyle');
  });
});
