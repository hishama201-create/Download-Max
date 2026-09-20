import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type AccentKey = 'blue' | 'violet' | 'emerald' | 'coral' | 'orange';
export type MaxTasks = 1 | 2 | 3;
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
  maxTasks: MaxTasks;
  allowMobileData: boolean;
  vaultPin: string | null;
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentKey) => void;
  setMaxTasks: (value: MaxTasks) => void;
  setAllowMobileData: (value: boolean) => void;
  setVaultPin: (pin: string | null) => void;
  completeOnboarding: () => void;
};

const STORAGE_KEY = '@download-max/settings';
const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [accent, setAccentState] = useState<AccentKey>('blue');
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [maxTasks, setMaxTasksState] = useState<MaxTasks>(2);
  const [allowMobileData, setAllowMobileDataState] = useState(true);
  const [vaultPin, setVaultPinState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!stored) return;
        const parsed = JSON.parse(stored) as Partial<SettingsValue>;
        if (parsed.themeMode) setThemeModeState(parsed.themeMode);
        if (parsed.accent) setAccentState(parsed.accent);
        if (parsed.hasSeenOnboarding) setHasSeenOnboarding(true);
        if (parsed.maxTasks === 1 || parsed.maxTasks === 2 || parsed.maxTasks === 3) setMaxTasksState(parsed.maxTasks);
        if (typeof parsed.allowMobileData === 'boolean') setAllowMobileDataState(parsed.allowMobileData);
        if (typeof parsed.vaultPin === 'string' || parsed.vaultPin === null) setVaultPinState(parsed.vaultPin ?? null);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const save = useCallback((patch: Partial<Pick<SettingsValue, 'themeMode' | 'accent' | 'hasSeenOnboarding' | 'maxTasks' | 'allowMobileData' | 'vaultPin'>>) => {
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

  const setMaxTasks = useCallback((value: MaxTasks) => {
    setMaxTasksState(value);
    save({ maxTasks: value });
  }, [save]);

  const setAllowMobileData = useCallback((value: boolean) => {
    setAllowMobileDataState(value);
    save({ allowMobileData: value });
  }, [save]);

  const setVaultPin = useCallback((pin: string | null) => {
    setVaultPinState(pin);
    save({ vaultPin: pin });
  }, [save]);

  const value = useMemo(() => ({
    themeMode,
    accent,
    hasSeenOnboarding,
    maxTasks,
    allowMobileData,
    vaultPin,
    loaded,
    setThemeMode,
    setAccent,
    setMaxTasks,
    setAllowMobileData,
    setVaultPin,
    completeOnboarding,
  }), [themeMode, accent, hasSeenOnboarding, maxTasks, allowMobileData, vaultPin, loaded, setThemeMode, setAccent, setMaxTasks, setAllowMobileData, setVaultPin, completeOnboarding]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useAppSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useAppSettings must be used inside SettingsProvider');
  return value;
}