import { useColorScheme } from 'react-native';
import colors from '@/constants/colors';
import { useAppSettings } from '@/context/SettingsContext';

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * Falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default).
 * When a sibling web artifact's dark tokens are synced into a `dark`
 * key, this hook will automatically switch palettes based on the
 * device's appearance setting.
 */
export function useColors() {
  const scheme = useColorScheme();
  const { themeMode, accent } = useAppSettings();
  const isDark = themeMode === 'dark' || (themeMode === 'system' && scheme === 'dark');
  const palette =
    isDark && 'dark' in colors
      ? (colors as typeof colors & { dark: typeof colors.light }).dark
      : colors.light;
  const accentMap = {
    blue: isDark ? '#79a7ff' : '#2f7df6',
    violet: isDark ? '#bd9aff' : '#7657e8',
    emerald: isDark ? '#76e0ba' : '#159b73',
    coral: isDark ? '#ff9b91' : '#e76559',
    orange: isDark ? '#ffc477' : '#ed8b25',
  };
  return { ...palette, primary: accentMap[accent], tint: accentMap[accent], radius: colors.radius };
}
