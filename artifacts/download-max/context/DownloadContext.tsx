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

// خدمة يوتيوب الاحتياطية: تشتغل عندما ترفض الخدمة الأساسية الفيديو (youtube.login ومشقاته).
// تعيد اسم الفيديو الحقيقي + رابط تنزيل نهائي بعد تجهيز الملف.
const YT_FALLBACK_BASE = 'https://loader.to/ajax/download.php';
const YT_FALLBACK_QUALITY: Record<string, string> = {
  '144': '144', '240': '240', '360': '360', '480': '480', '540': '540',
  '720': '720', '1080': '1080', '1440': '1440', '2160': '2160',
};
const YT_AUDIO_FORMATS: Record<string, string> = { mp3: 'mp3', m4a: 'm4a', wav: 'wav', opus: 'opus' };

/** هل الرابط رابط يوتيوب؟ (youtu.be أو youtube.com) */
export function isYoutubeUrl(url: string): boolean {
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

/** يستخرج معرف الفيديو من أي صيغة رابط يوتيوب، أو null. */
export function youtubeVideoId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{6,})/);
  return m?.[1] ?? null;
}

export type YoutubeFallbackResult = { url: string; title: string | null };

/**
 * يجهّز تنزيل يوتيوب عبر الخدمة الاحتياطية ويعيد الرابط النهائي مع اسم الفيديو الحقيقي.
 * format: 'video' مع جودة رقمية، أو 'audio' مع صيغة صوتية.
 */
