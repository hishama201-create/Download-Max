import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as RNBackgroundDownloader from '@kesha-antonov/react-native-background-downloader';
// واجهة الملفات الحديثة: النسخ عبر تدفق أصلي (Native Stream) يدعم وجهات SAF content://.
import { Directory as NativeDirectory, File as NativeFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import * as MediaLibrary from 'expo-media-library';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { MaxTasks } from '@/context/SettingsContext';
import { setPublicRootProvider, syncHistorySnapshot, upsertHistoryEntry, deleteHistoryEntry } from '@/context/historyDb';
import { extractAudioFromVideo } from '@/context/audio';
import { generateVideoThumbnail } from '@/context/thumbnails';
import type { DownloadStatus, MediaType, MediaRequestOptions, DownloadItem } from './types';
export type { DownloadStatus, MediaType, MediaRequestOptions, DownloadItem } from './types';
import { foregroundDownloadBridge, foregroundDownloadNativeModule, removeForegroundDownload, requestDownloadNotificationPermission, updateForegroundDownload, upsertForegroundDownload } from './foregroundBridge';
import { APP_DIR_NAME, MIME_TYPES, PUBLIC_DOWNLOAD_DIR, SNAPTUBE_DOWNLOAD_DIR, baseDownloadDir, clearSafTypeFolderCaches, deviceSaveErrorSummary, ensureTypeDir, extFromMime, extensionFor, fetchRemoteFileInfo, hasStorageAccess, isSafDirAlive, looksLikeHumanName, mediaFilesIn, mediaTypeOf, mimeFor, mirrorToDeviceDownloads, noteDeviceSaveError, orphanFilesIn, persistSafTypeFolders, pickDeviceDirectory, prettyNameFromUrl, publicDownloadRoot, publicStorageRoot, restoreLegacyHashTitles, safAppRoot, safSubfolder, safTypeFoldersCache, safUriDisplayName, safeFilename, saveFileToSafDirectory, setSafAppRootCache, subfolderFor, typeFromMime, uniqueFilename } from './storage';
export { currentDownloadFolder, ensureDownloadFolders, hasStorageAccess, openAllFilesAccessSettings, saveToPublicAlbum, storageAccessError } from './storage';
import { EXTRACTOR_API_URL, isYoutubeUrl, fetchYoutubeTitle, prepareYoutubeFallback, requestOptionsFor, resolveMediaUrls } from './mediaResolver';
import { isUsableMediaUrl, looksLikeDirectMedia } from './urlHelpers';
export { isYoutubeUrl, youtubeVideoId, resolveStreamUrl, prepareYoutubeFallback, fetchYoutubeTitle, requestOptionsFor, probeMediaSource, previewCarouselImages } from './mediaResolver';
export type { YoutubeFallbackResult, ProbedFormat, MediaProbeResult } from './mediaResolver';

const STORAGE_KEY = '@download-max/downloads';
const DOWNLOAD_DIR_KEY = '@download-max/download-dir';
/** مفتاح حفظ نقطة استئناف كل مهمة متوقفة مؤقتاً (جزء الملف المحمّل). */
const RESUME_KEY_PREFIX = '@download-max/resume/';
/** مدة بقاء الملفات في سلة المحذوفات قبل حذفها تلقائياً (30 يوماً). */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** (v2.0.28) الرابط المباشر المحفوظ لكل مهمة خلفية — يعاد ربطه بعد إغلاق التطبيق كلياً. */
const BG_TASK_KEY_PREFIX = '@download-max/bg-task/';
type BackgroundTask = ReturnType<typeof RNBackgroundDownloader.createDownloadTask>;
/** مرجع حقيقي لمهام المحرك الأصلي، لا لكائن expo-file-system الاحتياطي. */
const backgroundTasks = new Map<string, BackgroundTask>();
const cancelBackgroundTasks = new Map<string, () => void>();


type DownloadContextValue = {
  items: DownloadItem[];
  activeCount: number;
  waitingForWifi: boolean;
  addDownload: (input: Omit<DownloadItem, 'id' | 'status' | 'progress' | 'createdAt'>) => Promise<void>;
  /** يضيف تنزيلاً ذكياً: يكشف كاروسيل الصور وينشئ مهمة لكل صورة. يعيد عدد المهام. */
  addSmartDownload: (input: { url: string; title?: string; type: MediaType; format: string; quality: string }) => Promise<number>;
  /** يضيف صور كاروسيل مختارة مسبقاً (روابط مباشرة) كمهام تنزيل. يعيد عددها. */
  addCarouselImages: (input: { urls: string[]; title?: string }) => Promise<number>;
  /** يحاول جلب رابط فيديو حقيقي لمنشور مختلط (فيديو مدمج بالكاروسيل أو نسخة عرض مولّدة). يعيد null إن لم تتوفر نسخة. */
  resolveCarouselVideo: (sourceUrl: string, videoQuality: string) => Promise<string | null>;
  /** يجلب حجم الملف المقدّر لجودة معينة قبل التنزيل (بايت) أو null عند الفشل. */
  probeFileSize: (input: { url: string; type: MediaType; format: string }) => Promise<number | null>;
  /** يشغّل الملف بنية فتح باستخدام (قائمة مشغلات الفيديو/الصوت/الصور المدعومة). */
  openFile: (item: DownloadItem) => Promise<void>;
  /** يشارك الملف عبر لوحة مشاركة أندرويد (التطبيقات التي تقبل مشاركة الملفات). */
  shareFile: (item: DownloadItem) => Promise<void>;
  /** (2) ينسخ الملف من مساحة التطبيق إلى مجلد التنزيلات الحقيقي في جهاز المستخدم. */
  copyToDeviceDownloads: (item: DownloadItem) => Promise<{ ok: boolean; message: string }>;
  syncPendingToDevice: () => Promise<number>;
  /** (v2.0.20) يفتح منتقي مجلد الجهاز مرة واحدة ثم ينسخ كل ما بقي داخل التطبيق إليه. */
  pickDeviceFolderNow: () => Promise<{ picked: boolean; moved: number; failed: number }>;
  /** (v2.0.20) صحيح عندما فشلت كل مسارات الحفظ العام — تفتح الواجهة منتقي المجلد. */
  deviceSaveNeedsFolder: boolean;
  enableDeviceAutoSave: () => Promise<{ ok: boolean; where: string | null; message: string }>;
  /** يستقبل الملف المشارَك من تطبيق آخر ويحفظه مباشرةً. */
  addSharedFile: (contentUri: string, mimeType: string | null, originalName: string | null) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  /** إيقاف مؤقت لتنزيل جارٍ/منتظر مع حفظ الجزء المحمّل. */
  pauseDownload: (id: string) => Promise<void>;
  /** استئناف تنزيل متوقف من نفس النقطة. */
  resumeDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
  moveToVault: (id: string) => Promise<void>;
  removeFromVault: (id: string) => Promise<void>;
  setQueueOptions: (options: { maxTasks: MaxTasks; maxTasksCellular: MaxTasks; allowMobileData: boolean }) => void;
  /** مجلد التنزيل المختار (SAF URI) أو null للحفظ الداخلي. */
  downloadDir: string | null;
  setDownloadDir: (uri: string | null) => Promise<void>;
  /** يقرأ ملفات الوسائط الموجودة في مجلد التنزيلات على الجهاز ويسجّلها (قراءة فقط). يعيد عدد الملفات المضافة. */
  refreshFromDevice: () => Promise<number>;
  /** إعادة ملف من سلة المحذوفات إلى القائمة. */
  restoreFromTrash: (id: string) => Promise<void>;
  /** حذف ملف من السلة نهائياً مع ملفه الفعلي. */
  deletePermanently: (id: string) => Promise<void>;
  /** تفريغ سلة المحذوفات بالكامل. */
  emptyTrash: () => Promise<void>;
  /** يحوّل فيديو مكتمل إلى ملف صوتي (MP3/M4A) عبر FFmpeg ويضيفه كصف جديد في القائمة. يعيد true عند النجاح. */
  convertVideoToAudio: (id: string, format: 'mp3' | 'm4a', onProgress?: (message: string) => void) => Promise<boolean>;
};

const DownloadContext = createContext<DownloadContextValue | null>(null);

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** (v2.0.12) تحويل عنصر تنزيل إلى صف سجل لقاعدة البيانات العامة. */
function historyEntryOf(item: DownloadItem) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    type: item.type,
    format: item.format,
    quality: item.quality,
    status: item.status,
    progress: item.progress,
    bytesWritten: item.bytesWritten ?? null,
    totalBytes: item.totalBytes ?? null,
    fileUri: item.fileUri ?? null,
    createdAt: item.createdAt,
  };
}


/**
 * يفتح الملف الذي تم تنزيله عبر لوحة مشاركة أندرويد (ACTION_SEND)،
 * للتطبيقات والخصائص التي تقبل مشاركة الملفات.
 */
/**
 * مسار الملف الذي يفهمه FileProvider (content://…SharingFileProvider/…).
 * على أندرويد، expo-sharing يفشل صامتاً مع مسارات file:// الخام — نحوّلها أولاً
 * (نفس التحويل المستخدم في «فتح»)، وإذا تعذر التحويل نمرر المسار كما هو.
 */
async function shareableUri(fileUri: string): Promise<string> {
  const applicationId = Constants.expoConfig?.android?.package;
  const filesDir = FileSystem.documentDirectory;
  if (!applicationId || !filesDir || !fileUri.startsWith(filesDir)) return fileUri;
  const relative = fileUri.slice(filesDir.length).split('/').map(encodeURIComponent).join('/');
  return `content://${applicationId}.SharingFileProvider/expo_files/${relative}`;
}

async function shareDownloadedFile(item: DownloadItem): Promise<{ ok: boolean; message?: string }> {
  if (Platform.OS === 'web' || !item.fileUri) return { ok: false, message: 'الملف غير متاح للمشاركة' };
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return { ok: false, message: 'المشاركة غير مدعومة على هذا الجهاز' };
    const uri = await shareableUri(item.fileUri);
    await Sharing.shareAsync(uri, {
      mimeType: mimeFor(item.fileUri),
      dialogTitle: 'مشاركة الملف',
    });
    return { ok: true };
  } catch (error) {
    // إلغاء المستخدم للوحة المشاركة ليس خطأً.
    if (String((error as Error)?.message ?? '').includes('cancel')) return { ok: true };
    return { ok: false, message: 'تعذّرت المشاركة — تأكد أن الملف موجود وحاول مجدداً' };
  }
}

/**
 * يشغّل الملف الذي تم تنزيله بنية "فتح باستخدام" (ACTION_VIEW):
 * يعرض أندرويد قائمة التطبيقات المدعومة لهذا النوع فقط
 * (مشغلات فيديو/صوت، عارضات صور...) دون المرور بلوحة المشاركة.
 * نمرر الملف عبر مزود ملفات expo-sharing (content://…SharingFileProvider/expo_files/…)
 * مع إذن قراءة مؤقت حتى يستطيع المشغل الخارجي قراءته.
 * عند عدم وجود تطبيق مناسب أو فشل الفتح نرجع للوحة المشاركة كبديل.
 */
