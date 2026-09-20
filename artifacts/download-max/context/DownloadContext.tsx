import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { MaxTasks } from '@/context/SettingsContext';

const STORAGE_KEY = '@download-max/downloads';
const DOWNLOAD_DIR_KEY = '@download-max/download-dir';
/** مدة بقاء الملفات في سلة المحذوفات قبل حذفها تلقائياً (30 يوماً). */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  /** وقت النقل إلى سلة المحذوفات — وجوده يعني أن الملف في السلة. */
  deletedAt?: number;
  createdAt: number;
};

type DownloadContextValue = {
  items: DownloadItem[];
  activeCount: number;
  waitingForWifi: boolean;
  addDownload: (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => Promise<void>;
  /** يستقبل الملف المشارَك من تطبيق آخر ويحفظه مباشرةً. */
  addSharedFile: (contentUri: string, mimeType: string | null, originalName: string | null) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  openFile: (item: DownloadItem) => Promise<void>;
  shareFile: (item: DownloadItem) => Promise<void>;
  moveToVault: (id: string) => Promise<void>;
  removeFromVault: (id: string) => Promise<void>;
  setQueueOptions: (options: { maxTasks: MaxTasks; allowMobileData: boolean }) => void;
  /** مجلد التنزيل المختار (SAF URI) أو null للحفظ الداخلي. */
  downloadDir: string | null;
  setDownloadDir: (uri: string | null) => Promise<void>;
  /** إعادة ملف من سلة المحذوفات إلى القائمة. */
  restoreFromTrash: (id: string) => Promise<void>;
  /** حذف ملف من السلة نهائياً مع ملفه الفعلي. */
  deletePermanently: (id: string) => Promise<void>;
  /** تفريغ سلة المحذوفات بالكامل. */
  emptyTrash: () => Promise<void>;
};

const DownloadContext = createContext<DownloadContextValue | null>(null);

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function safeFilename(title: string, format: string) {
  // \p{L} يحافظ على الحروف العربية وكل اللغات في اسم الملف.
  const cleaned = title.replace(/[^\p{L}\p{N}\s._-]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'download';
  return `${cleaned}.${format}`;
}

/** يحاول استخراج اسم ملف مقروء من مسار الرابط المباشر. */
function prettyNameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    const decoded = decodeURIComponent(last).replace(/\.[^.]+$/, '').replace(/[-_+]+/g, ' ').trim();
    // أسماء مثل 3a5f2c8d مجرد بصمات بلا فائدة — نتجاهلها إن لم تحوِ حروفًا كافية.
    if (decoded.length < 3 || !/[\p{L}]{3,}/u.test(decoded)) return null;
    return decoded.slice(0, 60);
  } catch {
    return null;
  }
}

/** يجلب اسم الملف الحقيقي ونوعه من ترويسات الخادم قبل التنزيل. */
async function fetchRemoteFileInfo(mediaUrl: string): Promise<{ filename: string | null; mime: string | null }> {
  try {
    const response = await fetch(mediaUrl, { method: 'HEAD' });
    const disposition = response.headers.get('content-disposition');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
    let filename: string | null = null;
    if (disposition) {
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
      const raw = utf8Match?.[1] ?? plainMatch?.[1] ?? null;
      if (raw) {
        try {
          filename = decodeURIComponent(raw);
        } catch {
          filename = raw;
        }
      }
    }
    return { filename: filename?.trim() || null, mime };
  } catch {
    return { filename: null, mime: null };
  }
}

/** يستنتج امتداداً صحيحاً من نوع MIME المُرجَع من الخادم. */
function extFromMime(mime: string | null): string | null {
  if (!mime) return null;
  const entry = Object.entries(MIME_TYPES).find(([, value]) => value === mime);
  return entry?.[0] ?? null;
}