export async function prepareYoutubeFallback(sourceUrl: string, options: { mode: 'video' | 'audio'; format?: string }): Promise<YoutubeFallbackResult> {
  const id = youtubeVideoId(sourceUrl);
  if (!id) throw new Error('تعذر قراءة معرف فيديو يوتيوب من الرابط.');
  const formatParam = options.mode === 'audio'
    ? (YT_AUDIO_FORMATS[options.format ?? 'mp3'] ?? 'mp3')
    : (YT_FALLBACK_QUALITY[options.format ?? '720'] ?? '720');
  const start = await fetch(`${YT_FALLBACK_BASE}?format=${formatParam}&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  if (!start.ok) throw new Error('تعذر بدء تجهيز الفيديو عبر الخدمة الاحتياطية.');
  const startData = await start.json();
  if (!startData?.success || !startData?.progress_url) throw new Error('رفضت الخدمة الاحتياطية هذا الفيديو.');
  const title: string | null = typeof startData?.info?.title === 'string' ? startData.info.title : null;
  const progressUrl: string = startData.progress_url;
  // نستفتس حتى يجهز الملف (عادة ثوانٍ).
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(progressUrl);
    if (!poll.ok) continue;
    const pollData = await poll.json();
    if (pollData?.success === 1 && typeof pollData?.download_url === 'string' && pollData.download_url) {
      return { url: pollData.download_url, title };
    }
  }
  throw new Error('انتهت مهلة تجهيز الفيديو — حاول مجدداً.');
}

/** يجلب اسم فيديو يوتيوب الحقيقي من oEmbed (بدون أي مفاتيح أو تسجيل دخول). */
export async function fetchYoutubeTitle(sourceUrl: string): Promise<string | null> {
  const id = youtubeVideoId(sourceUrl);
  if (!id) return null;
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.title === 'string' ? data.title : null;
  } catch {
    return null;
  }
}

/** خيارات طلب الاستخراج: جودة الفيديو أو صيغة/معدل الصوت. */
export type MediaRequestOptions =
  | { mode: 'video'; videoQuality?: string }
  | { mode: 'audio'; audioFormat?: string; audioBitrate?: string }
  | { mode: 'image' };

/** يبني خيارات طلب الاستخراج من نوع الوسائط والصيغة المختارة. */
export function requestOptionsFor(type: MediaType, format: string): MediaRequestOptions {
  if (type === 'audio') {
    // الصيغة بصيغة mp3-320 أو m4a-128
    const [audioFormat, audioBitrate] = format.split('-');
    return { mode: 'audio', audioFormat: audioFormat || 'mp3', audioBitrate: audioBitrate || '128' };
  }
  if (type === 'video') {
    // الجودة بصيغة mp4-720 أو webm-480
    const quality = format.split('-')[1];
    return { mode: 'video', videoQuality: quality || '1080' };
  }
  return { mode: 'image' };
}

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
  /** خيارات طلب الاستخراج (جودة الفيديو أو معدل الصوت المطلوبة). */
  requestOptions?: MediaRequestOptions;
  /** الرابط محفوظ مباشر بالفعل (نتيجة استخراج سابقة) — يُنزَّل كما هو دون إعادة استخراج. */
  resolvedUrl?: boolean;
  createdAt: number;
};

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

/**
 * يستخرج روابط الوسائط المباشرة من رابط الصفحة.
 * يدعم كاروسيل الصور (تيك توك/إنستجرام/فيسبوك) عبر حقل picker الذي يعيد قائمة بكل الصور.
 * ويمرر جودة الفيديو أو صيغة/معدل الصوت المطلوبة لخدمة الاستخراج.
 */
async function resolveMediaUrls(sourceUrl: string, options?: MediaRequestOptions): Promise<string[]> {
  if (looksLikeDirectMedia(sourceUrl)) return [sourceUrl];
  const body: Record<string, unknown> = { url: sourceUrl };
  if (options?.mode === 'audio') {
    body.downloadMode = 'audio';
    if (options.audioFormat) body.audioFormat = options.audioFormat;
    if (options.audioBitrate) body.audioBitrate = options.audioBitrate;
  } else if (options?.mode === 'video' && options.videoQuality) {
    body.videoQuality = options.videoQuality;
  }
  const response = await fetch(EXTRACTOR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // نعرض سبب الخطأ الحقيقي من الخدمة بدل رسالة عامة (رابط ناقص / خاص / غير مدعوم...).
    let reason = '';
    try {
      const errData = await response.json();
      const code: string = errData?.error?.code ?? '';
      if (code.includes('youtube.login')) reason = 'فيديوهات يوتيوب المقيدة تحتاج معالجة إضافية — أعد المحاولة أو استخدم جودة أخرى.';
      else if (code.includes('fetch.fail')) reason = 'الرابط غير مكتمل أو المحتوى غير متاح — تأكد من نسخ الرابط كاملاً من زر المشاركة.';
      else if (code.includes('content.post.private') || code.includes('private')) reason = 'المحتوى خاص — لا يمكن تنزيله.';
      else if (code.includes('content.post.unavailable') || code.includes('unavailable')) reason = 'المنشور محذوف أو غير متاح.';
      else if (code.includes('content.video.age') || code.includes('age')) reason = 'محتوى مقيد بالعمر — لا يمكن تنزيله.';
      else if (code.includes('content.video.region') || code.includes('region')) reason = 'المحتوى محجوب في منطقتك.';
      else if (code.includes('auth')) reason = 'الخدمة ترفض الطلب مؤقتاً — حاول بعد قليل.';
      else if (errData?.error?.code) reason = `تعذر التنزيل (${String(errData.error.code).replace('error.api.', '')}).`;
    } catch { /* لا تفاصيل إضافية */ }
    throw new Error(reason || 'تعذر الوصول إلى خدمة الاستخراج.');
  }
  const data = await response.json();
  if (Array.isArray(data?.picker) && data.picker.length > 0) {
    const urls = data.picker
      .map((entry: { url?: unknown }) => (typeof entry?.url === 'string' ? entry.url : null))
      .filter((value: unknown): value is string => typeof value === 'string');
    if (urls.length > 0) return urls;
  }
  if (data?.status === 'error' || typeof data?.url !== 'string' || !data.url) {
    throw new Error(data?.text || 'تعذر استخراج رابط الوسائط من هذا الرابط.');
  }
  return [data.url as string];
}

/** يفحص الرابط مسبقاً: إن كان منشور صور (كاروسيل) يعيد قائمة روابط كل الصور، وإلا قائمة فارغة. */
export async function previewCarouselImages(sourceUrl: string): Promise<string[]> {
  try {
    if (!/^https?:\/\//i.test(sourceUrl) || looksLikeDirectMedia(sourceUrl)) return [];
    const resolved = await resolveMediaUrls(sourceUrl);
    return resolved.length > 1 ? resolved : [];
  } catch {
    return [];
  }
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
      let target = `${baseDirectory}${safeFilename(item.title, item.format)}`;

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

  /** يجلب حجم الملف لجودة/معدل محدد عبر طلب استخراج حقيقي ثم ترويسة الحجم. */
  const probeFileSize = useCallback(async (input: { url: string; type: MediaType; format: string }) => {
    try {
      if (!/^https?:\/\//i.test(input.url)) return null;
      if (input.type === 'image') {
        const info = await fetchRemoteFileInfo(input.url);
        return null; // الأحجام تُجلب لكل صورة على حدة في الواجهة
      }
      const options = requestOptionsFor(input.type, input.format);
      const [mediaUrl] = await resolveMediaUrls(input.url, options);
      const info = await fetchRemoteFileInfo(mediaUrl);
      return null;
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
    addSmartDownload,
    addCarouselImages,
    resolveCarouselVideo,
    probeFileSize,
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
  }), [items, waitingForWifi, addDownload, addSmartDownload, addCarouselImages, resolveCarouselVideo, probeFileSize, addSharedFile, retryDownload, removeDownload, clearCompleted, openFile, shareFile, moveToVault, removeFromVault, setQueueOptions, downloadDir, setDownloadDir, restoreFromTrash, deletePermanently, emptyTrash]);

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloads() {
  const value = useContext(DownloadContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadProvider');
  return value;
}
