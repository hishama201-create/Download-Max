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
    text: '#11243b',
    tint: '#2f7df6',

    // Core surfaces
    background: '#f4f7fb',
    foreground: '#11243b',

    // Cards / elevated surfaces
    card: '#ffffff',
    cardForeground: '#11243b',

    // Primary action color (buttons, links, active states)
    primary: '#2f7df6',
    primaryForeground: '#ffffff',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#eaf0fb',
    secondaryForeground: '#24405f',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#e9eef6',
    mutedForeground: '#64758a',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#dff7ef',
    accentForeground: '#14684f',

    // Destructive actions (delete, error states)
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#dbe4f0',
    input: '#d2ddeb',
  },

  dark: {
    text: '#edf4ff',
    tint: '#79a7ff',
    background: '#0d1726',
    foreground: '#edf4ff',
    card: '#152337',
    cardForeground: '#edf4ff',
    primary: '#79a7ff',
    primaryForeground: '#0d1726',
    secondary: '#1d304a',
    secondaryForeground: '#d7e5fb',
    muted: '#1a2a40',
    mutedForeground: '#9db0c9',
    accent: '#163d39',
    accentForeground: '#8ce4c5',
    destructive: '#ff7c86',
    destructiveForeground: '#0d1726',
    border: '#273b55',
    input: '#314967',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
