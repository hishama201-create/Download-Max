import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentKey = 'blue' | 'violet' | 'emerald' | 'coral' | 'orange';
export const accentSwatches: Record<AccentKey, string> = {
  blue: '#2f7df6',
  violet: '#7657e8',
  emerald: '#159b73',
  coral: '#e76559',
  orange: '#ed8b25',
};

type SettingsValue = {
  themeMode: ThemeMode;
  accent: AccentKey;
  hasSeenOnboarding: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentKey) => void;
  completeOnboarding: () => void;
};

const STORAGE_KEY = '@download-max/settings';
const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [accent, setAccentState] = useState<AccentKey>('blue');
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!stored) return;
        const parsed = JSON.parse(stored) as Partial<SettingsValue>;
        if (parsed.themeMode) setThemeModeState(parsed.themeMode);
        if (parsed.accent) setAccentState(parsed.accent);
        if (parsed.hasSeenOnboarding) setHasSeenOnboarding(true);
      })
      .catch(() => undefined);
  }, []);

  const save = useCallback((patch: Partial<Pick<SettingsValue, 'themeMode' | 'accent' | 'hasSeenOnboarding'>>) => {
    void AsyncStorage.mergeItem(STORAGE_KEY, JSON.stringify(patch));
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    save({ themeMode: mode });
  }, [save]);

  const setAccent = useCallback((nextAccent: AccentKey) => {
    setAccentState(nextAccent);
    save({ accent: nextAccent });
  }, [save]);

  const completeOnboarding = useCallback(() => {
    setHasSeenOnboarding(true);
    save({ hasSeenOnboarding: true });
  }, [save]);

  const value = useMemo(() => ({
    themeMode,
    accent,
    hasSeenOnboarding,
    setThemeMode,
    setAccent,
    completeOnboarding,
  }), [themeMode, accent, hasSeenOnboarding, setThemeMode, setAccent, completeOnboarding]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useAppSettings must be used inside SettingsProvider');
  return value;
}