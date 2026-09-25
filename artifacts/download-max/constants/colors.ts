/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#0e1a2b',
    tint: '#2563eb',

    // Core surfaces — درجات باردة نقية
    background: '#f2f5fa',
    foreground: '#0e1a2b',

    // Cards / elevated surfaces
    card: '#ffffff',
    cardForeground: '#0e1a2b',

    // Primary action color (buttons, links, active states)
    primary: '#2563eb',
    primaryForeground: '#ffffff',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#e7eefb',
    secondaryForeground: '#1e3a8a',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#e6ebf3',
    mutedForeground: '#5b6b82',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#dcf7ee',
    accentForeground: '#0d7a5f',

    // Destructive actions (delete, error states)
    destructive: '#e5484d',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#dde5f0',
    input: '#cdd9e8',
  },

  dark: {
    text: '#e7edf7',
    tint: '#7da9ff',
    background: '#080e1a',
    foreground: '#e7edf7',
    card: '#101a2d',
    cardForeground: '#e7edf7',
    primary: '#7da9ff',
    primaryForeground: '#080e1a',
    secondary: '#182a45',
    secondaryForeground: '#d5e2f7',
    muted: '#152136',
    mutedForeground: '#8ea1bd',
    accent: '#12332d',
    accentForeground: '#6fdcb8',
    destructive: '#ff7078',
    destructiveForeground: '#080e1a',
    border: '#223250',
    input: '#2c4066',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