async function openWithViewer(item: DownloadItem) {
  if (Platform.OS === 'web' || !item.fileUri) return;
  const applicationId = Constants.expoConfig?.android?.package;
  const filesDir = FileSystem.documentDirectory;
  if (!applicationId || !filesDir || !item.fileUri.startsWith(filesDir)) {
    await shareDownloadedFile(item);
    return;
  }
  // نرمّز كل مقطع من المسار حتى يقرأه FileProvider بشكل صحيح (أسماء عربية، فراغات...).
  const relative = item.fileUri.slice(filesDir.length).split('/').map(encodeURIComponent).join('/');
  // نوع MIME يُستنتج من امتداد الملف الفعلي؛ وإن فشل الاستنتاج نستخدم نوع المهمة (فيديو/صوت/صورة)
  // حتى لا تظهر قائمة التطبيقات عامة (*/*) أبداً — بل مشغلات النوع الصحيح فقط.
  const mime = mimeFor(item.fileUri) !== '*/*'
    ? mimeFor(item.fileUri)
    : item.type === 'image' ? 'image/*' : item.type === 'audio' ? 'audio/*' : 'video/*';
  // (v2.0.15) لا نطلق مشغّلاً على مسار ميت — إطلاق IntentLauncher على ملف
  // غير موجود سبب معروف لتجميد/سقوط التطبيق على أندرويد.
  const fileInfo = await FileSystem.getInfoAsync(item.fileUri).catch(() => null);
  if (!fileInfo?.exists) return;
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: `content://${applicationId}.SharingFileProvider/expo_files/${relative}`,
      type: mime,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION — إذن قراءة مؤقت للتطبيق الذي يفتح الملف
    });
  } catch {
    // لا مشغل مناسب لهذا النوع أو فشل الفتح — لوحة المشاركة كبديل حتى لا يبقى الزر ميتاً.
    try {
      await shareDownloadedFile(item);
    } catch { /* تجاهل */ }
  }
}


/** (v2.0.28) إعداد مختلف لمكان مكث.HttpStatusator */
// الخيارات: التنزيل يسمح ببيانات الجوال ويُظهر تنبيهاً عند الأجهزة المدعومة.
let bgDownloaderConfigured = false;
function ensureBackgroundDownloaderConfig(): void {
  if (bgDownloaderConfigured) return;
  try {
    RNBackgroundDownloader.setConfig({
      progressInterval: 500,
      allowsCellularAccess: true,
      showNotificationsEnabled: true,
      showCompletionNotification: true,
      notificationsGrouping: {
        enabled: true,
        mode: 'summaryOnly',
        texts: {
          downloadTitle: 'تنزيل جارٍ',
          downloadStarting: 'بدء التنزيل…',
          downloadProgress: 'جارٍ التنزيل… {progress}%',
          downloadPaused: 'متوقف مؤقتاً',
          downloadFinished: 'اكتمل التنزيل ✓',
          downloadCancel: 'إلغاء',
          groupTitle: 'التنزيلات',
        },
      },
    });
    bgDownloaderConfigured = true;
  } catch {
    // المكتبة غير متاحة على منصة الويب — فشل صامت؛ المحرك القديم يبقى شاحًا.
  }
}

