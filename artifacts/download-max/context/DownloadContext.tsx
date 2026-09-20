import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { MaxTasks } from '@/context/SettingsContext';

const STORAGE_KEY = '@download-max/downloads';

/**
 * خدمة تحويل روابط الصفحات إلى روابط وسائط مباشرة.
 * يمكن تغييرها لكل بيئة عبر EXPO_PUBLIC_EXTRACTOR_URL (تُثبَّت وقت البناء).
 */
const EXTRACTOR_API_URL =
  process.env.EXPO_PUBLIC_EXTRACTOR_URL?.trim() || 'https://api-production-85a7.up.railway.app/';

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
  bytesWritten?: number;
  totalBytes?: number;
  fileUri?: string;
  error?: string;
  inVault?: boolean;
  createdAt: number;
};

type DownloadContextValue = {
  items: DownloadItem[];
  activeCount: number;
  addDownload: (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  openFile: (item: DownloadItem) => Promise<void>;
  shareFile: (item: DownloadItem) => Promise<void>;
  moveToVault: (id: string) => Promise<void>;
  removeFromVault: (id: string) => Promise<void>;
  setQueueOptions: (options: { maxTasks: MaxTasks; allowMobileData: boolean }) => void;
  waitingForWifi: boolean;
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

/** أنواع MIME الصحيحة لكل صيغة حتى يفتح Android الملف بالتطبيق المناسب. */
const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mimeFor(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? '*/*';
}

/**
 * يفتح الملف الذي تم تنزيله عبر لوحة مشاركة أندرويد،
 * فيمكن تشغيله بأي مشغل فيديو/صوت أو عارض صور مثبّت على الجهاز.
 */
async function openDownloadedFile(item: DownloadItem) {
  if (Platform.OS === 'web' || !item.fileUri) return;
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('المشاركة غير مدعومة على هذا الجهاز.');
  await Sharing.shareAsync(item.fileUri, {
    mimeType: mimeFor(item.fileUri),
    dialogTitle: 'فتح أو مشاركة الملف',
  });
}

async function resolveMediaUrl(sourceUrl: string): Promise<string> {
  if (looksLikeDirectMedia(sourceUrl)) return sourceUrl;
  const response = await fetch(EXTRACTOR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  const [waitingForWifi, setWaitingForWifi] = useState(false);

  // مراجع تعمل خارج دورة الرسم لإدارة الطابور بأمان.
  const itemsRef = useRef<DownloadItem[]>([]);
  const queueRef = useRef<string[]>([]);
  const activeIdsRef = useRef<Set<string>>(new Set());
  const maxTasksRef = useRef<MaxTasks>(2);
  const allowMobileDataRef = useRef(true);
  const canDownloadRef = useRef(true);
  const resumablesRef = useRef(new Map<string, FileSystem.DownloadResumable>());
  const progressRef = useRef(new Map<string, { progress: number; at: number }>());
  const bytesRef = useRef(new Map<string, { bytesWritten: number; totalBytes?: number }>());
  const pumpRef = useRef<() => void>(() => undefined);
  const runJobRef = useRef<(id: string) => void>(() => undefined);

  const commit = useCallback((updater: (current: DownloadItem[]) => DownloadItem[]) => {
    setItems((current) => {
      const next = updater(current);
      itemsRef.current = next;
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    commit((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, [commit]);

  /** مهمة تنزيل واحدة: تستخرج الرابط المباشر ثم تنزّل مع تتبع التقدم. */
  const runJob = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) {
      activeIdsRef.current.delete(id);
      pumpRef.current();
      return;
    }

    await patchItem(id, { status: 'downloading', progress: 0, error: undefined });

    if (Platform.OS === 'web') {
      await patchItem(id, { status: 'failed', error: 'التنزيل المباشر متاح من تطبيق Android فقط.' });
      activeIdsRef.current.delete(id);
      pumpRef.current();
      return;
    }

    try {
      const baseDirectory = FileSystem.documentDirectory;
      if (!baseDirectory) throw new Error('تعذر الوصول إلى مساحة التخزين.');

      const mediaUrl = await resolveMediaUrl(item.url);
      const target = `${baseDirectory}${safeFilename(item.title, item.format)}`;

      // إزالة أي بقايا من محاولة سابقة حتى يبدأ التقدم من الصفر.
      const existing = await FileSystem.getInfoAsync(target);
      if (existing.exists) await FileSystem.deleteAsync(target, { idempotent: true });

      let lastAt = 0;
      const resumable = FileSystem.createDownloadResumable(
        mediaUrl,
        target,
        {},
        (progress) => {
          const expected = progress.totalBytesExpectedToWrite;
          const nextProgress = expected > 0 ? progress.totalBytesWritten / expected : 0;
          if (nextProgress <= 0 || nextProgress >= 1) return;
          const now = Date.now();
          if (now - lastAt < 250 && nextProgress - (progressRef.current.get(id)?.progress ?? 0) < 0.02) return;
          lastAt = now;
          progressRef.current.set(id, { progress: nextProgress, at: now });
          bytesRef.current.set(id, { bytesWritten: progress.totalBytesWritten, totalBytes: expected > 0 ? expected : undefined });
          patchItem(id, { progress: nextProgress, bytesWritten: progress.totalBytesWritten, totalBytes: expected > 0 ? expected : undefined });
        },
      );
      resumablesRef.current.set(id, resumable);

      const result = await resumable.downloadAsync();
      const finalBytes = bytesRef.current.get(id);
      resumablesRef.current.delete(id);
      progressRef.current.delete(id);
      bytesRef.current.delete(id);

      if (result?.status === 200) {
        await patchItem(id, {
          status: 'completed',
          progress: 1,
          bytesWritten: finalBytes?.bytesWritten,
          totalBytes: finalBytes?.totalBytes,
          fileUri: result.uri,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        await patchItem(id, { status: 'failed', error: `تعذر تنزيل الملف (رمز ${result?.status ?? 'مجهول'}).` });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (err) {
      resumablesRef.current.delete(id);
      progressRef.current.delete(id);
      bytesRef.current.delete(id);
      await patchItem(id, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'فشل التنزيل. تحقق من الرابط والاتصال ثم حاول مرة أخرى.',
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      activeIdsRef.current.delete(id);
      pumpRef.current();
    }
  }, [patchItem]);

  /** يشغّل المهام التالية في الطابور حتى بلوغ حد التنزيلات المتزامنة. */
  const pump = useCallback(() => {
    if (activeIdsRef.current.size >= maxTasksRef.current) return;
    if (!canDownloadRef.current) {
      setWaitingForWifi(queueRef.current.length > 0);
      return;
    }
    setWaitingForWifi(false);
    const nextId = queueRef.current.shift();
    if (!nextId) return;
    const item = itemsRef.current.find((candidate) => candidate.id === nextId);
    if (!item || item.status !== 'queued') {
      pumpRef.current(); // تخطي العناصر المحذوفة أو المنتهية
      return;
    }
    activeIdsRef.current.add(nextId);
    runJobRef.current(nextId);
    if (activeIdsRef.current.size < maxTasksRef.current && queueRef.current.length > 0) {
      pumpRef.current();
    }
  }, []);

  const enqueue = useCallback((id: string) => {
    if (!queueRef.current.includes(id)) queueRef.current.push(id);
    pumpRef.current();
  }, []);

  useEffect(() => {
    runJobRef.current = (id) => {
      void runJob(id);
    };
    pumpRef.current = pump;
  }, [runJob, pump]);

  // مراقبة الاتصال: احترام إعداد "التنزيل عبر بيانات الجوال".
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const update = (state: NetInfoState) => {
      const isConnected = !!state.isConnected && !!state.isInternetReachable;
      const isCellular = state.type === 'cellular';
      canDownloadRef.current = isConnected && (!isCellular || allowMobileDataRef.current);
      pumpRef.current();
    };
    const unsubscribe = NetInfo.addEventListener(update);
    NetInfo.fetch().then(update).catch(() => undefined);
    return () => {
      unsubscribe();
    };
  }, []);

  // استرجاع السجل عند الإقلاع وإعادة جدولة أي تنزيلات معلّقة.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!stored || cancelled) return;
        const parsed = JSON.parse(stored) as DownloadItem[];
        const currentIds = new Set(itemsRef.current.map((existing) => existing.id));
        const merged = [...itemsRef.current, ...parsed.filter((existing) => !currentIds.has(existing.id))]
          .sort((a, b) => b.createdAt - a.createdAt);
        itemsRef.current = merged;
        setItems(merged);

        for (const item of merged) {
          if (item.status === 'downloading' || item.status === 'queued') {
            patchItem(item.id, { status: 'queued', progress: 0, error: undefined });
            enqueue(item.id);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [patchItem, enqueue]);

  const addDownload = useCallback(async (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => {
    const item: DownloadItem = {
      ...input,
      id: createId(),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    commit((current) => [item, ...current]);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    enqueue(item.id);
  }, [commit, enqueue]);

  const retryDownload = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.status === 'downloading' || item.status === 'queued') return;
    patchItem(id, { status: 'queued', progress: 0, error: undefined });
    enqueue(id);
  }, [patchItem, enqueue]);

  const removeDownload = useCallback(async (id: string) => {
    queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
    const resumable = resumablesRef.current.get(id);
    if (resumable) {
      resumablesRef.current.delete(id);
      try {
        await resumable.cancelAsync();
      } catch {
        // المهمة ربما انتهت بالفعل
      }
    }
    progressRef.current.delete(id);
    bytesRef.current.delete(id);
    commit((current) => current.filter((item) => item.id !== id));
  }, [commit]);

  const clearCompleted = useCallback(async () => {
    commit((current) => current.filter((item) => item.status !== 'completed'));
  }, [commit]);

  const openFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed' || !item.fileUri) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await openDownloadedFile(item);
  }, []);

  const shareFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed' || !item.fileUri) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await openDownloadedFile(item);
  }, []);

  const moveToVault = useCallback(async (id: string) => {
    patchItem(id, { inVault: true });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [patchItem]);

  const removeFromVault = useCallback(async (id: string) => {
    patchItem(id, { inVault: false });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [patchItem]);

  const setQueueOptions = useCallback((options: { maxTasks: MaxTasks; allowMobileData: boolean }) => {
    maxTasksRef.current = options.maxTasks;
    allowMobileDataRef.current = options.allowMobileData;
    pumpRef.current();
  }, []);

  const value = useMemo(() => ({
    items,
    activeCount: items.filter((item) => item.status === 'queued' || item.status === 'downloading').length,
    waitingForWifi,
    addDownload,
    retryDownload,
    removeDownload,
    clearCompleted,
    openFile,
    shareFile,
    moveToVault,
    removeFromVault,
    setQueueOptions,
  }), [items, waitingForWifi, addDownload, retryDownload, removeDownload, clearCompleted, openFile, shareFile, moveToVault, removeFromVault, setQueueOptions]);

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadProvider');
  return value;
}
