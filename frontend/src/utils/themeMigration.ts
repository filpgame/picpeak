import type { ThemeConfig, HeaderStyleType, HeroDividerStyle, GalleryLayoutType } from '../types/theme.types';

/**
 * Surface defaults for the two color modes — the same values applyTheme()
 * falls back to when a theme has no explicit surface/elevated/border/text
 * tokens. Exposed here so the force-color-mode helper can swap them
 * wholesale when an admin locks the instance to a mode that the active
 * theme doesn't natively support.
 */
const DARK_SURFACE_DEFAULTS = {
  backgroundColor: '#0f0f0f',
  surfaceColor: '#1a1a1a',
  elevatedColor: '#242424',
  surfaceBorderColor: '#2e2e2e',
  textColor: '#e5e5e5',
  mutedTextColor: '#a3a3a3',
};

const LIGHT_SURFACE_DEFAULTS = {
  backgroundColor: '#fafafa',
  surfaceColor: '#ffffff',
  elevatedColor: '#f5f5f5',
  surfaceBorderColor: '#e5e5e5',
  textColor: '#171717',
  mutedTextColor: '#737373',
};

/**
 * Standard typography + style applied when an instance-wide force color mode
 * lock is active. A force lock means "use the clean standard look" — the
 * per-theme colour mode, surface/text palette, AND typography/style are
 * overridden so the customizer's now-hidden colour/typography/style controls
 * genuinely don't do anything while the lock is on (limits confusion). Accent
 * brand colours and the structural choices that live in their own cards
 * (header style, controls style, gallery layout, hero divider) are preserved.
 *
 * Override-only: the SAVED theme keeps the admin's custom values — turning the
 * lock off makes them apply again. `undefined` lets applyTheme() fall back to
 * its built-in default (e.g. the system/Inter font) rather than a stale value.
 */
const FORCED_STANDARD_TYPOGRAPHY_STYLE: Partial<ThemeConfig> = {
  fontFamily: undefined,
  headingFontFamily: undefined,
  fontSize: 'normal',
  borderRadius: 'md',
  shadowStyle: 'subtle',
  backgroundPattern: undefined,
};

/**
 * Apply an instance-wide force color mode lock to a theme config.
 *
 * No lock → returned unchanged. With a lock, pin colorMode, swap the
 * surface/text palette to the locked mode's defaults (only when the theme
 * doesn't already match the mode), and reset typography/style to the standard
 * look. The user's accent/accentDark colours are always preserved so brand
 * identity survives the flip.
 *
 * Centralised here so every consumer stays in sync (#397 follow-up: galleries
 * did not visibly flip when Force Dark/Light was toggled because only
 * colorMode was overridden, leaving the original surface colours in place).
 */
export function applyForceColorMode(
  theme: ThemeConfig,
  forced: 'dark' | 'light' | null | undefined
): ThemeConfig {
  if (!forced) return theme;

  const themeMode = theme.colorMode === 'auto'
    ? (typeof window !== 'undefined'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light')
    : (theme.colorMode || 'light');

  // Swap the surface palette only when the theme doesn't natively match the
  // locked mode; the standard typography/style reset applies either way.
  const surfaces = themeMode === forced
    ? {}
    : (forced === 'dark' ? DARK_SURFACE_DEFAULTS : LIGHT_SURFACE_DEFAULTS);

  return {
    ...theme,
    ...surfaces,
    ...FORCED_STANDARD_TYPOGRAPHY_STYLE,
    colorMode: forced,
  };
}

/**
 * Fills in any missing 8-token CI palette fields on legacy themes that were
 * saved before the palette expanded from 4 → 8 explicit tokens.
 *
 * The visible look of an existing instance must not change just because the
 * type system grew (per project memory: migrations preserve visual state).
 * For each missing token we fall back to the value the renderer was already
 * deriving implicitly:
 *   - accentDarkColor   ← primaryColor (legacy primary was used as CTA fill)
 *   - elevatedColor     ← surfaceColor (or a slight shift for light themes)
 *   - surfaceColor      ← '#ffffff' / '#1a1a1a' depending on colorMode
 *   - surfaceBorderColor← '#e5e5e5' / '#2e2e2e'
 *   - mutedTextColor    ← '#737373' / '#a3a3a3'
 */
function fillMissingPaletteTokens(theme: ThemeConfig): ThemeConfig {
  const isDark = theme.colorMode === 'dark';
  const filled: ThemeConfig = { ...theme };

  if (!filled.surfaceColor) {
    filled.surfaceColor = isDark ? '#1a1a1a' : '#ffffff';
  }
  if (!filled.elevatedColor) {
    // For dark themes raise slightly above surface; for light, drop slightly below.
    filled.elevatedColor = isDark ? '#242424' : '#f5f5f5';
  }
  if (!filled.surfaceBorderColor) {
    filled.surfaceBorderColor = isDark ? '#2e2e2e' : '#e5e5e5';
  }
  if (!filled.mutedTextColor) {
    filled.mutedTextColor = isDark ? '#a3a3a3' : '#737373';
  }
  if (!filled.accentDarkColor) {
    // Legacy themes used primaryColor as the CTA fill — preserve that.
    filled.accentDarkColor = filled.primaryColor;
  }

  return filled;
}

/**
 * Migrates legacy theme configurations:
 *  - 'hero' galleryLayout → decoupled headerStyle + galleryLayout
 *  - missing 8-token CI palette fields → derived from legacy 4-color set
 *
 * This ensures backward compatibility with existing events.
 */
export function migrateThemeConfig(theme: ThemeConfig): ThemeConfig {
  if (!theme) return theme;

  let migrated = theme;

  // Check if this theme uses the legacy 'hero' layout
  if ((migrated.galleryLayout as string) === 'hero') {
    migrated = {
      ...migrated,
      headerStyle: 'hero' as HeaderStyleType,
      galleryLayout: 'grid' as GalleryLayoutType,
      heroDividerStyle: (migrated.heroDividerStyle || 'wave') as HeroDividerStyle,
    };
  }

  // If headerStyle is not set but galleryLayout is valid, default to 'standard'
  if (!migrated.headerStyle && migrated.galleryLayout) {
    migrated = {
      ...migrated,
      headerStyle: 'standard' as HeaderStyleType,
    };
  }

  // Fill any missing 8-token palette fields so the renderer never has to
  // fall back to hard-coded defaults that diverge from the original look.
  return fillMissingPaletteTokens(migrated);
}

/**
 * Parses and migrates a color_theme JSON string from the database.
 * Handles both JSON strings and legacy preset names.
 */
export function parseAndMigrateTheme(colorTheme: string | null | undefined): ThemeConfig | null {
  if (!colorTheme) return null;

  try {
    // Check if it's a JSON string
    if (colorTheme.startsWith('{')) {
      const parsed = JSON.parse(colorTheme);
      return migrateThemeConfig(parsed);
    }

    // Legacy preset name - return null to let the caller handle preset lookup
    return null;
  } catch {
    // Invalid JSON
    return null;
  }
}

/**
 * Checks if a theme configuration needs migration from legacy hero layout.
 */
export function needsMigration(theme: ThemeConfig): boolean {
  return (theme.galleryLayout as string) === 'hero';
}