function looksLikeDirectMedia(url: string) {
  return /\.(mp4|webm|mov|m4v|mp3|m4a|wav|aac|jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
}

/** يستنتج نوع الوسائط من نوع MIME الوارد من نظام المشاركة. */
function typeFromMime(mimeType: string | null): MediaType {
  if (!mimeType) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'video';
}

/** يفصل امتداد الملف من اسمه الأصلي أو من نوع MIME، مع بدائل صالحة دائماً. */
function extensionFor(mimeType: string | null, originalName: string | null, type: MediaType) {
  const fromName = originalName?.includes('.') ? originalName.split('.').pop() : null;
  if (fromName && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
  const fromMime = extFromMime(mimeType);
  if (fromMime) return fromMime;
  // بدائل مضمونة حتى لا يُحفظ الملف أبداً بلا امتداد صالح.
  return type === 'image' ? 'jpg' : type === 'audio' ? 'mp3' : 'mp4';
}

/** ينسخ ملفاً محلياً إلى مجلد SAF الذي اختاره المستخدم (مكان التنزيل). */
async function saveFileToSafDirectory(localUri: string, filename: string, mimeType: string, directoryUri: string): Promise<boolean> {
  try {
    const baseName = filename.replace(/\.[^.]+$/, '') || 'download';
    const safFileUri = await FileSystem.StorageAccessFramework.createFileAsync(directoryUri, baseName, mimeType);
    try {
      await FileSystem.copyAsync({ from: localUri, to: safFileUri });
    } catch {
      const data = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
      await FileSystem.writeAsStringAsync(safFileUri, data, { encoding: FileSystem.EncodingType.Base64 });
    }
    return true;
  } catch {
    // فشل الحفظ في المجلد المختار — يبقى الملف في مجلد التطبيق.
    return false;
  }
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
  const [downloadDir, setDownloadDirState] = useState<string | null>(null);

  // مراجع تعمل خارج دورة الرسم لإدارة الطابور بأمان.
  const itemsRef = useRef<DownloadItem[]>([]);
  const queueRef = useRef<string[]>([]);
  const activeIdsRef = useRef<Set<string>>(new Set());
  const maxTasksRef = useRef<MaxTasks>(2);
  const allowMobileDataRef = useRef(true);
  const downloadDirRef = useRef<string | null>(null);
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

      // الملفات المحلية المشارَكة (content:// أو file://) تُنسخ مباشرة بلا تنزيل شبكي.
      if (!/^https?:\/\//i.test(item.url)) {
        // الاسم الأصلي من نظام المشاركة محفوظ في العنوان، ونضمن امتداداً صالحاً دائماً.
        const filename = safeFilename(item.title, extensionFor(mimeFor(item.format), item.title, item.type));
        const target = `${baseDirectory}${filename}`;
        await FileSystem.copyAsync({ from: item.url, to: target });
        const info = await FileSystem.getInfoAsync(target);
        const size = 'size' in info && typeof info.size === 'number' ? info.size : undefined;
        if (downloadDirRef.current) {
          await saveFileToSafDirectory(target, filename, mimeFor(filename), downloadDirRef.current);
        }
        await patchItem(id, {
          status: 'completed',
          progress: 1,
          bytesWritten: size,
          totalBytes: size,
          fileUri: target,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }

      const mediaUrl = await resolveMediaUrl(item.url);
      let target = `${baseDirectory}${safeFilename(item.title, item.format)}`;

      // جلب الاسم الأصلي والنوع من ترويسات الخادم حتى يُحفظ الملف باسمه وصيغته الحقيقية.
      let resolvedTitle = item.title;
      let resolvedFormat = item.format;
      const remoteInfo = await fetchRemoteFileInfo(mediaUrl);
      const remoteName = remoteInfo.filename ?? prettyNameFromUrl(mediaUrl);
      if (remoteName) {
        const remoteExt = remoteName.includes('.') ? remoteName.split('.').pop()?.toLowerCase() : null;
        resolvedTitle = remoteName.replace(/\.[^.]+$/, '');
        if (remoteExt && /^[a-z0-9]{2,5}$/i.test(remoteExt)) resolvedFormat = remoteExt;
      }
      const serverExt = extFromMime(remoteInfo.mime);
      if (serverExt) resolvedFormat = serverExt;
      if (resolvedTitle !== item.title || resolvedFormat !== item.format) {
        await patchItem(id, { title: resolvedTitle, format: resolvedFormat });
      }

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
        // ضمان صيغة صحيحة: إن كان الرابط المباشر يحمل امتداداً واضحاً نعتمده.
        let finalFormat = resolvedFormat;
        const uriExt = result.uri.split('.').pop()?.toLowerCase();
        if (uriExt && /^[a-z0-9]{2,5}$/i.test(uriExt) && MIME_TYPES[uriExt]) finalFormat = uriExt;
        const finalFilename = safeFilename(resolvedTitle, finalFormat);
        if (result.uri !== `${baseDirectory}${finalFilename}`) {
          try {
            await FileSystem.moveAsync({ from: result.uri, to: `${baseDirectory}${finalFilename}` });
          } catch {
            // نُبقي المسار الأصلي عند تعذر النقل.
          }
        }
        target = `${baseDirectory}${finalFilename}`;
        if (downloadDirRef.current) {
          await saveFileToSafDirectory(target, finalFilename, mimeFor(finalFormat), downloadDirRef.current);
        }
        await patchItem(id, {
          status: 'completed',
          progress: 1,
          bytesWritten: finalBytes?.bytesWritten,
          totalBytes: finalBytes?.totalBytes,
          fileUri: target,
          title: resolvedTitle,
          format: finalFormat,
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
    const headId = queueRef.current[0];
    const headItem = headId ? itemsRef.current.find((candidate) => candidate.id === headId) : undefined;
    // النسخ المحلي من الملفات المشاركة لا يحتاج اتصالاً بالإنترنت.
    const isLocalCopy = !!headItem && !/^https?:\/\//i.test(headItem.url);
    if (!canDownloadRef.current && !isLocalCopy) {
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


  /** تنظيف دوري: يحذف تلقائياً ملفات السلة التي تجاوزت 30 يوماً. */
  const purgeExpiredTrash = useCallback(async () => {
    const now = Date.now();
    const expired = itemsRef.current.filter((item) => item.deletedAt && now - item.deletedAt > TRASH_RETENTION_MS);
    if (expired.length === 0) return;
    for (const item of expired) {
      if (item.fileUri && !item.fileUri.startsWith('content://')) {
        try {
          const info = await FileSystem.getInfoAsync(item.fileUri);
          if (info.exists) await FileSystem.deleteAsync(item.fileUri, { idempotent: true });
        } catch {
          // تجاهل أخطاء حذف الملفات الفردية
        }
      }
    }
    commit((current) => current.filter((item) => !(item.deletedAt && now - item.deletedAt > TRASH_RETENTION_MS)));
  }, [commit]);

  // استرجاع السجل عند الإقلاع وإعادة جدولة أي تنزيلات معلّقة ثم تنظيف السلة.
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
      .then(() => {
        if (!cancelled) void purgeExpiredTrash();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [patchItem, enqueue, purgeExpiredTrash]);

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

  /** يحفظ ملفاً مشارَكاً من تطبيق آخر (content:// أو file://) مباشرةً بلا حاجة لرابط إنترنت. */
  const addSharedFile = useCallback(async (contentUri: string, mimeType: string | null, originalName: string | null) => {
    if (Platform.OS === 'web') return;
    const type = typeFromMime(mimeType);
    const extension = extensionFor(mimeType, originalName, type);
    const baseName = (originalName?.replace(/\.[^.]+$/, '') ?? '').replace(/[^\w\s\u0600-\u06FF-]/g, '').trim().slice(0, 48);
    const item: DownloadItem = {
      id: createId(),
      url: contentUri,
      title: baseName || `ملف مشترك ${new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}`,
      type,
      format: extension,
      quality: 'من المشاركة',
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

  /** الحذف العادي ينقل الملف إلى سلة المحذوفات لمدة 30 يوماً. */
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
    patchItem(id, { deletedAt: Date.now(), status: 'completed', error: undefined, inVault: false });
  }, [patchItem]);

  /** إعادة ملف من السلة إلى قائمة التنزيلات. */
  const restoreFromTrash = useCallback(async (id: string) => {
    patchItem(id, { deletedAt: undefined });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [patchItem]);

  /** حذف نهائي من السلة مع إزالة الملف الفعلي من التخزين. */
  const deletePermanently = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (item?.fileUri && !item.fileUri.startsWith('content://')) {
      try {
        const info = await FileSystem.getInfoAsync(item.fileUri);
        if (info.exists) await FileSystem.deleteAsync(item.fileUri, { idempotent: true });
      } catch {
        // الملف ربما حُذف يدوياً من التخزين
      }
    }
    commit((current) => current.filter((entry) => entry.id !== id));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [commit]);

  /** تفريغ السلة بالكامل. */
  const emptyTrash = useCallback(async () => {
    const trashed = itemsRef.current.filter((item) => item.deletedAt);
    for (const item of trashed) {
      if (item.fileUri && !item.fileUri.startsWith('content://')) {
        try {
          const info = await FileSystem.getInfoAsync(item.fileUri);
          if (info.exists) await FileSystem.deleteAsync(item.fileUri, { idempotent: true });
        } catch {
          // تجاهل أخطاء حذف الملفات الفردية
        }
      }
    }
    commit((current) => current.filter((item) => !item.deletedAt));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

  // استرجاع مجلد التنزيل المحفوظ عند الإقلاع.
  useEffect(() => {
    AsyncStorage.getItem(DOWNLOAD_DIR_KEY)
      .then((stored) => {
        if (stored) {
          setDownloadDirState(stored);
          downloadDirRef.current = stored;
        }
      })
      .catch(() => undefined);
  }, []);

  const setDownloadDir = useCallback(async (uri: string | null) => {
    setDownloadDirState(uri);
    downloadDirRef.current = uri;
    if (uri) {
      await AsyncStorage.setItem(DOWNLOAD_DIR_KEY, uri).catch(() => undefined);
    } else {
      await AsyncStorage.removeItem(DOWNLOAD_DIR_KEY).catch(() => undefined);
    }
  }, []);

  const value = useMemo(() => ({
    items,
    activeCount: items.filter((item) => item.status === 'queued' || item.status === 'downloading').length,
    waitingForWifi,
    addDownload,
    addSharedFile,
    retryDownload,
    removeDownload,
    clearCompleted,
    openFile,
    shareFile,
    moveToVault,
    removeFromVault,
    setQueueOptions,
    downloadDir,
    setDownloadDir,
    restoreFromTrash,
    deletePermanently,
    emptyTrash,
  }), [items, waitingForWifi, addDownload, addSharedFile, retryDownload, removeDownload, clearCompleted, openFile, shareFile, moveToVault, removeFromVault, setQueueOptions, downloadDir, setDownloadDir, restoreFromTrash, deletePermanently, emptyTrash]);

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadProvider');
  return value;
}
