import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

const STORAGE_KEY = '@download-max/downloads';

export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed';
export type MediaType = 'video' | 'audio' | 'image';

export type DownloadItem = {
  id: string;
  url: string;
  title: string;
  type: MediaType;
  format: string;
  quality: string;
  status: DownloadStatus;
  progress: number;
  fileUri?: string;
  error?: string;
  createdAt: number;
};

type DownloadContextValue = {
  items: DownloadItem[];
  activeCount: number;
  addDownload: (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
};

const DownloadContext = createContext<DownloadContextValue | null>(null);

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function safeFilename(title: string, format: string) {
  const cleaned = title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 54) || 'download';
  return `${cleaned}.${format}`;
}

function looksLikeDirectMedia(url: string) {
  return /\.(mp4|webm|mov|m4v|mp3|m4a|wav|aac|jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
}

async function resolveMediaUrl(sourceUrl: string): Promise<string> {
  if (looksLikeDirectMedia(sourceUrl)) return sourceUrl;
  const response = await fetch('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ url: sourceUrl }),
  });
  if (!response.ok) throw new Error('تعذر الوصول إلى خدمة الاستخراج.');
  const data = await response.json();
  if (data.status === 'error' || !data.url) {
    throw new Error(data.text || 'تعذر استخراج رابط الوسائط من هذا الرابط.');
  }
  return data.url as string;
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored) setItems(JSON.parse(stored) as DownloadItem[]);
      })
      .catch(() => undefined);
  }, []);

  const persist = useCallback((next: DownloadItem[]) => {
    setItems(next);
    return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const updateItem = useCallback(async (id: string, patch: Partial<DownloadItem>) => {
    setItems((current) => {
      const next = current.map((item) => (item.id === id ? { ...item, ...patch } : item));
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const startDownload = useCallback(async (item: DownloadItem) => {
    await updateItem(item.id, { status: 'downloading', progress: 0, error: undefined });
    if (Platform.OS === 'web') {
      await updateItem(item.id, {
        status: 'failed',
        error: 'التنزيل المباشر متاح من تطبيق Android فقط.',
      });
      return;
    }

    try {
      const baseDirectory = FileSystem.documentDirectory;
      if (!baseDirectory) throw new Error('تعذر الوصول إلى مساحة التخزين.');
      const mediaUrl = await resolveMediaUrl(item.url);
      const target = `${baseDirectory}${safeFilename(item.title, item.format)}`;
      const result = await FileSystem.downloadAsync(mediaUrl, target);
      await updateItem(item.id, {
        status: 'completed',
        progress: 1,
        fileUri: result.uri,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      await updateItem(item.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'فشل التنزيل. تحقق من الرابط والاتصال ثم حاول مرة أخرى.',
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [updateItem]);

  const addDownload = useCallback(async (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => {
    const item: DownloadItem = {
      ...input,
      id: createId(),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    await persist([item, ...items]);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void startDownload(item);
  }, [items, persist, startDownload]);

  const retryDownload = useCallback(async (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item) void startDownload(item);
  }, [items, startDownload]);

  const removeDownload = useCallback(async (id: string) => {
    await persist(items.filter((item) => item.id !== id));
  }, [items, persist]);

  const clearCompleted = useCallback(async () => {
    await persist(items.filter((item) => item.status !== 'completed'));
  }, [items, persist]);

  const value = useMemo(() => ({
    items,
    activeCount: items.filter((item) => item.status === 'queued' || item.status === 'downloading').length,
    addDownload,
    retryDownload,
    removeDownload,
    clearCompleted,
  }), [items, addDownload, retryDownload, removeDownload, clearCompleted]);

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadProvider');
  return value;
}