/** (v2.0.28) تشغيل مهمة تنزيل على محرك الخلفية النظامي (يعمل ولو أُغلقت بجاك). */
async function runBackgroundDownload(
  id: string,
  url: string,
  destination: string,
  record: { title: string; format: string },
  handlers: {
    onProgress: (bytesWritten: number, totalBytes: number) => void;
    onDone: (location: string) => void | Promise<void>;
    onError: (message: string) => void;
  },
): Promise<boolean> {
  ensureBackgroundDownloaderConfig();
  const task = RNBackgroundDownloader.createDownloadTask({
    id,
    url,
    destination,
    isAllowedOverMetered: true,
    isAllowedOverRoaming: true,
    metadata: { id, ...record },
  });
  let settled = false;
  try {
    // يحفظ سجل الاستعادة قبل تسليم المهمة للنظام؛ لا توجد نافذة يبدأ فيها التنزيل
    // ثم يُغلق التطبيق قبل تسجيله.
    await AsyncStorage.setItem(BG_TASK_KEY_PREFIX + id, JSON.stringify({ destination, directUrl: url, ...record }));
    backgroundTasks.set(id, task);
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const finish = (success: boolean) => {
      if (settled) return false;
      settled = true;
      cancelBackgroundTasks.delete(id);
      resolve(success);
      return true;
    };
    cancelBackgroundTasks.set(id, () => { finish(false); });
    try {
      task
        .progress(({ bytesDownloaded, bytesTotal }) => {
          if (!settled) handlers.onProgress(bytesDownloaded, bytesTotal);
        })
        .done(({ location }) => {
          if (settled) return;
          settled = true;
          cancelBackgroundTasks.delete(id);
          void Promise.resolve(handlers.onDone(location))
            .then(() => {
              backgroundTasks.delete(id);
              resolve(true);
            })
            .catch((error) => {
              backgroundTasks.delete(id);
              handlers.onError(error instanceof Error ? error.message : 'تعذر إتمام حفظ التنزيل الخلفي.');
              resolve(false);
            });
        })
        .error(({ error }) => {
          if (!finish(false)) return;
          backgroundTasks.delete(id);
          void AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + id);
          handlers.onError(error || 'فشل التنزيل الخلفي.');
        });
      task.start();
    } catch {
      finish(false);
      backgroundTasks.delete(id);
      void AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + id);
      handlers.onError('تعذر بدء محرك التنزيل الخلفي.');
    }
  });
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [waitingForWifi, setWaitingForWifi] = useState(false);
  const [downloadDir, setDownloadDirState] = useState<string | null>(null);
  const [downloadsRestored, setDownloadsRestored] = useState(false);

  // مراجع تعمل خارج دورة الرسم لإدارة الطابور بأمان.
  const itemsRef = useRef<DownloadItem[]>([]);
  const queueRef = useRef<string[]>([]);
  const activeIdsRef = useRef<Set<string>>(new Set());
  const maxTasksRef = useRef<MaxTasks>(3);
  const maxTasksCellularRef = useRef<MaxTasks>(2);
  const allowMobileDataRef = useRef(true);
  const isCellularRef = useRef(false);
  /** طول الملف من فحص HEAD لكل مهمة، لا قيمة مشتركة تفسد تقدم التنزيلات المتزامنة. */
  const remoteLengthsRef = useRef(new Map<string, number | null>());
  const cancelledBackgroundIdsRef = useRef(new Set<string>());
  const foregroundActionHandlerRef = useRef<(action: { id: string; action: string }) => void>(() => undefined);
  const downloadsRestoredRef = useRef(false);
  const pendingForegroundActionsRef = useRef<Array<{ id: string; action: string }>>([]);
  const pendingActionsConsumedRef = useRef(false);
  const downloadDirRef = useRef<string | null>(null);
  const canDownloadRef = useRef(true);
  const resumablesRef = useRef(new Map<string, FileSystem.DownloadResumable>());
  const progressRef = useRef(new Map<string, { progress: number; at: number }>());
  const bytesRef = useRef(new Map<string, { bytesWritten: number; totalBytes?: number }>());
  // (v2.0.12) الرابط المباشر الحالي لكل مهمة — مطلوب للاستئناف الحقيقي بلا إعادة استخراج
  // (يوتيوب يغير رابطه في كل استخراج فكان الاستئناف يفشل ويعيد التنزيل من الصفر).
  const directUrlRef = useRef(new Map<string, string>());
  /** مهام طلب المستخدم إيقافها — تمييز الإيقاف المقصود عن الإلغاء داخل runJob. */
  const pauseRequestedRef = useRef(new Set<string>());
  const pumpRef = useRef<() => void>(() => undefined);
  const runJobRef = useRef<(id: string) => void>(() => undefined);

  // (v2.0.12) حفظ القائمة الدائم يُخفَّف: تحديثات التقدم تحدث كل 250ms وتعيد تسلسل
  // JSON لكل العناصر في كل مرة — عبء واضح على الإيقاف/الاستئناف والواجهة.
  // الآن: الكتابة الفورية عند تغيّر الحالة (queued/downloading/paused/completed/failed)،
  // وتهدئة (throttle) 1.2 ثانية لتحديثات التقدم فقط.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistPending: DownloadItem[] | null = null;
  const persistNow = useCallback((next: DownloadItem[]) => {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);
  const commit = useCallback((updater: (current: DownloadItem[]) => DownloadItem[]) => {
    setItems((current) => {
      const next = updater(current);
      itemsRef.current = next;
      const stateChanged = next.some((entry, index) => {
        const previous = current[index];
        return !previous || previous.id !== entry.id || previous.status !== entry.status;
      });
      if (stateChanged) {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        persistPending = null;
        persistNow(next);
      } else if (persistTimer) {
        persistPending = next;
      } else {
        persistPending = next;
        persistTimer = setTimeout(() => {
          persistTimer = null;
          if (persistPending) persistNow(persistPending);
          persistPending = null;
        }, 1200);
      }
      return next;
    });
  }, [persistNow]);

  const patchItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    commit((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, [commit]);

  // (v2.0.20) صحيح عندما فشلت كل مسارات الحفظ العام لتنزيل مكتمل —
  // الواجهة تفتح منتقي المجلد مرة واحدة بدل الفشل الصامت.
  const [deviceSaveNeedsFolder, setDeviceSaveNeedsFolder] = useState(false);

  /** مهمة تنزيل واحدة: تستخرج الرابط المباشر ثم تنزّل مع تتبع التقدم. */
  const runJob = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) {
      activeIdsRef.current.delete(id);
      pumpRef.current();
      return;
    }

    await patchItem(id, { status: 'downloading', progress: item.progress > 0 ? item.progress : 0, error: undefined });

    if (Platform.OS === 'web') {
      await patchItem(id, { status: 'failed', error: 'التنزيل المباشر متاح من تطبيق Android فقط.' });
      activeIdsRef.current.delete(id);
      pumpRef.current();
      return;
    }

    // إذا كانت هذه مهمة Android محفوظة وحية، فاستئنافها لا يحتاج استخراج الرابط
    // ولا إنشاء مهمة ثانية بالمعرّف نفسه.
    const existingBackgroundTask = backgroundTasks.get(id);
    if (existingBackgroundTask) {
      try {
        if (existingBackgroundTask.state === 'PAUSED') {
          await existingBackgroundTask.resume();
        } else if (existingBackgroundTask.state !== 'DOWNLOADING' && existingBackgroundTask.state !== 'PENDING') {
          throw new Error('مهمة Android السابقة لم تعد قابلة للاستئناف.');
        }
        const raw = await AsyncStorage.getItem(BG_TASK_KEY_PREFIX + id);
        const saved = raw ? JSON.parse(raw) as { destination?: string } : {};
        updateForegroundDownload(item, saved.destination ?? existingBackgroundTask.destination ?? '', item.totalBytes ?? 0, false);
        return;
      } catch {
        const nativeRunnerActive = cancelBackgroundTasks.has(id);
        backgroundTasks.delete(id);
        if (nativeRunnerActive) {
          // أعد ملكية خانة الطابور إلى runJob الأصلي؛ هو الوحيد الذي سيبدأ
          // المحرك الاحتياطي بعد أن نوقظ انتظاره، فلا ننشئ تنزيلين متوازيين.
          activeIdsRef.current.add(id);
          removeForegroundDownload(id);
          cancelBackgroundTasks.get(id)?.();
          return;
        }
        cancelBackgroundTasks.delete(id);
        await AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + id).catch(() => undefined);
        removeForegroundDownload(id);
        // لا يوجد مستمع قديم يملك المهمة (استعادة بعد إقلاع)، فنكمل بمحرك Expo.
      }
    }

    try {
      const baseDirectory = await baseDownloadDir();
      if (!baseDirectory) throw new Error('تعذر الوصول إلى مساحة التخزين.');

      // الملفات المحلية المشارَكة (content:// أو file://) تُنسخ مباشرة بلا تنزيل شبكي.
      if (!/^https?:\/\//i.test(item.url)) {
        // الاسم الأصلي من نظام المشاركة محفوظ في العنوان، ونضمن امتداداً صالحاً دائماً.
        const filename = safeFilename(item.title, extensionFor(mimeFor(item.format), item.title, item.type));
        // (v2.0.19) الحفظ في مساحة التطبيق دائماً (فتح/مشاركة/حذف يعتمدون عليه)
        // ثم نسخة للمجلد العام عبر السلسلة المضمونة (SAF المختار → الألبوم) — بلا رسالة خطأ.
        const typeDir = await ensureTypeDir(baseDirectory, item.type);
        const finalName = await uniqueFilename(typeDir || baseDirectory, filename);
        const target = `${typeDir || baseDirectory}${finalName}`;
        await FileSystem.copyAsync({ from: item.url, to: target });
        const info = await FileSystem.getInfoAsync(target);
        const size = 'size' in info && typeof info.size === 'number' ? info.size : undefined;
        const deviceSaved = await mirrorToDeviceDownloads(target, finalName, item.type, downloadDirRef.current).catch(() => false);
        if (!deviceSaved) setDeviceSaveNeedsFolder(true);
        await patchItem(id, {
          status: 'completed',
          progress: 1,
          bytesWritten: size,
          totalBytes: size,
          fileUri: target,
          deviceSaved: deviceSaved || undefined,
        });
        void upsertHistoryEntry(historyEntryOf({ ...item, status: 'completed', progress: 1, bytesWritten: size, totalBytes: size, fileUri: target }));
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (item.type === 'video') {
          void generateVideoThumbnail(target)
            .then((thumb) => { if (thumb) patchItem(id, { thumbnailUri: thumb }); })
            .catch(() => undefined);
        }
        return;
      }

      // روابط ناتجة عن استخراج سابق تُنزَّل كما هي دون إعادة استخراج.
      // يوتيوب: الخدمة الأساسية كثيراً ما ترفض (youtube.login) — نستخدم الخدمة الاحتياطية مباشرة،
      // ونفشل إلى الخدمة الأساسية إذا تعذرت الاحتياطية.
      let mediaUrl: string;
      let youtubeTitle: string | null = null;
      if (!item.resolvedUrl && isYoutubeUrl(item.url)) {
        try {
          const qualityMatch = item.quality.match(/(144|240|360|480|540|720|1080|1440|2160)/);
          const prepared = await prepareYoutubeFallback(item.url, {
            mode: item.type === 'audio' ? 'audio' : 'video',
            format: item.type === 'audio' ? item.format : (qualityMatch?.[1] ?? (item.format.replace(/[^0-9]/g, '') || '720')),
          });
          mediaUrl = prepared.url;
          youtubeTitle = prepared.title;
        } catch (fallbackError) {
          // الاحتياطية فشلت — نجرب الأساسية كمحاولة أخيرة قبل إعلان الفشل.
          try {
            [mediaUrl] = await resolveMediaUrls(item.url, item.requestOptions);
          } catch {
            throw fallbackError;
          }
        }
      } else {
        [mediaUrl] = await resolveMediaUrls(item.url, item.requestOptions);
      }
      if (!isUsableMediaUrl(mediaUrl)) {
        // (v2.0.16) رابط وهمي من خدمة الاستخراج — لا نبدأ تنزيلاً محكوماً بالفشل.
        throw new Error('الخدمة لم ترجع رابطاً صالحاً — جرّب جودة أخرى أو رابطاً بديلاً');
      }
      // (v2.0.18) الوجهة: مساحة التطبيق دائماً — الألبوم العام يُضاف تلقائياً بعد الاكتمال.
      const initialTypeDir = await ensureTypeDir(baseDirectory, item.type);
      let target = `${initialTypeDir || baseDirectory}${await uniqueFilename(initialTypeDir || baseDirectory, safeFilename(item.title, item.format))}`;

      // جلب الاسم الأصلي والنوع من ترويسات الخادم حتى يُحفظ الملف باسمه وصيغته الحقيقية.
      let resolvedTitle = item.title;
      let resolvedFormat = item.format;
      // اسم فيديو يوتيوب الحقيقي من الخدمة الاحتياطية (أو oEmbed إن لم يتوفر).
      if (youtubeTitle) {
        resolvedTitle = youtubeTitle;
      } else if (!item.resolvedUrl && isYoutubeUrl(item.url)) {
        const oembedTitle = await fetchYoutubeTitle(item.url);
        if (oembedTitle) resolvedTitle = oembedTitle;
      }
      // (v2.0.12) نحفظ الرابط المباشر فور استخراجه — إيقاف مؤقت لاحق سيستأنف منه بلا استخراج جديد.
      directUrlRef.current.set(id, mediaUrl);
      const remoteInfo = await fetchRemoteFileInfo(mediaUrl);
      // يوتيوب غالباً يبث بدون ترويسة طول أثناء التنزيل نفسه — نستخدم طول HEAD كمرجع للنسبة.
      remoteLengthsRef.current.set(id, remoteInfo.length ?? null);
      if (remoteInfo.length && remoteInfo.length > 0) {
        await patchItem(id, { totalBytes: remoteInfo.length });
      }
      const remoteCandidate = remoteInfo.filename ?? prettyNameFromUrl(mediaUrl);
      // (إصلاح v2.0.11) اسم الخادم يُعتمد فقط إذا كان بشرياً — لا بصمات هاش مكان العناوين.
      const remoteName = remoteCandidate && looksLikeHumanName(remoteCandidate.replace(/\.[^.]+$/, '')) ? remoteCandidate : null;
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

      let lastAt = 0;

      // (6) أحداث التقدّم من expo-file-system القديمة لا تصل تحت New Architecture، فيبقى
      // الشريط عند 0% حتى يكتمل الملف. نقيس حجم الملف على القرص بأنفسنا كل ~350ms.
      let watchStopped = false;
      const progressWatcher = setInterval(() => {
        if (watchStopped) return;
        void (async () => {
          try {
            const stat = await FileSystem.getInfoAsync(target);
            if (!('size' in stat) || typeof stat.size !== 'number' || stat.size <= 0) return;
            const expected = remoteLengthsRef.current.get(id) ?? item.totalBytes ?? 0;
            const now = Date.now();
            if (now - lastAt < 300) return;
            lastAt = now;
            bytesRef.current.set(id, { bytesWritten: stat.size, totalBytes: expected > 0 ? expected : undefined });
            if (expected <= 0) {
              // ما نعرف الحجم الكلي — نحدّث البايتات على الأقل ليشوف المستخدم الملف يكبر.
              patchItem(id, { progress: 0.001, bytesWritten: stat.size });
              return;
            }
            const ratio = stat.size / expected;
            if (ratio <= 0 || ratio >= 1) return;
            progressRef.current.set(id, { progress: ratio, at: now });
            patchItem(id, { progress: ratio, bytesWritten: stat.size, totalBytes: expected });
          } catch { /* الملف لم يُنشأ بعد — ننتظر الدورة القادمة */ }
        })();
      }, 350);
      const onProgress = (progress: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
        const expected = progress.totalBytesExpectedToWrite > 0
          ? progress.totalBytesExpectedToWrite
          : remoteLengthsRef.current.get(id) ?? 0;
        const nextProgress = expected > 0
          ? Math.min(Math.max(progress.totalBytesWritten / expected, 0.001), 0.999)
          : 0.001;
        if (expected > 0 && progress.totalBytesWritten <= 0) return;
        const now = Date.now();
        // تحديث لحظي كل ربع ثانية بغض النظر عن حجم القفزة — حتى لا يبدو التقدم متجمداً في الملفات الكبيرة.
        if (now - lastAt < 250) return;
        lastAt = now;
        progressRef.current.set(id, { progress: nextProgress, at: now });
        bytesRef.current.set(id, { bytesWritten: progress.totalBytesWritten, totalBytes: expected > 0 ? expected : undefined });
        patchItem(id, {
          progress: nextProgress,
          bytesWritten: progress.totalBytesWritten,
          totalBytes: expected > 0 ? expected : undefined,
        });
      };

      // استئناف من نقطة توقف محفوظة (إن وُجدت) بدل البدء من الصفر.
      let resumable: FileSystem.DownloadResumable | null = null;
      let resumedFromPause = false;
      try {
        const savedRaw = await AsyncStorage.getItem(RESUME_KEY_PREFIX + id);
        if (savedRaw) {
          const saved = JSON.parse(savedRaw) as { url?: string; fileUri?: string; resumeData?: string; __directUrl?: string };
          // (v2.0.12) الاستئناف الحقيقي: الرابط المباشر المحفوظ يُعتمد مباشرة حتى لو
          // تغيّر mediaUrl المستخرج حديثاً (يوتيوب يغيّر روابطه في كل استخراج).
          if (saved?.__directUrl && saved.fileUri) {
            const partial = await FileSystem.getInfoAsync(saved.fileUri);
            if (partial.exists) {
              mediaUrl = saved.__directUrl;
              target = saved.fileUri;
              resumable = FileSystem.createDownloadResumable(saved.__directUrl, saved.fileUri, {}, onProgress, saved.resumeData);
              resumedFromPause = true;
            }
          } else if (saved?.url === mediaUrl && saved.fileUri) {
            const partial = await FileSystem.getInfoAsync(saved.fileUri);
            if (partial.exists) {
              target = saved.fileUri;
              resumable = FileSystem.createDownloadResumable(saved.url, saved.fileUri, {}, onProgress, saved.resumeData);
              resumedFromPause = true;
            }
          }
          if (!resumedFromPause) await AsyncStorage.removeItem(RESUME_KEY_PREFIX + id);
        }
      } catch { /* حالة الاستئناف غير صالحة — بدء عادي */ }

      if (!resumable) {
        // إزالة أي بقايا من محاولة سابقة حتى يبدأ التقدم من الصفر.
        const existing = await FileSystem.getInfoAsync(target);
        if (existing.exists) await FileSystem.deleteAsync(target, { idempotent: true });
        resumable = FileSystem.createDownloadResumable(mediaUrl, target, {}, onProgress);
      }
      resumablesRef.current.set(id, resumable);

      // الحفاظ على البايتات المحمّلة سابقاً عند الاستئناف (قد لا يصل حدث تقدم جديد قبل الاكتمال).
      const currentItem = itemsRef.current.find((candidate) => candidate.id === id);
      if (!bytesRef.current.has(id) && currentItem?.bytesWritten) {
        bytesRef.current.set(id, { bytesWritten: currentItem.bytesWritten, totalBytes: currentItem.totalBytes });
      }

      let result: FileSystem.FileSystemDownloadResult | undefined;
      // (v2.0.28) المسار الأساسي: محرك التنزيل الخلفي الأصلي (DownloadManager) —
      // التنزيل يكمل ولو خرج المستخدم من التطبيق أو أطفأ الشاشة، لأنه خارج خيط JS.
      // شبكة الأمان: عند أي رفض من محرك الخلفية نستأنف بالمحرك القديم (expo resumable).
      const bgDestination = `${target.replace(/[\\/]+$/, '')}.part`;
      let bgUsed = false;
      try {
        const expectedSize = remoteLengthsRef.current.get(id) ?? item.totalBytes ?? 0;
        await requestDownloadNotificationPermission();
        // الإشعار يراقب الملف المؤقت الحقيقي، لا الاسم النهائي الذي لا يظهر إلا عند اكتمال النقل.
        upsertForegroundDownload({ ...item, title: resolvedTitle }, bgDestination, expectedSize, false);
        bgUsed = await runBackgroundDownload(id, mediaUrl, bgDestination, {
          title: resolvedTitle,
          format: resolvedFormat,
        }, {
          onProgress: (bytesWritten, totalBytes) => {
            const expected = totalBytes > 0 ? totalBytes : remoteLengthsRef.current.get(id) ?? item.totalBytes ?? 0;
            const now = Date.now();
            if (now - lastAt < 250) return;
            lastAt = now;
            const nextProgress = expected > 0
              ? Math.min(Math.max(bytesWritten / expected, 0.001), 0.999)
              : 0.001;
            progressRef.current.set(id, { progress: nextProgress, at: now });
            bytesRef.current.set(id, { bytesWritten, totalBytes: expected > 0 ? expected : undefined });
            patchItem(id, {
              progress: nextProgress,
              bytesWritten,
              totalBytes: expected > 0 ? expected : undefined,
            });
            updateForegroundDownload({ ...item, title: resolvedTitle }, bgDestination, expected, false);
          },
          onDone: async (location) => {
            // اكتمال حقيقي في الخلفية: ننقل الجزء إلى الاسم النهائي ثم نكمل سلسلة الحفظ.
            watchStopped = true;
            clearInterval(progressWatcher);
            if (resumablesRef.current.get(id)) resumablesRef.current.delete(id);
            try {
              const info = await FileSystem.getInfoAsync(location);
              if (!info.exists) throw new Error('اكتمل التنزيل لكن الملف المؤقت غير موجود.');
              const finalPath = `${initialTypeDir || baseDirectory}${await uniqueFilename(initialTypeDir || baseDirectory, safeFilename(resolvedTitle, resolvedFormat))}`;
              try {
                await FileSystem.moveAsync({ from: location, to: finalPath });
              } catch {
                await FileSystem.copyAsync({ from: location, to: finalPath });
                await FileSystem.deleteAsync(location, { idempotent: true });
              }
              target = finalPath;
              const statAfter = await FileSystem.getInfoAsync(target).catch(() => null);
              const finalSize = statAfter && 'size' in statAfter && typeof statAfter.size === 'number' ? statAfter.size : undefined;
              const deviceSaved = await mirrorToDeviceDownloads(target, target.split('/').pop() ?? 'file', item.type, downloadDirRef.current).catch(() => false);
              if (!deviceSaved) setDeviceSaveNeedsFolder(true);
              await patchItem(id, {
                status: 'completed',
                progress: 1,
                bytesWritten: finalSize,
                totalBytes: finalSize,
                fileUri: target,
                title: resolvedTitle,
                format: resolvedFormat,
                deviceSaved: deviceSaved || undefined,
              });
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              void upsertHistoryEntry(historyEntryOf({ ...item, title: resolvedTitle, format: resolvedFormat, status: 'completed', progress: 1, bytesWritten: finalSize, totalBytes: finalSize, fileUri: target }));
              if (item.type === 'video') {
                void generateVideoThumbnail(target)
                  .then((thumb) => { if (thumb) patchItem(id, { thumbnailUri: thumb }); })
                  .catch(() => undefined);
              }
              await AsyncStorage.removeItem(RESUME_KEY_PREFIX + id).catch(() => undefined);
              await AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + id).catch(() => undefined);
              directUrlRef.current.delete(id);
              removeForegroundDownload(id);
            } catch (completionError) {
              const message = completionError instanceof Error ? completionError.message : 'تعذر إتمام حفظ الملف بعد اكتمال التنزيل.';
              await patchItem(id, { status: 'failed', error: message });
              throw completionError;
            } finally {
              activeIdsRef.current.delete(id);
              pumpRef.current();
            }
          },
          onError: async (message) => {
            patchItem(id, { error: message });
            removeForegroundDownload(id);
          },
        });
      } catch (bgError) {
        bgUsed = false;
      }

      if (cancelledBackgroundIdsRef.current.has(id)) {
        watchStopped = true;
        clearInterval(progressWatcher);
        return;
      }

      if (bgUsed) {
        // انتهت المهمة الأصلية واستُكمل حفظ الملف داخل onDone.
        watchStopped = true;
        clearInterval(progressWatcher);
        return;
      }

      // لا نترك إشعار المحرك الأصلي ظاهراً إذا استُخدم مسار Expo الاحتياطي.
      removeForegroundDownload(id);

      // — شبكة الأمان (شبكة A/B): المحرك القديم expo resumable — يُستخدم إذا رفض محرك الخلفية —
      try {
        result = resumedFromPause ? await resumable.resumeAsync() : await resumable.downloadAsync();
      } catch (resumeError) {
        if (!resumedFromPause) throw resumeError;
        // الخادم لا يدعم الاستئناف من نقطة التوقف — نمسح الجزء المحمّل ونعيد من الصفر.
        await AsyncStorage.removeItem(RESUME_KEY_PREFIX + id).catch(() => undefined);
        directUrlRef.current.delete(id);
        try {
          const partial = await FileSystem.getInfoAsync(target);
          if (partial.exists) await FileSystem.deleteAsync(target, { idempotent: true });
        } catch { /* تجاهل */ }
        progressRef.current.delete(id);
        bytesRef.current.delete(id);
        patchItem(id, { progress: 0 });
        const fresh = FileSystem.createDownloadResumable(mediaUrl, target, {}, onProgress);
        resumablesRef.current.set(id, fresh);
        result = await fresh.downloadAsync();
      }
      // ننظف حالة الاستئناف فقط عند انتهاء حقيقي — الإيقاف المؤقت يحتاجها للاستئناف لاحقاً.
      if (result) await AsyncStorage.removeItem(RESUME_KEY_PREFIX + id).catch(() => undefined);
      watchStopped = true;
      clearInterval(progressWatcher);
      // (6) التنظيف ينتمي لهذه المهمة فقط: الطريقة القديمة كانت تمسح الـ resumable
      // الذي سجّلته مهمة استئناف جديدة، فيفشل الإيقاف في المرة الثانية.
      if (resumablesRef.current.get(id) === resumable) {
        resumablesRef.current.delete(id);
        progressRef.current.delete(id);
        bytesRef.current.delete(id);
      }
      const finalBytes = bytesRef.current.get(id);
      // (v2.0.12) الرابط المباشر يُمسح فقط بعد انتهاء حقيقي (نجاح/فشل) — الإيقاف يحتاجه.
      if (result) directUrlRef.current.delete(id);

      if (!result) {
        // المهمة توقفت مؤقتاً بطلب المستخدم أو أُلغيت (حذف من القائمة) — لا تعتبر فشلاً.
        const wasPaused = pauseRequestedRef.current.has(id);
        pauseRequestedRef.current.delete(id);
        if (wasPaused) {
          const live = itemsRef.current.find((candidate) => candidate.id === id);
          if (live && !live.deletedAt) await patchItem(id, { status: 'paused' });
        }
      } else if (result.status === 200) {
        // ضمان صيغة صحيحة: إن كان الرابط المباشر يحمل امتداداً واضحاً نعتمده.
        let finalFormat = resolvedFormat;
        const uriExt = result.uri.split('.').pop()?.toLowerCase();
        if (uriExt && /^[a-z0-9]{2,5}$/i.test(uriExt) && MIME_TYPES[uriExt]) finalFormat = uriExt;
        const finalFilename = await uniqueFilename(initialTypeDir || baseDirectory, safeFilename(resolvedTitle, finalFormat));
        if (result.uri !== `${initialTypeDir}${finalFilename}`) {
          try {
            await FileSystem.moveAsync({ from: result.uri, to: `${initialTypeDir}${finalFilename}` });
          } catch {
            // نُبقي المسار الأصلي عند تعذر النقل.
          }
        }
        target = `${initialTypeDir}${finalFilename}`;
        // (v2.0.20) نسخة لمجلد الجهاز عبر السلسلة المضمونة — النتيجة تُسجَّل على العنصر
        // حتى لا تتكرر المحاولة، وفشلها الكلي يفتح منتقي المجلد مرة واحدة بدل الصمت.
        const deviceSaved = await mirrorToDeviceDownloads(target, finalFilename, item.type, downloadDirRef.current).catch(() => false);
        if (!deviceSaved) setDeviceSaveNeedsFolder(true);
        await patchItem(id, {
          status: 'completed',
          progress: 1,
          bytesWritten: finalBytes?.bytesWritten,
          totalBytes: finalBytes?.totalBytes,
          fileUri: target,
          title: resolvedTitle,
          format: finalFormat,
          deviceSaved: deviceSaved || undefined,
        });
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        void upsertHistoryEntry(historyEntryOf({ ...item, title: resolvedTitle, format: finalFormat, status: 'completed', progress: 1, bytesWritten: finalBytes?.bytesWritten, totalBytes: finalBytes?.totalBytes, fileUri: target }));
        // توليد صورة مصغّرة للفيديو في الخلفية — فشلها لا يؤثر على اكتمال الملف.
        if (item.type === 'video') {
          void generateVideoThumbnail(target)
            .then((thumb) => { if (thumb) patchItem(id, { thumbnailUri: thumb }); })
            .catch(() => undefined);
        }
      } else {
        await patchItem(id, { status: 'failed', error: `تعذر تنزيل الملف (رمز ${result?.status ?? 'مجهول'}).` });
        void upsertHistoryEntry(historyEntryOf({ ...item, status: 'failed' }));
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (err) {
      resumablesRef.current.delete(id);
      progressRef.current.delete(id);
      bytesRef.current.delete(id);
      directUrlRef.current.delete(id);
      await patchItem(id, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'فشل التنزيل. تحقق من الرابط والاتصال ثم حاول مرة أخرى.',
      });
      void upsertHistoryEntry(historyEntryOf({ ...item, status: 'failed' }));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      activeIdsRef.current.delete(id);
      cancelledBackgroundIdsRef.current.delete(id);
      remoteLengthsRef.current.delete(id);
      pumpRef.current();
    }
  }, [patchItem]);

  /** يشغّل المهام التالية في الطابور حتى بلوغ حد التنزيلات المتزامنة. */
  const pump = useCallback(() => {
    const limit = isCellularRef.current ? maxTasksCellularRef.current : maxTasksRef.current;
    if (activeIdsRef.current.size >= limit) return;
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
    const activeLimit = isCellularRef.current ? maxTasksCellularRef.current : maxTasksRef.current;
    if (activeIdsRef.current.size < activeLimit && queueRef.current.length > 0) {
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
      isCellularRef.current = isCellular;
      canDownloadRef.current = isConnected && (!isCellular || allowMobileDataRef.current);
      pumpRef.current();
    };
    const unsubscribe = NetInfo.addEventListener(update);
    NetInfo.fetch().then(update).catch(() => undefined);
    return () => {
      unsubscribe();
    };
  }, []);

  // (v2.0.28) شبكة أمان عند الخروج للخلفية: أي مهمة لا تسير على محرك الخلفية
  // نحفظ حالتها (resume) تلقائياً مثل زر الإيقاف — فلا يضيع التقدم ولا يتكرر التنزيل.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state: string) => {
      if (state !== 'background' && state !== 'inactive') return;
      // (v2.0.31) إصلاح علة حرجة: كان التحقق «งAsyncStorage.getItem(... ) !== null» يُقارن
      // Promise نفسه وليس نتيجته — فكان دائماً صحيحاً وتتخطى الحلقة كل المهمّات،
      // ولا تُحفظ حالة أي مهمة قديمة المحرك عند الخروج للخلفية وضاع التقدم.
      void (async () => {
        const bgTaskIds = new Set<string>();
        try {
          for (const id of Array.from(activeIdsRef.current)) {
            const record = await AsyncStorage.getItem(BG_TASK_KEY_PREFIX + id).catch(() => null);
            if (record === null) continue;
            bgTaskIds.add(id);
          }
        } catch { /* فشل الفحص — نعامل الكل كمهام غير خلفية لتفعيل شبكة الأمان */ }
        for (const id of Array.from(activeIdsRef.current)) {
          // المهام على المحرك الخلفي أصلًا خارج JS — نكتفي بحفظ حالة المهمة للعودة.
          if (bgTaskIds.has(id)) continue;
          const resumable = resumablesRef.current.get(id);
          if (!resumable) continue;
          void (async () => {
            try {
              const directUrl = directUrlRef.current.get(id);
              const state = (await resumable.pauseAsync().catch(() => undefined)) as { fileUri?: string } | undefined;
              if (state?.fileUri) {
                await AsyncStorage.setItem(
                  RESUME_KEY_PREFIX + id,
                  JSON.stringify(directUrl ? { ...state, __directUrl: directUrl } : state),
                );
                patchItem(id, { status: 'paused' });
              }
            } catch { /* الحفظ فشل — المهمة تكمل سلوكها العادي عند العودة */ }
          })();
        }
      })();
    });
    return () => subscription.remove();
  }, [patchItem]);

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
      .then(async (stored) => {
        if (!stored || cancelled) return;
        const parsed = JSON.parse(stored) as DownloadItem[];
        const currentIds = new Set(itemsRef.current.map((existing) => existing.id));
        const merged = [...itemsRef.current, ...parsed.filter((existing) => !currentIds.has(existing.id))]
          .sort((a, b) => b.createdAt - a.createdAt);
        itemsRef.current = merged;
        setItems(merged);
        // (v2.0.12) مزامنة أولية لقاعدة السجل في DownloadMax/db/downloads.db
        void syncHistorySnapshot(merged.filter((entry) => !entry.deletedAt).map(historyEntryOf));
        // (v2.0.12) تصحيح عناوين الهاش القديمة من الخادم في الخلفية
        void restoreLegacyHashTitles(merged.filter((entry) => !entry.deletedAt && entry.status === 'completed'), patchItem);
        // (v2.0.20) إصلاح تلقائي شامل: كل ملف مكتمل بلا نسخة في مجلد الجهاز
        // (بما فيها ملفات الإصدارات القديمة الموسومة بالخطأ الأحمر) يُنسخ الآن
        // عبر السلسلة المضمونة — ويظهر في ملفات الجهاز بدون أي ضغطة.
        if (Platform.OS !== 'web') {
          void (async () => {
            const broken = itemsRef.current.filter(
              (entry) => entry.status === 'completed' && !!entry.fileUri && !entry.deviceSaved && !entry.inVault && !entry.deletedAt && entry.fileUri.startsWith('file://'),
            );
            for (const entry of broken) {
              const source = entry.fileUri;
              if (!source) continue;
              const filename = source.split('/').pop() ?? 'file';
            const ok = await mirrorToDeviceDownloads(source, filename, entry.type, downloadDirRef.current).catch((error) => {
              noteDeviceSaveError('مزامنة الجهاز', error);
              return false;
            });
            if (ok) patchItem(entry.id, { error: undefined, deviceSaved: true });
            // (v2.0.23) سلسلة الأسباب الكاملة بدل النص القديم — وتُمسح تلقائياً عند نجاح النسخ.
            else if (deviceSaveErrorSummary()) patchItem(entry.id, { error: `لم يُحفظ في مجلد الجهاز — ${deviceSaveErrorSummary()}` });
            }
          })();
        }

        for (const item of merged) {
          if (item.status === 'queued') {
            patchItem(item.id, { status: 'queued', progress: 0, error: undefined });
            enqueue(item.id);
          }
          // المهام المتوقفة تبقى متوقفة كما أوقفها المستخدم — لا تُعاد للتحميل تلقائياً.
        }

        // (v2.0.28) استعادة المهام الخلفية بعد إغلاق التطبيق كلياً: أي عنصر downloading
        // له سجل مهمة خلفية يعاد ربطه بالمهمة الموجودة في محرك النظام (إن كانت حية) —
        // التقدم يكمل من حيث توقف حقيقي، بلا إعادة صفر ولا تكرار.
        if (Platform.OS !== 'web') {
          await (async () => {
            try {
              const existingTasks = await RNBackgroundDownloader.getExistingDownloadTasks();
              const taskById = new Map(existingTasks.map((task) => [task.id, task]));
              for (const item of merged.filter((entry) => entry.status === 'downloading')) {
                const rawRecord = await AsyncStorage.getItem(BG_TASK_KEY_PREFIX + item.id);
                if (!rawRecord) {
                  patchItem(item.id, { status: 'queued', progress: 0, bytesWritten: undefined, error: undefined });
                  enqueue(item.id);
                  continue;
                }
                const record = JSON.parse(rawRecord) as { title?: string; format?: string; destination?: string; directUrl?: string };
                const bgTask = taskById.get(item.id);
                if (bgTask) {
                  backgroundTasks.set(item.id, bgTask);
                  if (record.directUrl) directUrlRef.current.set(item.id, record.directUrl);
                  const itemTitle = record.title ?? item.title;
                  const itemFormat = record.format ?? item.format;
                  let recoveredFinalizing = false;
                  const finishRecoveredTask = async (location: string) => {
                    if (recoveredFinalizing) return;
                    recoveredFinalizing = true;
                    try {
                      const base = await baseDownloadDir();
                      if (!base) throw new Error('تعذر الوصول إلى مجلد التنزيلات.');
                      const typeDir = await ensureTypeDir(base, item.type);
                      const finalName = await uniqueFilename(typeDir || base, safeFilename(itemTitle, itemFormat));
                      const finalPath = `${typeDir || base}${finalName}`;
                      try {
                        await FileSystem.moveAsync({ from: location, to: finalPath });
                      } catch {
                        await FileSystem.copyAsync({ from: location, to: finalPath });
                        await FileSystem.deleteAsync(location, { idempotent: true });
                      }
                      const stat = await FileSystem.getInfoAsync(finalPath).catch(() => null);
                      const size = stat && 'size' in stat && typeof stat.size === 'number' ? stat.size : undefined;
                      const deviceSaved = await mirrorToDeviceDownloads(finalPath, finalName, item.type, downloadDirRef.current).catch(() => false);
                      if (!deviceSaved) setDeviceSaveNeedsFolder(true);
                      await patchItem(item.id, {
                        status: 'completed',
                        progress: 1,
                        bytesWritten: size,
                        totalBytes: size,
                        fileUri: finalPath,
                        title: itemTitle,
                        format: itemFormat,
                        deviceSaved: deviceSaved || undefined,
                        error: undefined,
                      });
                      void upsertHistoryEntry(historyEntryOf({ ...item, title: itemTitle, format: itemFormat, status: 'completed', progress: 1, bytesWritten: size, totalBytes: size, fileUri: finalPath }));
                      await AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + item.id).catch(() => undefined);
                      await AsyncStorage.removeItem(RESUME_KEY_PREFIX + item.id).catch(() => undefined);
                      removeForegroundDownload(item.id);
                    } catch {
                      await patchItem(item.id, { status: 'failed', error: 'اكتمل التنزيل لكن تعذر حفظ الملف في مجلد الوسائط.' });
                    } finally {
                      backgroundTasks.delete(item.id);
                      cancelBackgroundTasks.get(item.id)?.();
                      cancelBackgroundTasks.delete(item.id);
                      activeIdsRef.current.delete(item.id);
                      removeForegroundDownload(item.id);
                      pumpRef.current();
                    }
                  };
                  const failRecoveredTask = () => {
                    backgroundTasks.delete(item.id);
                    cancelBackgroundTasks.get(item.id)?.();
                    cancelBackgroundTasks.delete(item.id);
                    void AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + item.id);
                    void patchItem(item.id, { status: 'paused', error: 'توقف التنزيل في الخلفية — اضغط للاستئناف.' });
                    removeForegroundDownload(item.id);
                    activeIdsRef.current.delete(item.id);
                    pumpRef.current();
                  };
                  bgTask
                    .progress(({ bytesDownloaded, bytesTotal }) => {
                      const expected = bytesTotal > 0 ? bytesTotal : item.totalBytes ?? 0;
                      const ratio = expected > 0
                        ? Math.min(Math.max(bytesDownloaded / expected, 0.001), 0.999)
                        : 0.001;
                      patchItem(item.id, {
                        progress: ratio,
                        bytesWritten: bytesDownloaded,
                        totalBytes: expected > 0 ? expected : undefined,
                      });
                      updateForegroundDownload({ ...item, title: itemTitle }, record.destination ?? bgTask.destination ?? '', expected, false);
                    })
                    .done(({ location }) => { void finishRecoveredTask(location); })
                    .error(() => failRecoveredTask());
                  if (bgTask.state === 'DONE') {
                    const destination = record.destination ?? bgTask.destination;
                    if (destination) void finishRecoveredTask(destination);
                    else failRecoveredTask();
                  } else if (bgTask.state === 'FAILED' || bgTask.state === 'STOPPED') {
                    failRecoveredTask();
                  } else if (bgTask.state === 'PAUSED') {
                    await patchItem(item.id, { status: 'paused', title: itemTitle, format: itemFormat });
                    updateForegroundDownload({ ...item, title: itemTitle }, record.destination ?? bgTask.destination ?? '', item.totalBytes ?? 0, true);
                  } else {
                    activeIdsRef.current.add(item.id);
                    await patchItem(item.id, { status: 'downloading', title: itemTitle, format: itemFormat });
                    upsertForegroundDownload({ ...item, title: itemTitle }, record.destination ?? bgTask.destination ?? '', item.totalBytes ?? 0, false);
                  }
                } else {
                  // المهمة اختفت مع إغلاق النظام؛ لا ننشئ مهمة مكررة تلقائياً.
                  // نحفظ الرابط النهائي إن توفر ليبدأ زر الاستئناف من المصدر المعروف.
                  const destination = record.destination;
                  if (destination) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
                  if (record.directUrl) {
                    directUrlRef.current.set(item.id, record.directUrl);
                    await patchItem(item.id, {
                      url: record.directUrl,
                      resolvedUrl: true,
                      title: record.title ?? item.title,
                      format: record.format ?? item.format,
                      status: 'paused',
                      progress: 0,
                      bytesWritten: undefined,
                      error: undefined,
                    });
                  } else {
                    await patchItem(item.id, { status: 'paused', progress: 0, bytesWritten: undefined, error: undefined });
                  }
                  await AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + item.id).catch(() => undefined);
                }
              }
            } catch {
              // لا نعيد تشغيل التنزيل تلقائياً عند تعذر التحقق من حالة المحرك تفادياً للتكرار.
              for (const item of merged.filter((entry) => entry.status === 'downloading' && !backgroundTasks.has(entry.id))) {
                await patchItem(item.id, { status: 'paused', error: 'تعذر التحقق من التنزيل السابق — اضغط للاستئناف.' });
              }
            }
          })();
        } else {
          setDownloadsRestored(true);
        }
      })
      .then(async () => {
        // بعد إعادة تثبيت التطبيق يبقى السجل في الذاكرة فقط، والملفات موجودة على الجهاز.
        // نعيد تسجيل ما لا يعرفه التطبيق حتى لا تختفي مكتبته من المستخدم.
        if (!cancelled) {
          const root = FileSystem.documentDirectory;
          const base = (await baseDownloadDir()) ?? root;
          if (root && base) {
            const dirs = [base, `${root}.vault/`];
            if (await hasStorageAccess()) dirs.unshift(PUBLIC_DOWNLOAD_DIR);
            const known = new Set(itemsRef.current.map((item) => item.fileUri));
            const adopted: DownloadItem[] = [];
            for (const dir of dirs) {
              for (const filename of await orphanFilesIn(dir)) {
                const uri = `${dir}${filename}`;
                if (known.has(uri)) continue;
                const type = mediaTypeOf(filename);
                if (!type) continue;
                const stat = await FileSystem.getInfoAsync(uri);
                const size = 'size' in stat && typeof stat.size === 'number' ? stat.size : undefined;
                const createdAt = 'modificationTime' in stat && typeof stat.modificationTime === 'number'
                  ? stat.modificationTime * 1000
                  : Date.now();
                adopted.push({
                  id: `restored-${uri}`,
                  url: uri,
                  title: filename.replace(/\.[^.]+$/, ''),
                  type,
                  format: filename.split('.').pop()?.toLowerCase() ?? 'mp4',
                  quality: 'مستعاد من الجهاز',
                  status: 'completed',
                  progress: 1,
                  bytesWritten: size,
                  totalBytes: size,
                  fileUri: uri,
                  inVault: dir.includes('/.vault/'),
                  resolvedUrl: true,
                  createdAt,
                });
              }
            }
            if (adopted.length > 0) {
              commit((current) => [...adopted, ...current].sort((a, b) => b.createdAt - a.createdAt));
            }
          }
        }
      })
      .then(() => {
        if (!cancelled) {
          setDownloadsRestored(true);
          void purgeExpiredTrash();
        }
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

  /** يجلب حجم الملف لجودة/معدل محدد عبر طلب استخراج حقيقي ثم ترويسة الحجم. */
  const probeFileSize = useCallback(async (input: { url: string; type: MediaType; format: string }) => {
    try {
      if (!/^https?:\/\//i.test(input.url)) return null;
      if (input.type === 'image') {
        const info = await fetchRemoteFileInfo(input.url);
        return info.length ?? null;
      }
      const options = requestOptionsFor(input.type, input.format);
      const [mediaUrl] = await resolveMediaUrls(input.url, options);
      const info = await fetchRemoteFileInfo(mediaUrl);
      return info.length ?? null;
    } catch {
      return null;
    }
  }, []);

  /** تنزيل ذكي: يستدعي خدمة الاستخراج مسبقاً؛ إن كان الرابط كاروسيل صور تُنشأ مهمة لكل صورة. يوتيوب يجلب اسمه الحقيقي فوراً. */
  const addSmartDownload = useCallback(async (input: { url: string; title?: string; type: MediaType; format: string; quality: string }) => {
    let title = input.title;
    if ((!title || /^(watch|shorts|\d+)$/i.test(title)) && isYoutubeUrl(input.url)) {
      const realTitle = await fetchYoutubeTitle(input.url);
      if (realTitle) title = realTitle;
    }
    let mediaUrls: string[] = [input.url];
    let carousel = false;
    try {
      const resolved = await resolveMediaUrls(input.url);
      if (resolved.length > 1) {
        mediaUrls = resolved;
        carousel = true;
      }
    } catch {
      // تعذر التحليل المسبق — تُضاف المهمة كالمعتاد ويعرض الخطأ داخلها عند التنفيذ.
    }
    if (!carousel) {
      await addDownload({
        url: mediaUrls[0],
        title: title ?? 'ملف من الإنترنت',
        type: input.type,
        format: input.format,
        quality: input.quality,
        requestOptions: requestOptionsFor(input.type, input.format),
      });
      return 1;
    }
    const now = Date.now();
    const created: DownloadItem[] = mediaUrls.map((mediaUrl, index) => ({
      id: createId(),
      url: mediaUrl,
      title: `صورة ${index + 1} من ${mediaUrls.length}`,
      type: 'image' as MediaType,
      format: 'jpg',
      quality: 'كاروسيل الصور',
      status: 'queued' as const,
      progress: 0,
      createdAt: now - index,
    }));
    commit((current) => [...created, ...current]);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    for (const entry of created) enqueue(entry.id);
    return created.length;
  }, [addDownload, commit, enqueue]);

  /** يضيف الصور المختارة من شبكة الكاروسيل كمهام تنزيل جاهزة (روابط مباشرة بلا تحليل جديد). */
  const addCarouselImages = useCallback(async (input: { urls: string[]; title?: string }) => {
    const now = Date.now();
    const created: DownloadItem[] = input.urls.map((mediaUrl, index) => ({
      id: createId(),
      url: mediaUrl,
      title: input.title ? `${input.title} ${index + 1}` : `صورة ${index + 1} من ${input.urls.length}`,
      type: 'image' as MediaType,
      format: 'jpg',
      quality: 'كاروسيل الصور',
      status: 'queued' as const,
      progress: 0,
      createdAt: now - index,
    }));
    commit((current) => [...created, ...current]);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    for (const entry of created) enqueue(entry.id);
    return created.length;
  }, [commit, enqueue]);

  /** يحاول جلب رابط فيديو حقيقي لمنشور مختلط: فيديو مدمج داخل الكاروسيل (إنستغرام/فيسبوك) أو نسخة العرض المولّدة (تيك توك). */
  const resolveCarouselVideo = useCallback(async (sourceUrl: string, videoQuality: string): Promise<string | null> => {
    if (!/^https?:\/\//i.test(sourceUrl)) return null;
    // 1) خدمة الاستخراج الأساسية: قد تعيد فيديو حقيقياً (tunnel) أو عنصر فيديو داخل قائمة الكاروسيل.
    try {
      const response = await fetch(EXTRACTOR_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url: sourceUrl, videoQuality }),
      });
      if (response.ok) {
        const data = await response.json();
        if ((data?.status === 'tunnel' || data?.status === 'stream') && typeof data?.url === 'string' && data.url) return data.url as string;
        if (Array.isArray(data?.picker)) {
          const videoEntry = data.picker.find((entry: { type?: unknown; url?: unknown }) => entry?.type === 'video' && typeof entry?.url === 'string' && entry.url);
          if (videoEntry) return videoEntry.url as string;
        }
      }
    } catch {
      // ننتقل للمحاولة الاحتياطية
    }
    // 2) خدمة احتياطية لنسخة العرض المولّدة (قابلة للتبديل عبر متغير البيئة).
    try {
      const fallbackBase = process.env.EXPO_PUBLIC_SLIDESHOW_FALLBACK_URL?.trim() || 'https://tikwm.com/api/';
      const response = await fetch(`${fallbackBase}?url=${encodeURIComponent(sourceUrl)}&hd=1`);
      if (response.ok) {
        const payload = await response.json();
        const play = payload?.data?.play;
        const duration = Number(payload?.data?.duration ?? 0);
        if (typeof play === 'string' && play && duration > 0) {
          // نسخة العرض الحقيقية لها مدة — نرفض فقط ما ثبت أنه مسار صوتي.
          const head = await fetch(play, { method: 'HEAD' }).catch(() => null);
          const mime = head?.headers?.get('content-type') ?? '';
          if (!mime.startsWith('audio/')) return play;
        }
      }
    } catch {
      // لا نسخة فيديو متاحة لهذا المنشور
    }
    return null;
  }, []);

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
    directUrlRef.current.delete(id);
    patchItem(id, { status: 'queued', progress: 0, error: undefined });
    enqueue(id);
  }, [patchItem, enqueue]);

  /** إيقاف مؤقت لتنزيل جارٍ أو منتظر مع حفظ الجزء المحمّل لاستئنافه لاحقاً. */
  const pauseDownload = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === 'completed' || item.status === 'failed' || item.status === 'paused') return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (item.status === 'queued') {
      // لم يبدأ بعد — نخرجه من الطابور ونضعه في حالة إيقاف.
      queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
      patchItem(id, { status: 'paused', error: undefined });
      return;
    }
    const backgroundTask = backgroundTasks.get(id);
    if (backgroundTask) {
      pauseRequestedRef.current.add(id);
      try {
        await backgroundTask.pause();
        patchItem(id, { status: 'paused', error: undefined });
        void upsertHistoryEntry(historyEntryOf({ ...item, status: 'paused' }));
        const raw = await AsyncStorage.getItem(BG_TASK_KEY_PREFIX + id).catch(() => null);
        const saved = raw ? JSON.parse(raw) as { destination?: string } : {};
        updateForegroundDownload(item, saved.destination ?? backgroundTask.destination ?? '', item.totalBytes ?? 0, true);
        activeIdsRef.current.delete(id);
        pumpRef.current();
      } catch {
        pauseRequestedRef.current.delete(id);
        // إذا رفض المحرك الإيقاف، لا نغيّر حالة المهمة.
      }
      return;
    }
    const resumable = resumablesRef.current.get(id);
    if (!resumable) return;
    pauseRequestedRef.current.add(id);
    try {
      // (v2.0.15) بعض الأجهزة لا تعيد حالة الاستئناف من الوحدة الأصلية؛
      // كتابة قيمة فارغة كانت تُسقط التطبيق — نتخطّىها بدل ذلك.
      const state = (await resumable.pauseAsync().catch(() => undefined)) as { fileUri?: string } | undefined;
      // (v2.0.12) نحفظ الرابط المباشر مع الحالة — الاستئناف سيستخدمه مباشرة بلا استخراج جديد.
      const directUrl = directUrlRef.current.get(id);
      if (state?.fileUri) {
        await AsyncStorage.setItem(
          RESUME_KEY_PREFIX + id,
          JSON.stringify(directUrl ? { ...state, __directUrl: directUrl } : state),
        );
      }
      patchItem(id, { status: 'paused', error: undefined });
      void upsertHistoryEntry(historyEntryOf({ ...item, status: 'paused' }));
    } catch {
      pauseRequestedRef.current.delete(id);
      // تعذر الإيقاف — يكمل التنزيل تلقائياً.
    }
  }, [patchItem]);

  /** استئناف تنزيل متوقف من نفس النقطة (أو من الصفر إن رفض الخادم الاستئناف). */
  const resumeDownload = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'paused') return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    patchItem(id, { status: 'queued', progress: item.progress, error: undefined });
    enqueue(id);
  }, [patchItem, enqueue]);

  /** الحذف العادي ينقل الملف إلى سلة المحذوفات لمدة 30 يوماً. */
  const removeDownload = useCallback(async (id: string) => {
    queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
    const backgroundTask = backgroundTasks.get(id);
    if (backgroundTask) {
      cancelledBackgroundIdsRef.current.add(id);
      cancelBackgroundTasks.get(id)?.();
      cancelBackgroundTasks.delete(id);
      backgroundTasks.delete(id);
      try {
        await backgroundTask.stop();
      } catch {
        // قد يكون المحرك أنهى المهمة بين الفحص والإلغاء.
      }
      const raw = await AsyncStorage.getItem(BG_TASK_KEY_PREFIX + id).catch(() => null);
      const saved = raw ? JSON.parse(raw) as { destination?: string } : {};
      if (saved.destination) await FileSystem.deleteAsync(saved.destination, { idempotent: true }).catch(() => undefined);
      await AsyncStorage.removeItem(BG_TASK_KEY_PREFIX + id).catch(() => undefined);
      removeForegroundDownload(id);
      activeIdsRef.current.delete(id);
      pumpRef.current();
    }
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
    directUrlRef.current.delete(id);
    patchItem(id, { deletedAt: Date.now(), status: 'completed', error: undefined, inVault: false });
  }, [patchItem]);

  const handleForegroundAction = useCallback((action: { id: string; action: string }) => {
    if (action.action === 'pause') void pauseDownload(action.id);
    else if (action.action === 'resume') void resumeDownload(action.id);
    else if (action.action === 'cancel') void removeDownload(action.id);
  }, [pauseDownload, resumeDownload, removeDownload]);

  useEffect(() => {
    foregroundActionHandlerRef.current = handleForegroundAction;
  }, [handleForegroundAction]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !foregroundDownloadNativeModule) return;
    const deliver = (action: { id: string; action: string }) => {
      if (downloadsRestoredRef.current) foregroundActionHandlerRef.current(action);
      else pendingForegroundActionsRef.current.push(action);
    };
    const emitter = new NativeEventEmitter(foregroundDownloadNativeModule);
    const subscription = emitter.addListener('DownloadForegroundAction', deliver);
    if (!pendingActionsConsumedRef.current) {
      pendingActionsConsumedRef.current = true;
      void foregroundDownloadBridge?.consumePendingActions()
        .then((actions) => actions.forEach(deliver))
        .catch(() => undefined);
    }
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    downloadsRestoredRef.current = downloadsRestored;
    if (!downloadsRestored) return;
    const pending = pendingForegroundActionsRef.current.splice(0);
    for (const action of pending) foregroundActionHandlerRef.current(action);
  }, [downloadsRestored]);

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
    void deleteHistoryEntry(id);
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
    for (const item of trashed) void deleteHistoryEntry(item.id);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [commit]);


  const clearCompleted = useCallback(async () => {
    commit((current) => current.filter((item) => item.status !== 'completed'));
  }, [commit]);

  const openFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed' || !item.fileUri) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await openWithViewer(item);
  }, []);

  const shareFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed' || !item.fileUri) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await shareDownloadedFile(item);
    if (!result.ok && result.message) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      throw new Error(result.message);
    }
  }, []);

  const moveToVault = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    // اخفاء فعلي: نقل الملف الى مجلد خاص مخفي (.vault) مع .nomedia لاخفائه من ماسح الوسائط
    if (item?.fileUri && !/^https?:\/\//i.test(item.fileUri) && Platform.OS !== 'web') {
      try {
        const baseDirectory = await baseDownloadDir();
        if (baseDirectory) {
          const filename = item.fileUri.split('/').pop() ?? '';
          const vaultDir = `${baseDirectory}.vault/`;
          const vaultMarker = `${vaultDir}.nomedia`;
          const dirInfo = await FileSystem.getInfoAsync(vaultDir);
          if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(vaultDir, { intermediates: true });
          const markerInfo = await FileSystem.getInfoAsync(vaultMarker);
          if (!markerInfo.exists) await FileSystem.writeAsStringAsync(vaultMarker, '', { encoding: FileSystem.EncodingType.UTF8 });
          const movedUri = `${vaultDir}${filename}`;
          const existing = await FileSystem.getInfoAsync(movedUri);
          if (existing.exists) await FileSystem.deleteAsync(movedUri, { idempotent: true });
          await FileSystem.moveAsync({ from: item.fileUri, to: movedUri });
          patchItem(id, { inVault: true, fileUri: movedUri });
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          return;
        }
      } catch {
        // فشل النقل الفعلي — نكتفي بالإخفاء المنطقي حتى لا يفقد المستخدم الملف.
      }
    }
    patchItem(id, { inVault: true });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [patchItem]);

  const removeFromVault = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    // الاصدار من الخزنة: اعادة الملف الى مجلد التطبيق الظاهر واضافته للمعرض.
    if (item?.fileUri?.includes('/.vault/') && Platform.OS !== 'web') {
      try {
        const baseDirectory = (await baseDownloadDir()) ?? FileSystem.documentDirectory;
        const filename = item.fileUri.split('/').pop() ?? '';
        const restoredUri = `${baseDirectory ?? ''}${filename}`;
        const existing = await FileSystem.getInfoAsync(restoredUri);
        if (existing.exists) await FileSystem.deleteAsync(restoredUri, { idempotent: true });
        await FileSystem.moveAsync({ from: item.fileUri, to: restoredUri });
        if (item.type === 'image' || item.type === 'video') {
          try {
            await MediaLibrary.saveToLibraryAsync(restoredUri);
          } catch {
            // فشل الإضافة للمعرض غير حرج — الملف يعود ظاهراً في مجلد التطبيق على أي حال.
          }
        }
        patchItem(id, { inVault: false, fileUri: restoredUri });
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      } catch {
        // فشل الإرجاع الفعلي — نكمل بالإخفاء المنطقي.
      }
    }
    patchItem(id, { inVault: false });
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [patchItem]);

  /**
   * يحوّل فيديو مكتمل إلى ملف صوتي عبر FFmpeg ثم يضيف الناتج كصف جديد مكتمل في القائمة.
   * الملف الصوتي يُحفظ ويظهر بكل أزرار التشغيل والمشاركة والخزنة كأي ملف آخر.
   */
  const convertVideoToAudio = useCallback(async (id: string, format: 'mp3' | 'm4a', onProgress?: (message: string) => void) => {
    const source = itemsRef.current.find((candidate) => candidate.id === id);
    if (!source || source.status !== 'completed' || !source.fileUri) return false;
    if (Platform.OS === 'web') return false;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const result = await extractAudioFromVideo({
      videoUri: source.fileUri,
      title: source.title.replace(/\.[^.]+$/, ''),
      format,
      onProgress,
    });
    if (!result.ok || !result.fileUri) return false;
    // نضيف الملف الصوتي كصف جديد مكتمل مباشرة (بلا طابور — التحويل اكتمل بالفعل).
    const audioItem: DownloadItem = {
      id: createId(),
      url: result.fileUri,
      title: `${source.title.replace(/\.[^.]+$/, '')} — صوت`,
      type: 'audio',
      format,
      quality: 'محوّل من الفيديو',
      status: 'completed',
      progress: 1,
      bytesWritten: result.size,
      totalBytes: result.size,
      fileUri: result.fileUri,
      createdAt: Date.now(),
    };
    commit((current) => [audioItem, ...current]);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return true;
  }, [commit]);

  const setQueueOptions = useCallback((options: { maxTasks: MaxTasks; maxTasksCellular: MaxTasks; allowMobileData: boolean }) => {
    maxTasksRef.current = options.maxTasks;
    maxTasksCellularRef.current = options.maxTasksCellular;
    allowMobileDataRef.current = options.allowMobileData;
    pumpRef.current();
  }, []);

  // مرجع دالة الحفظ الدائم — يسمح باستدعائها من runJob المعرّف قبلها بأمان.
  const setDownloadDirRef = useRef<(uri: string | null) => Promise<void>>(async () => undefined);

  /**
   * (v2.0.8) تهيئة التخزين عند فتح التطبيق — تُستدعى مرة واحدة:
   * 1) جذر محفوظ؟ نتحقق من صحته بقراءة تجريبية (بديل موثوق عن getUriInfoAsync
   *    غير المتوفرة في نسخة expo-file-system لدينا) ثم نجهّز النظام فوراً.
   * 2) لا جذر محفوظ أو الصلاحية انسحبت؟ لا نطلب شيئاً هنا — الطلب يحدث تلقائياً
   *    عند أول تنزيل/تفعيل فقط، مرة واحدة، ثم يُحفظ بشكل دائم.
   * 3) نجهّز «Download Max» ومجلدات الأنواع الثلاثة داخله بلا إنشاء مكرر.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await AsyncStorage.getItem(DOWNLOAD_DIR_KEY).catch(() => null);
      if (cancelled || !stored) return;
      // تحقق حي: القراءة التجريبية تكشف انسحاب الصلاحية أو حذف المجلد.
      const alive = await FileSystem.StorageAccessFramework.readDirectoryAsync(stored)
        .then(() => true)
        .catch(() => false);
      if (cancelled) return;
      if (alive) {
        setDownloadDirState(stored);
        downloadDirRef.current = stored;
        // تجهيز المسار الأساسي مسبقاً (ذاكرة + مجلدات الأنواع) بلا أي طلب جديد.
        // (v2.0.10) روابط المجلدات محفوظة دائماً وتُعاد استخدامها مباشرة — لا بحث ولا إنشاء متكرر.
        // (v2.0.11) تحقق فعلي بعد التجهيز: أي مجلد نوع مفقود/ميت يُعاد بناؤه فوراً
        // حتى لا يجد المستخدم مجلدات ناقصة أو فارغة عند أول فحص من مدير الملفات.
        try {
          const appRoot = await safAppRoot(stored);
          for (const type of ['video', 'audio', 'image'] as MediaType[]) {
            const dir = await safSubfolder(appRoot, subfolderFor(type));
            if (dir === appRoot || !(await isSafDirAlive(dir))) {
              // الرابط المحفوظ ميت أو فشل — نمسح كاش النوع ليعاد إنشاؤه في المحاولة القادمة.
              safTypeFoldersCache?.delete(subfolderFor(type));
              await FileSystem.StorageAccessFramework.makeDirectoryAsync(appRoot, subfolderFor(type))
                .then(async (fresh) => {
                  safTypeFoldersCache?.set(subfolderFor(type), fresh);
                  await persistSafTypeFolders(appRoot, safTypeFoldersCache!);
                })
                .catch(() => undefined);
            }
          }
        } catch { /* أول تنزيل سيعيد المحاولة بنفسه */ }
      } else {
        // الصلاحية انسحبت — نمسح الاختيار الميت حتى يُطلب الاختيار من جديد مرة واحدة.
        await setDownloadDirRef.current(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * (7) يقرأ ملفات الوسائط الموجودة في مجلد التنزيلات على الجهاز ويسجّلها في القائمة.
   * قراءة فقط: لا يُحذف ولا يُعدَّل أي ملف. يُستدعى بعد منح صلاحية الوصول لجميع الملفات.
   */
  const refreshFromDevice = useCallback(async () => {
    const known = new Set(itemsRef.current.map((item) => item.fileUri));
    // نفحص مجلد التنزيلات في الجهاز إن كانت الصلاحية متاحة، ومجلد التطبيق دائماً.
    const roots: string[] = [await baseDownloadDir()].filter(Boolean) as string[];
    if (await hasStorageAccess()) {
      const publicRoot = await publicDownloadRoot();
      if (publicRoot) roots.unshift(publicRoot);
      // (v2.0.17) هيكل Snaptube: DownloadMax/download/DownloadMax Video|Music|Image
      const snaptubeRoot = `${publicStorageRoot()}${SNAPTUBE_DOWNLOAD_DIR}/`;
      const snaptubeInfo = await FileSystem.getInfoAsync(snaptubeRoot).catch(() => null);
      if (snaptubeInfo?.exists) roots.unshift(snaptubeRoot);
    }
    const uris: string[] = [];
    for (const root of roots) uris.push(...(await mediaFilesIn(root)));
    const adopted: DownloadItem[] = [];
    for (const uri of uris) {
      if (known.has(uri)) continue;
      const filename = uri.split('/').pop() ?? '';
      const type = mediaTypeOf(filename);
      if (!type) continue;
      const stat = await FileSystem.getInfoAsync(uri).catch(() => null);
      const size = stat && 'size' in stat && typeof stat.size === 'number' ? stat.size : undefined;
      const createdAt = stat && 'modificationTime' in stat && typeof stat.modificationTime === 'number'
        ? stat.modificationTime * 1000
        : Date.now();
      adopted.push({
        id: `device-${uri}`,
        url: uri,
        title: filename.replace(/\.[^.]+$/, ''),
        type,
        format: filename.split('.').pop()?.toLowerCase() ?? 'mp4',
        quality: 'من تخزين الجهاز',
        status: 'completed',
        progress: 1,
        bytesWritten: size,
        totalBytes: size,
        fileUri: uri,
        resolvedUrl: true,
        createdAt,
      });
    }
    if (adopted.length > 0) {
      commit((current) => [...adopted, ...current].sort((a, b) => b.createdAt - a.createdAt));
    }
    return adopted.length;
  }, [commit]);

  const setDownloadDir = useCallback(async (uri: string | null) => {
    setDownloadDirState(uri);
    downloadDirRef.current = uri;
    if (uri) {
      await AsyncStorage.setItem(DOWNLOAD_DIR_KEY, uri).catch(() => undefined);
    } else {
      await AsyncStorage.removeItem(DOWNLOAD_DIR_KEY).catch(() => undefined);
    }
    // (v2.0.8) نصفّر ذاكرة مجلد «Download Max» عند تغيير الجذر حتى لا يشير لمسار قديم.
    // (إصلاح v2.0.10) نصفّرها أيضاً عند مسح الاختيار (null) وليس فقط عند اختيار جديد،
    // وإلا بقي الكاش يشير لمجلد جذر لم يعد مصرّحاً بالوصول إليه.
    setSafAppRootCache(null);
    clearSafTypeFolderCaches();
  }, []);
  // نربط المرجع بعد تعريف الدالة حتى يعمل استدعاؤها من initStorage وrunJob.
  setDownloadDirRef.current = setDownloadDir;

  /**
   * «نسخ إلى مجلد التنزيلات»: ينسخ الملف إلى مجلد جهازك عبر منتقي المجلدات
   * الرسمي (SAF) — يختاره المستخدم مرة واحدة ثم تكفي ضغطة واحدة لكل ملف.
   */
  const copyToDeviceDownloads = useCallback(async (item: DownloadItem) => {
    const source = item.fileUri;
    if (!source || !source.startsWith('file://')) {
      return { ok: false, message: 'هذا الملف ما زال قيد التحميل' };
    }
    const filename = source.split('/').pop() ?? 'file';
    if (await mirrorToDeviceDownloads(source, filename, item.type, downloadDirRef.current)) {
      return { ok: true, message: 'نُسخ إلى مجلد التنزيلات في جهازك ✓' };
    }
    // الحفظ التلقائي غير متاح: نطلب منه اختيار مجلده مرة واحدة ثم ننسخ دائماً
    // في «المختار / Download Max / نوع الوسيط» — نفس المسار الأساسي (v2.0.8).
    const picked = await pickDeviceDirectory();
    if (!picked) return { ok: false, message: 'لم يتم اختيار مجلد — حاول مرة أخرى' };
    if (picked !== downloadDirRef.current) await setDownloadDir(picked);
    const appRoot = await safAppRoot(picked);
    const typeDir = await safSubfolder(appRoot, subfolderFor(item.type));
    if (await saveFileToSafDirectory(source, filename, mimeFor(filename), typeDir)) {
      return { ok: true, message: 'نُسخ إلى مجلد التنزيلات في جهازك ✓' };
    }
    // (v2.0.21) لا نُرجع رسالة الفحص الخام (توست إنجليزي مخيف) — سلسلة الأسباب أو رسالة ودّية.
    const summary = deviceSaveErrorSummary();
    return { ok: false, message: summary
      ? `تعذّر النسخ إلى الجهاز — ${summary}`
      : 'تعذّر النسخ — امنح صلاحية «جميع الملفات» من البانر أعلى الشاشة' };
  }, [setDownloadDir]);

  /**
   * (v2.0.20) نسخ كل ملف مكتمل بلا نسخة جهاز إلى المجلد العام عبر السلسلة المضمونة
   * (All Files → SAF المختار → ألبوم MediaStore → المسار العام). يعيد عدد الملفات
   * المنقولة، وإن فشلت السلسلة كلياً مع وجود ملفات معلقة يرفع راية اختيار المجلد.
   */
  const syncPendingToDevice = useCallback(async (): Promise<number> => {
    if (Platform.OS === 'web') return 0;
    let safDirNow = downloadDirRef.current;
    if (!safDirNow) {
      safDirNow = (await AsyncStorage.getItem(DOWNLOAD_DIR_KEY).catch(() => null)) ?? null;
      if (safDirNow) downloadDirRef.current = safDirNow;
    }
    const pending = itemsRef.current.filter(
      (entry) => entry.status === 'completed' && !!entry.fileUri && !entry.deviceSaved && !entry.inVault && !entry.deletedAt && entry.fileUri.startsWith('file://'),
    );
    let moved = 0;
    for (const entry of pending) {
      const source = entry.fileUri;
      if (!source) continue;
      const filename = source.split('/').pop() ?? 'file';
      const ok = await mirrorToDeviceDownloads(source, filename, entry.type, safDirNow).catch((error) => {
        noteDeviceSaveError('مزامنة الجهاز', error);
        return false;
      });
      if (ok) {
        patchItem(entry.id, { error: undefined, deviceSaved: true });
        moved += 1;
      } else if (deviceSaveErrorSummary()) {
        // (v2.0.23) بدل الصمت: سلسلة الأسباب الكاملة — وتُمسح تلقائياً عند نجاح النسخ لاحقاً.
        patchItem(entry.id, { error: `لم يُحفظ في مجلد الجهاز — ${deviceSaveErrorSummary()}` });
      }
    }
    if (pending.length > 0 && moved === 0) setDeviceSaveNeedsFolder(true);
    return moved;
  }, [patchItem]);

  /**
   * (v2.0.22) يفتح منتقي مجلد الجهاز مرة واحدة (SAF الرسمي) ثم ينسخ فوراً كل ملف
   * بقي داخل التطبيق إلى «المختار / Download Max / النوع». يعيد النتيجة الحقيقية:
   * picked (اختار مجلداً؟) و moved (كم ملف نُسخ فعلاً) و failed (كم فشل) —
   * لا «تم» كاذبة بعد اليوم: اختيار المجلد وحده ليس نجاحاً.
   */
  const pickDeviceFolderNow = useCallback(async (): Promise<{ picked: boolean; moved: number; failed: number }> => {
    if (Platform.OS === 'web') return { picked: false, moved: 0, failed: 0 };
    const picked = await pickDeviceDirectory();
    if (!picked) return { picked: false, moved: 0, failed: 0 };
    if (picked !== downloadDirRef.current) await setDownloadDir(picked);
    const before = itemsRef.current.filter(
      (entry) => entry.status === 'completed' && !!entry.fileUri && !entry.deviceSaved && !entry.inVault && !entry.deletedAt && entry.fileUri.startsWith('file://'),
    ).length;
    const moved = await syncPendingToDevice();
    const failed = Math.max(before - moved, 0);
    if (moved > 0) setDeviceSaveNeedsFolder(false);
    return { picked: true, moved, failed };
  }, [setDownloadDir, syncPendingToDevice]);

  /**
   * تفعيل الحفظ التلقائي في مجلد التنزيلات الحقيقي بجهاز المستخدم — مرة واحدة فقط:
   * 1) إن سارت صلاحية «الوصول لجميع الملفات» نستخدم «Download/Download Max» بلا أي خطوة.
   * 2) وإلا نفتح منتقي المجلدات الرسمي مرة واحدة ونحفظ اختياره، وبعدها كل تنزيل
   *    جديد ينزل تلقائياً فيه. المستخدم لا يضغط «نسخ» أبداً بعد ذلك.
   */
  const enableDeviceAutoSave = useCallback(async (): Promise<{ ok: boolean; where: string | null; message: string }> => {
    const selected = downloadDirRef.current;
    if (selected) {
      const appRoot = await safAppRoot(selected);
      for (const type of ['video', 'audio', 'image'] as MediaType[]) {
        await safSubfolder(appRoot, subfolderFor(type));
      }
      return { ok: true, where: `${safUriDisplayName(selected) ?? selected} / ${APP_DIR_NAME}`, message: 'تم — كل تنزيل جديد سيُحفظ في مجلد Download Max تلقائياً ✓' };
    }
    if (await hasStorageAccess()) {
      const root = await publicDownloadRoot();
      if (root) {
        for (const type of ['video', 'audio', 'image'] as MediaType[]) {
          const dir = `${root}${subfolderFor(type)}/`;
          const info = await FileSystem.getInfoAsync(dir).catch(() => null);
          if (!info?.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
        }
        return { ok: true, where: root, message: 'كل تنزيل جديد يُحفظ تلقائياً في مجلد التنزيلات ✓' };
      }
    }
    const picked = await pickDeviceDirectory();
    if (!picked) return { ok: false, where: null, message: 'لم يتم اختيار مجلد — حاول مرة أخرى' };
    if (picked !== downloadDirRef.current) await setDownloadDir(picked);
    const appRoot = await safAppRoot(picked);
    for (const type of ['video', 'audio', 'image'] as MediaType[]) {
      await safSubfolder(appRoot, subfolderFor(type));
    }
    return { ok: true, where: `${safUriDisplayName(picked) ?? picked} / ${APP_DIR_NAME}`, message: 'تم — كل تنزيل جديد سيُحفظ في مجلد Download Max تلقائياً ✓' };
  }, [setDownloadDir]);

  /**
   * يضمن وجود مجلد التنزيل المحفوظ ومجلداته الفرعية قبل الحفظ (SAF الرسمي).
   * (v2.0.8) المسار: «المختار / Download Max / نوع الوسيط» — بحث قبل إنشاء (بلا تكرار).
   * يعيد مجلد النوع الصحيح أو null إذا لم يكن الإعداد جاهزاً.
   */
  const ensureDeviceTargetDir = useCallback(async (type: MediaType): Promise<string | null> => {
    const safDir = downloadDirRef.current;
    if (!safDir) return null;
    try {
      const appRoot = await safAppRoot(safDir);
      return await safSubfolder(appRoot, subfolderFor(type));
    } catch {
      return null;
    }
  }, [setDownloadDir]);

  const value = useMemo(() => ({
    items,
    activeCount: items.filter((item) => item.status === 'queued' || item.status === 'downloading').length,
    waitingForWifi,
    addDownload,
    addSmartDownload,
    addCarouselImages,
    resolveCarouselVideo,
    probeFileSize,
    pickDeviceFolderNow,
    deviceSaveNeedsFolder,
  addSharedFile,
  retryDownload,
  pauseDownload,
  resumeDownload,
  removeDownload,
  clearCompleted,
    openFile,
    shareFile,
    moveToVault,
    removeFromVault,
    setQueueOptions,
    downloadDir,
    setDownloadDir,
    refreshFromDevice,
    copyToDeviceDownloads,
    syncPendingToDevice,
    enableDeviceAutoSave,
    restoreFromTrash,
    deletePermanently,
    emptyTrash,
    convertVideoToAudio,
  }), [items, waitingForWifi, addDownload, addSmartDownload, addCarouselImages, resolveCarouselVideo, probeFileSize, addSharedFile, deviceSaveNeedsFolder, pickDeviceFolderNow,
    retryDownload,
    pauseDownload,
    resumeDownload,
    removeDownload,
    clearCompleted, openFile, shareFile, moveToVault, removeFromVault, setQueueOptions, downloadDir, setDownloadDir, refreshFromDevice, restoreFromTrash, deletePermanently, emptyTrash, convertVideoToAudio, copyToDeviceDownloads, syncPendingToDevice, enableDeviceAutoSave]);

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadProvider');
  return value;
}
