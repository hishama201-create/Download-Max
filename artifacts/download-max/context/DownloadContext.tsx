import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
// واجهة الملفات الحديثة: النسخ عبر تدفق أصلي (Native Stream) يدعم وجهات SAF content://.
import { Directory as NativeDirectory, File as NativeFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import * as MediaLibrary from 'expo-media-library';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { MaxTasks } from '@/context/SettingsContext';
import { setPublicRootProvider, syncHistorySnapshot, upsertHistoryEntry, deleteHistoryEntry } from '@/context/historyDb';
import { extractAudioFromVideo } from '@/context/audio';
import { generateVideoThumbnail } from '@/context/thumbnails';

const STORAGE_KEY = '@download-max/downloads';
const DOWNLOAD_DIR_KEY = '@download-max/download-dir';
/** مفتاح حفظ روابط مجلدات الأنواع الثلاثة (SAF) المربوطة بجذر مختار معيّن (إصلاح v2.0.10). */
const SAF_FOLDERS_KEY_PREFIX = '@download-max/saf-folders/';
/** مفتاح حفظ نقطة استئناف كل مهمة متوقفة مؤقتاً (جزء الملف المحمّل). */
const RESUME_KEY_PREFIX = '@download-max/resume/';
/** مدة بقاء الملفات في سلة المحذوفات قبل حذفها تلقائياً (30 يوماً). */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * خدمة تحويل روابط الصفحات إلى روابط وسائط مباشرة.
 * يمكن تغييرها لكل بيئة عبر EXPO_PUBLIC_EXTRACTOR_URL (تُثبَّت وقت البناء).
 */
const EXTRACTOR_API_URL =
  process.env.EXPO_PUBLIC_EXTRACTOR_URL?.trim() || 'https://api-production-85a7.up.railway.app/';

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
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
 * يجهّز رابط فيديو يوتيوب للتشغيل الفوري داخل المشغّل الأصلي.
 * يستخدم نفس خدمة الاستخراج التي يعتمدها التنزيل، مع الخدمة الاحتياطية كخطة بديلة،
 * لأن مشغّل يوتيوب المدمج (WebView) يرفض التشغيل داخل تطبيقات أندرويد.
 */
export async function resolveStreamUrl(youtubeUrl: string): Promise<{ url: string; title: string | null }> {
  try {
    const [url] = await resolveMediaUrls(youtubeUrl, { mode: 'video', videoQuality: '720' });
    if (url) return { url, title: await fetchYoutubeTitle(youtubeUrl) };
  } catch { /* نجرّب الاحتياطية */ }
  return prepareYoutubeFallback(youtubeUrl, { mode: 'video', format: '720' });
}

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
  /** (v2.0.20) هل وُجدت نسخة من الملف في مجلد الجهاز؟ يمنع إعادة النسخ مع كل فتح. */
  deviceSaved?: boolean;
  /** وقت النقل إلى سلة المحذوفات — وجوده يعني أن الملف في السلة. */
  deletedAt?: number;
  /** خيارات طلب الاستخراج (جودة الفيديو أو معدل الصوت المطلوبة). */
  requestOptions?: MediaRequestOptions;
  /** صورة مصغّرة للملف (لقطة من الفيديو) — تُولَّد بعد اكتمال التنزيل. */
  thumbnailUri?: string;
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
  /** يشغّل الملف بنية فتح باستخدام (قائمة مشغلات الفيديو/الصوت/الصور المدعومة). */
  openFile: (item: DownloadItem) => Promise<void>;
  /** يشارك الملف عبر لوحة مشاركة أندرويد (التطبيقات التي تقبل مشاركة الملفات). */
  shareFile: (item: DownloadItem) => Promise<void>;
  /** (2) ينسخ الملف من مساحة التطبيق إلى مجلد التنزيلات الحقيقي في جهاز المستخدم. */
  copyToDeviceDownloads: (item: DownloadItem) => Promise<{ ok: boolean; message: string }>;
  syncPendingToDevice: () => Promise<number>;
  /** (v2.0.20) يفتح منتقي مجلد الجهاز مرة واحدة ثم ينسخ كل ما بقي داخل التطبيق إليه. */
  pickDeviceFolderNow: () => Promise<boolean>;
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

function safeFilename(title: string, format: string) {
  // \p{L} يحافظ على الحروف العربية وكل اللغات في اسم الملف.
  const cleaned = title.replace(/[^\p{L}\p{N}\s._-]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'download';
  return `${cleaned}.${format}`;
}

/**
 * (v2.0.17) اسم غير مكرر داخل المجلد: لو الملف موجود يُرقّم تلقائياً
 * «اسم (1).mp4» بدل الكتابة فوق ملف المستخدم القديم.
 */
async function uniqueFilename(dir: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let n = 1;
  for (;;) {
    const info = await FileSystem.getInfoAsync(`${dir}${candidate}`).catch(() => null);
    if (!info?.exists) return candidate;
    candidate = `${stem} (${n++})${ext}`;
  }
}

/** يحاول استخراج اسم ملف مقروء من مسار الرابط المباشر. */
/**
 * (v2.0.16) بعض خدمات الاستخراج ترجع رابطاً وهمياً (مثل link.invalid) بدل رابط حقيقي،
 * فيبدأ التنزيل ويفشل بلا أمل وتكرار المحاولة يفشل بنفس الشكل. نرفضه مبكراً برسالة واضحة.
 */
function isUsableMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('.')) return false;
    if (host === 'link.invalid' || host.endsWith('.invalid')) return false;
    if (host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.example')) return false;
    if (host === 'localhost' || host === '127.0.0.1') return false;
    return true;
  } catch {
    return false;
  }
}

function prettyNameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    const decoded = decodeURIComponent(last).replace(/\.[^.]+$/, '').replace(/[-_+]+/g, ' ').trim();
    if (!looksLikeHumanName(decoded)) return null;
    return decoded.slice(0, 60);
  } catch {
    return null;
  }
}

/**
 * (إصلاح v2.0.11) هل هذا اسماً بشرياً حقيقياً أم بصمة/هاش من الخادم؟
 * خوادم فيسبوك وإنستغرام تسمّي ملفات الكاروسيل ببصمات مثل «987333cd4fc5481b980» —
 * معايير الكشف: طويل نسبياً + خالٍ من المسافات + نسبة الأرقام والرموز عالية،
 * أو سلسلة سداسية عشرية طويلة. الفلتر القديم (3 حروف متتالية) كان يسلّلها
 * لأن الهاشات تحوي مقاطع حرفية مثل «fced».
 */
function looksLikeHumanName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  // سلسلة سداسية عشرية طويلة (بصمة الخوادم الأشهر) — ترفض مباشرة.
  if (/^[0-9a-f]{12,}$/i.test(trimmed.replace(/[\s._-]/g, ''))) return false;
  const spaces = (trimmed.match(/\s/g) ?? []).length;
  if (spaces === 0 && trimmed.length >= 16) {
    // كلمة واحدة طويلة: نسبة الحروف الرقمية/الرمزية تحسم الهوية.
    const letters = (trimmed.match(/[\p{L}]/gu) ?? []).length;
    const digits = (trimmed.match(/[0-9]/g) ?? []).length;
    if (digits >= 4 && digits / letters >= 0.25) return false; // مزيج رقمي كثيف = بصمة
    if (letters / trimmed.length < 0.5) return false;
  }
  return true;
}

/** يجلب اسم الملف الحقيقي ونوعه من ترويسات الخادم قبل التنزيل. */
async function fetchRemoteFileInfo(mediaUrl: string): Promise<{ filename: string | null; mime: string | null; length: number | null }> {
  try {
    let response = await fetch(mediaUrl, { method: 'HEAD' });
    const disposition = response.headers.get('content-disposition');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
    const lengthHeader = response.headers.get('content-length');
    let length = lengthHeader ? Number(lengthHeader) : null;
    // خوادم البث (مثل يوتيوب عبر الخدمة الاحتياطية) كثيراً ما تحذف content-length من HEAD،
    // لكنها ترجعه في ترويسة Content-Range لأول نطاق بايتات — فنستخرج الحجم الكلي منها.
    if (!length || length <= 0) {
      try {
        const range = await fetch(mediaUrl, { method: 'GET', headers: { Range: 'bytes=0-1' } });
        const contentRange = range.headers.get('content-range');
        const total = contentRange?.match(/\/(\d+)\s*$/);
        if (total) length = Number(total[1]);
        try { await range.body?.cancel(); } catch { /* لا شيء */ }
      } catch { /* نبقي length كما هو */ }
    }
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
    return { filename: filename?.trim() || null, mime, length: length && Number.isFinite(length) && length > 0 ? length : null };
  } catch {
    return { filename: null, mime: null, length: null };
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
/** اسم المجلد الفرعي حسب نوع الوسيط (تنظيم على طريقة مجلدات التنزيل المعروفة). */
function subfolderFor(type: MediaType): string {
  if (type === 'video') return 'video';
  if (type === 'audio') return 'voice';
  return 'image';
}

/** اسم مجلد التنزيلات الافتراضي. */
const APP_DIR_NAME = 'Download Max';
/**
 * (v2.0.12) هيكل Snaptube في جذر التخزين العام — ثابت واحد يغيّر كل شيء:
 * DownloadMax/download/DownloadMax Video|Music|Image (+ DownloadMax/db للسجل).
 */
const SNAPTUBE_ROOT_NAME = 'DownloadMax';
const SNAPTUBE_DOWNLOAD_DIR = 'download';
const SNAPTUBE_VIDEO_DIR = 'DownloadMax Video';
const SNAPTUBE_MUSIC_DIR = 'DownloadMax Music';
const SNAPTUBE_IMAGE_DIR = 'DownloadMax Image';
/** (v2.0.18) اسم الألبوم العام في المعرض/ملفات الجهاز — يظهر كـ «Download Max». */
const ALBUM_NAME = 'Download Max';

/** مجلد النوع في هيكل Snaptube حسب نوع الوسيط. */
function snaptubeSubfolderFor(type: MediaType): string {
  if (type === 'video') return SNAPTUBE_VIDEO_DIR;
  if (type === 'audio') return SNAPTUBE_MUSIC_DIR;
  return SNAPTUBE_IMAGE_DIR;
}
/**
 * (v2.0.10) هل هذا الرابط يشير لمجلد اسمه «Download Max» أصلاً؟
 * نقرأ معرّف المستند من الرابط (primary:Download Max مثلاً) بعد فك الترميز —
 * لأن الجزء الأخير من روابط SAF قد يكون معرّفاً رقمياً لا اسماً حقيقياً.
 */
function safUriDisplayName(uri: string): string | null {
  try {
    if (!uri.startsWith('content://')) return null;
    const last = uri.split('/').filter(Boolean).pop() ?? '';
    let decoded = last;
    try { decoded = decodeURIComponent(last); } catch { /* الاسم غير مُرمّز */ }
    // معرف مستند «primary:Download Max» → الاسم بعد النقطتين. معرف شجري «primary:» → جذر التخزين.
    const tail = decoded.includes(':') ? decoded.split(':').pop() ?? '' : decoded;
    return tail.trim() || null;
  } catch { return null; }
}

function isSafAppRootUri(uri: string): boolean {
  return safUriDisplayName(uri)?.toLowerCase() === APP_DIR_NAME.toLowerCase();
}
/** الجذر العام للتخزين الداخلي في أندرويد — يحتاج صلاحية «الوصول لجميع الملفات». */
const PUBLIC_ROOT = '/storage/emulated/0/';
/**
 * (v2.0.12) جذر هيكل Snaptube العام: «/storage/emulated/0/DownloadMax/».
 * يعمل فقط مع صلاحية All Files Access — وهو المسار الأساسي للحفظ الآن.
 */
function publicStorageRoot(): string {
  return `${PUBLIC_ROOT}${SNAPTUBE_ROOT_NAME}/`;
}

// (v2.0.12) تزويد موديول قاعدة السجل بمجلد الجذر العام (بلا استيراد دائري).
setPublicRootProvider(() => {
  if (Platform.OS !== 'android') return null;
  return publicStorageRoot();
});
/** مجلد التنزيلات العام في الجهاز. */
const PUBLIC_DOWNLOAD_DIR = `${PUBLIC_ROOT}Download/`;

/** ملف الاختبار: اسم عادي (أندرويد 11+ يمنع الملفات التي تبدأ بنقطة) وصيغة URI. */
const PROBE_FILE = `file://${PUBLIC_DOWNLOAD_DIR}download-max-probe.tmp`;

/**
 * هل لدينا صلاحية الوصول لجميع الملفات؟ القراءة وحدها غير موثوقة على أندرويد 11+،
 * فنتحقق بالكتابة: ننشئ ملفاً صغيراً في المجلد العام ثم نحذفه فوراً.
 */
export async function hasStorageAccess(): Promise<boolean> {
  return (await storageAccessError()) === null;
}

/**
 * (2) بدل ابتلاع الخطأ، نرجّع سببه الحقيقي حتى تعرضه الواجهة بدل رسالة عامة.
 * يرجع `null` إذا كانت الصلاحية متاحة.
 */
/** نتيجة الفحص مؤقتة حتى لا نكتب ملف اختبار مع كل تنزيل. */
let accessCache: { at: number; reason: string | null } | null = null;

export async function storageAccessError(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  if (accessCache && Date.now() - accessCache.at < 10000) return accessCache.reason;
  const reason = await probeStorageAccess();
  accessCache = { at: Date.now(), reason };
  return reason;
}

async function probeStorageAccess(): Promise<string | null> {
  try {
    await FileSystem.writeAsStringAsync(PROBE_FILE, '');
    await FileSystem.deleteAsync(PROBE_FILE, { idempotent: true });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message || 'تعذّر الوصول إلى مجلد التنزيلات على الجهاز';
  }
}

/** (v2.0.19) مجلد النوع في هيكل Snaptube العام — يُنشأ تلقائياً إن لم يوجد (لصلاحية All Files). */
async function snaptubeTypeDir(type: MediaType): Promise<string | null> {
  try {
    const dir = `${publicStorageRoot()}${SNAPTUBE_DOWNLOAD_DIR}/${snaptubeSubfolderFor(type)}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return dir;
  } catch {
    return null;
  }
}

/**
 * (v2.0.18) الحفظ في ألبوم «Download Max» عبر نظام أندرويد الرسمي MediaStore
 * (expo-media-library الموجودة أصلاً بالتطبيق). بصلاحية وسائط عادية فقط،
 * وطلب الإذن يُعرض مرة واحدة فقط عندما يمكن عرضه — لا نُزعج مستخدماً رفض سابقاً.
 * الفشل غير حرج: الملف يبقى محفوظاً في مساحة التطبيق.
 */
export async function saveToPublicAlbum(localUri: string, filename: string, type: MediaType): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const current = await MediaLibrary.getPermissionsAsync().catch(() => null);
    let granted = !!current?.granted;
    if (!granted && current?.canAskAgain) {
      granted = !!(await MediaLibrary.requestPermissionsAsync().catch(() => null))?.granted;
    }
    if (!granted) return false;
    const asset = await MediaLibrary.createAssetAsync(localUri).catch(() => null);
    if (!asset) {
      // (v2.0.20) مسار بديل: نسخ مباشر إلى MediaStore عبر saveToLibraryAsync.
      try {
        await MediaLibrary.saveToLibraryAsync(localUri);
        return true;
      } catch {
        return false;
      }
    }
    let album = await MediaLibrary.getAlbumAsync(ALBUM_NAME).catch(() => null);
    if (!album) album = await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, true).catch(() => null);
    else await MediaLibrary.addAssetsToAlbumAsync(asset, album, true).catch(() => undefined);
    return !!album;
  } catch {
    return false;
  }
}

/** نسخة آمنة من مجلد التنزيلات في تخزين الجهاز: «/storage/emulated/0/Download/Download Max/». */
async function publicDownloadRoot(): Promise<string> {
  const dir = `${PUBLIC_DOWNLOAD_DIR}${APP_DIR_NAME}/`;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    return PUBLIC_DOWNLOAD_DIR;
  }
  return dir;
}

/**
 * يفتح منتقي مجلدات أندرويد الرسمي (SAF) مرة واحدة — بلا صلاحية «الوصول لجميع الملفات».
 * يُرجع null عند رفض المستخدم أو الإلغاء.
 */
async function pickDeviceDirectory(): Promise<string | null> {
  const picked = await FileSystem.StorageAccessFramework
    .requestDirectoryPermissionsAsync()
    .catch(() => null);
  return picked?.granted ? picked.directoryUri : null;
}

/**
 * (v2.0.8) مجلد «Download Max» داخل المجلد الذي اختاره المستخدم — المسار الأساسي للتطبيق:
 * «المجلد المختار / Download Max / video · voice · image».
 * (إصلاح v2.0.10): إذا كان المجلد المختار اسمه «Download Max» أصلاً نستخدمه كما هو
 * بلا إنشاء مجلد متشابك ثانٍ بداخله.
 */
let safAppRootCache: string | null = null;

function setSafAppRootCache(uri: string | null): void {
  safAppRootCache = uri;
}

async function safAppRoot(pickedDirUri: string): Promise<string> {
  if (safAppRootCache) return safAppRootCache;
  // المجلد المختار اسمه «Download Max»؟ إذن هو جذر التطبيق نفسه — لا تعشيش.
  if (isSafAppRootUri(pickedDirUri)) {
    safAppRootCache = pickedDirUri;
    return pickedDirUri;
  }
  const root = await safSubfolder(pickedDirUri, APP_DIR_NAME);
  setSafAppRootCache(root === pickedDirUri ? null : root);
  return safAppRootCache ?? pickedDirUri;
}

/**
 * (v2.0.19) سلسلة الحفظ في جهاز المستخدم بالترتيب المضمون — كل مسار صامت عند فشله:
 * 1) «الوصول لجميع الملفات» متاح؟ نسخة في هيكل DownloadMax/download/… (الأفضل — ملف حقيقي).
 * 2) المستخدم اختار مجلداً مرة واحدة (SAF)؟ نسخة في «المختار / Download Max / النوع» — مضمون
 *    لأن صلاحية الشجرة محفوظة (أثبتت نجاحها بإنشائها المجلدات).
 * 3) وإلا ألبوم «Download Max» عبر MediaStore (المعرض) بصلاحية وسائط عادية.
 * 4) أخيراً المسار العام «Download/Download Max» إن سارت الصلاحية المباشرة.
 * الأصل يبقى دائماً في مساحة التطبيق (fileUri يشير إليه) — والفشل الكلي لا يعرض أي خطأ.
 */
async function mirrorToDeviceDownloads(localUri: string, filename: string, type: MediaType, safDir: string | null): Promise<boolean> {
  // (v2.0.21) صفّر سبب الفشل قبل بدء السلسلة حتى لا يظهر سبب ملف سابق لملف جديد.
  lastDeviceSaveError = null;
  // ١) صلاحية All Files Access: هيكل Snaptube العام.
  if (Platform.OS === 'android' && (await hasStorageAccess())) {
    const dir = await snaptubeTypeDir(type);
    if (dir) {
      try {
        await FileSystem.copyAsync({ from: localUri, to: `${dir}${filename}` });
        return true;
      } catch (error) { noteDeviceSaveError('نسخ AllFiles', error); /* نكمل للمسار التالي */ }
    }
  }
  // ٢) المجلد الذي اختاره المستخدم (SAF) — أضمن مسار متاح بلا أي صلاحية خاصة.
  if (safDir) {
    const appRoot = await safAppRoot(safDir);
    const dir = await safSubfolder(appRoot, subfolderFor(type));
    if (await saveFileToSafDirectory(localUri, filename, mimeFor(filename), dir)) return true;
  } else {
    noteDeviceSaveError('SAF', 'لم يتم اختيار مجلد حفظ في الجهاز');
  }
  // ٣) ألبوم «Download Max» عبر MediaStore.
  if (await saveToPublicAlbum(localUri, filename, type)) return true;
  if (!lastDeviceSaveError) noteDeviceSaveError('MediaStore', 'إذن الوسائط غير ممنوح — مرفوض نهائياً غالباً');
  // ٤) المسار العام «Download/Download Max» كخيار أخير.
  if (await hasStorageAccess()) {
    try {
      const dir = `${await publicDownloadRoot()}${subfolderFor(type)}/`;
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      await FileSystem.copyAsync({ from: localUri, to: `${dir}${filename}` });
      return true;
    } catch (error) { noteDeviceSaveError('مسار Download', error); /* المسار العام غير متاح أيضاً */ }
  }
  return false;
}

/**
 * يطلب من المستخدم اختيار مجلد التنزيل مرة واحدة (SAF) ويحفظ اختياره بشكل دائم.
 * (إصلاح v2.0.8): سابقاً كان الاختيار يُكتب في مرجع مؤقت فقط فكان يضيع بعد
 * إعادة تشغيل التطبيق ويُطلب من المستخدم من جديد — الآن يمر عبر الحفظ الدائم.
 */
async function requestAndStoreDeviceDir(
  setDownloadDir: (uri: string | null) => Promise<void>,
  current: string | null,
): Promise<string | null> {
  const picked = await pickDeviceDirectory();
  if (!picked) return null;
  if (picked !== current) await setDownloadDir(picked);
  return picked;
}

/**
 * يبحث عن مجلد فرعي بالاسم المطلوب داخل مجلد SAF ويُنشئه فقط إن لم يوجد نهائياً.
 *
 * (إصلاح v2.0.8): في الإصدارات السابقة كنا نستدعي makeDirectoryAsync أولاً ونعتمد
 * على فشلها لاكتشاف المجلد الموجود، لكن أندرويد لا يفشل — بل ينشئ تلقائياً
 * «video (1)» ثم «video (2)»... فيتكرر المجلد مع كل تنزيل. الآن نقرأ المحتويات
 * أولاً ونعيد استخدام المجلد الموجود (مطابقة مرنة: فك الترميز + تجاهل حالة الأحرف)،
 * ولا ننشئ إلا إذا لم يوجد.
 */
async function findSafChildByName(parentUri: string, name: string): Promise<string | null> {
  try {
    const entries = await FileSystem.StorageAccessFramework.readDirectoryAsync(parentUri);
    const wanted = name.toLowerCase();
    for (const entry of entries) {
      const tail = entry.split('/').filter(Boolean).pop() ?? '';
      let decoded = tail;
      try { decoded = decodeURIComponent(tail); } catch { /* الاسم غير مُرمّز */ }
      if (decoded.toLowerCase() === wanted) return entry;
    }
  } catch { /* تعذّرت القراءة — نحاول الإنشاء مباشرة */ }
  return null;
}

/**
 * (v2.0.12) استعادة أسماء العناصر القديمة المحفوظة كهاش (مثل bd604a8e…):
 * عند فتح التطبيق، أي عنصر مكتمل عنوانه بصمة خادم ونملك رابطه الأصلي نستعلم
 * الخادم مرة واحدة (HEAD) عن اسمه الحقيقي ونحدّث القائمة — القديم يُصحح تلقائياً.
 */
async function restoreLegacyHashTitles(
  items: DownloadItem[],
  patchItem: (id: string, patch: Partial<DownloadItem>) => void,
): Promise<void> {
  for (const item of items) {
    if (item.status !== 'completed' || !item.resolvedUrl && !/^https?:\/\//i.test(item.url)) continue;
    if (looksLikeHumanName(item.title)) continue;
    // (v2.0.16) يوتيوب أولاً: عنوان الصفحة هو الاسم الحقيقي (للصوت والصور معاً)،
    // فالرابط المباشر للصيغة often بلا اسم مفيد («54394» أو بصمة).
    if (isYoutubeUrl(item.url)) {
      try {
        const ytTitle = await fetchYoutubeTitle(item.url);
        if (ytTitle && looksLikeHumanName(ytTitle)) {
          await patchItem(item.id, { title: ytTitle.slice(0, 80) });
          continue;
        }
      } catch { /* نكمل للمصدر التالي */ }
    }
    try {
      const candidate = await fetchRemoteFileInfo(item.url);
      const name = candidate.filename ?? prettyNameFromUrl(item.url);
      if (name && looksLikeHumanName(name.replace(/\.[^.]+$/, ''))) {
        await patchItem(item.id, { title: name.replace(/\.[^.]+$/, '') });
      }
    } catch { /* الخادم لا يرد — نترك العنوان كما هو */ }
  }
}

/**
 * (v2.0.10) ذاكرة كاش للمجلدات الفرعية ومفتاح الحفظ الدائم الحالي,
 * حتى لا تُقرأ محتويات المجلد الأب ولا يُستدعى الإنشاء مع كل تنزيل —
 * هذا هو الحل الجذري لتكرار «video (1)» و«video (2)» على مزودات
 * يكون فيها الجزء الأخير من روابط العناصر معرّفاً داخلياً لا اسماً،
 * فيفشل البحث بالاسم ويُنشأ مجلد جديد مع كل ملف (وأندرويد يفصلها تلقائياً بأرقام).
 */
let safFoldersKeyCache: string | null = null;
let safTypeFoldersCache: Map<string, string> | null = null;
/** أقفال الإنشاء: تمنع سباق تهيئة متزامن من إنشاء نفس المجلد مرتين. */
const safSubfolderInflight = new Map<string, Promise<string>>();

function clearSafTypeFolderCaches(): void {
  safFoldersKeyCache = null;
  safTypeFoldersCache = null;
  safSubfolderInflight.clear();
}

/** يحمّل روابط مجلدات الأنواع المحفوظة لهذا الجذر من التخزين الدائم. */
async function loadSafTypeFolders(safDir: string): Promise<Map<string, string>> {
  if (safFoldersKeyCache === safDir && safTypeFoldersCache) return safTypeFoldersCache;
  let saved: Record<string, string> = {};
  try {
    const raw = await AsyncStorage.getItem(SAF_FOLDERS_KEY_PREFIX + safDir);
    if (raw) saved = JSON.parse(raw) as Record<string, string>;
  } catch { /* لا حفظ سابق — سننشئه الآن */ }
  safFoldersKeyCache = safDir;
  safTypeFoldersCache = new Map(Object.entries(saved));
  return safTypeFoldersCache;
}

/** يحفظ روابط مجلدات الأنواع مربوطة بالجذر المختار بشكل دائم. */
async function persistSafTypeFolders(safDir: string, folders: Map<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(SAF_FOLDERS_KEY_PREFIX + safDir, JSON.stringify(Object.fromEntries(folders)));
  } catch { /* فشل الحفظ غير حرج — الكاش بالذاكرة يكفي للجلسة */ }
}

/** تحقق حي أن رابط المجلد المحفوظ ما زال مقروءاً (لم تنسحب الصلاحية). */
async function isSafDirAlive(uri: string): Promise<boolean> {
  try {
    await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
    return true;
  } catch { return false; }
}

async function safSubfolder(directoryUri: string, sub: string): Promise<string> {
  // (v2.0.10) كاش بالذاكرة: بعد أول إنشاء/اكتشاف لا نلمس نظام الملفات لهذا المجلد أبداً.
  const cached = safTypeFoldersCache?.get(sub);
  if (cached && safFoldersKeyCache === directoryUri) return cached;

  // (v2.0.10) قفل: استدعاءات متزامنة لنفس المجلد تنتظر نفس العملية بدل سباق إنشاء.
  const inflight = safSubfolderInflight.get(`${directoryUri}|${sub}`);
  if (inflight) return inflight;

  const job = (async (): Promise<string> => {
    const folders = await loadSafTypeFolders(directoryUri);
    const saved = folders.get(sub);
    // (v2.0.10) الثقة المطلقة بالرابط المحفوظ إذا كان حياً — بدون أي بحث بالاسم
    // (البحث يفشل على بعض المزودات لأن آخر جزء بالرابط معرّف داخلي لا اسم).
    if (saved && safFoldersKeyCache === directoryUri && await isSafDirAlive(saved)) return saved;

    // (v2.0.8) نبحث أولاً عن المجلد الموجود ونعيد استخدامه — الإنشاء آخر حل.
    const existing = await findSafChildByName(directoryUri, sub);
    const resolved = existing
      ?? await FileSystem.StorageAccessFramework.makeDirectoryAsync(directoryUri, sub).catch(async () => {
        // قد يكون أُنشئ للتو بسباق مع مهمة أخرى — فحص أخير ثم نكتب في الجذر.
        return await findSafChildByName(directoryUri, sub) ?? directoryUri;
      });
    if (resolved !== directoryUri) {
      folders.set(sub, resolved);
      await persistSafTypeFolders(directoryUri, folders);
    }
    return resolved;
  })();
  safSubfolderInflight.set(`${directoryUri}|${sub}`, job);
  try {
    return await job;
  } finally {
    safSubfolderInflight.delete(`${directoryUri}|${sub}`);
  }
}

/** يفتح شاشة «All files access» الخاصة بتطبيقنا مباشرة في إعدادات النظام. */
export async function openAllFilesAccessSettings(): Promise<void> {
  const applicationId = Constants.expoConfig?.android?.package;
  try {
    await IntentLauncher.startActivityAsync('android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', {
      data: `package:${applicationId ?? 'com.anonymous.downloadmax'}`,
      flags: 1,
    });
  } catch {
    await Linking.openSettings();
  }
}

/**
 * ينشئ «Download Max» ومجلداته الثلاثة فوراً (عند منح الإذن أو أول تشغيل)،
 * حتى لا ينتظر المستخدم أول تنزيل ليظهر له المجلد في ملفات جهازه.
 */
export async function ensureDownloadFolders(): Promise<string | null> {
  const base = await baseDownloadDir();
  if (!base) return null;
  for (const type of ['video', 'image', 'voice'] as MediaType[]) {
    await ensureTypeDir(base, type);
  }
  // (v2.0.18) الألبوم العام «Download Max» يُنشأ تلقائياً من أول تنزيل عبر MediaStore —
  // لا حاجة لإنشاء مجلدات بالكتابة المباشرة (كانت تفشل بصمت على أجهزة New Architecture).
  return base;
}

/** المسار الفعلي لمجلد التنزيلات المعروض في الإعدادات. */
export async function currentDownloadFolder(): Promise<string> {
  if (Platform.OS === 'android' && (await hasStorageAccess())) {
    return `${publicStorageRoot()}${SNAPTUBE_DOWNLOAD_DIR}/`;
  }
  const base = await baseDownloadDir();
  return base ?? FileSystem.documentDirectory ?? '';
}

/**
 * (2) التخزين الآمن: التنزيلات تُحفظ داماً داخل مساحة التطبيق.
 * هذي نفس طريقة سنابتوب: مضمونة 100% وما تعتمد على إذن نظام أبداً.
 * لو حبّ المستخدم يشوف ملفاته في مدير الملفات، يستخدم «نسخ إلى مجلد التنزيلات».
 */
async function baseDownloadDir(): Promise<string | null> {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  const dir = `${root}${APP_DIR_NAME}/`;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    return root;
  }
  return dir;
}

/** ملفات الوسائط داخل مجلد معيّن (قراءة فقط — لا حذف ولا تعديل). */
async function mediaFilesIn(dir: string, depth = 0): Promise<string[]> {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const uri = `${dir}${name}`;
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (info?.isDirectory) {
      if (depth < 2) found.push(...(await mediaFilesIn(uri, depth + 1)));
      continue;
    }
    if (mediaTypeOf(name)) found.push(uri);
  }
  return found;
}

/** ملفات المستخدم التي لا يعرفها التطبيق (بعد إعادة التثبيت) — تُعاد للّقائمة. */
async function orphanFilesIn(dir: string): Promise<string[]> {
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dir);
    // نتجاهل المجلدات المعروفة (Video/Audio/Image) ونأخذ كل ما عداها كملفات مستعادة.
    const folders = ['video', 'voice', 'image', 'Video', 'Audio', 'Image'];
    return names.filter((name) => !name.startsWith('.') && !folders.includes(name));
  } catch {
    return [];
  }
}

/** يستنتج نوع الملف من امتداده: فيديو أو صوت أو صورة. */
function mediaTypeOf(filename: string): MediaType | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return null;
}

/** يجهز مجلد النوع الفرعي ويعيد المسار مع فاصله. يعيد '' إذا تعذر الإنشاء. */
async function ensureTypeDir(baseDirectory: string, type: MediaType): Promise<string> {
  try {
    const dir = `${baseDirectory}${subfolderFor(type)}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return dir;
  } catch {
    return '';
  }
}

function extensionFor(mimeType: string | null, originalName: string | null, type: MediaType) {
  const fromName = originalName?.includes('.') ? originalName.split('.').pop() : null;
  if (fromName && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
  const fromMime = extFromMime(mimeType);
  if (fromMime) return fromMime;
  // بدائل مضمونة حتى لا يُحفظ الملف أبداً بلا امتداد صالح.
  return type === 'image' ? 'jpg' : type === 'audio' ? 'mp3' : 'mp4';
}

/** حد أقصى لخطة Base64 الاحتياطية — فوقه تنهار ذاكرة JS مع الملفات الكبيرة. */
const SAF_BASE64_FALLBACK_LIMIT = 24 * 1024 * 1024;

/**
 * (v2.0.21) آخر سبب فشل حقيقي في الحفظ بمجلد الجهاز — يُعرض باختصار بدل الصمت.
 * كان سبب فشل كتابة SAF يبتلع في console فقط ولا يعرفه أحد؛ الآن يُسجّل هنا
 * ويُعرض تحت الملف ومنه نعرف بالضبط أين تعطّلت السلسلة (SAF / AllFiles / MediaStore).
 */
let lastDeviceSaveError: string | null = null;
function noteDeviceSaveError(tag: string, error?: unknown): string {
  const raw = error instanceof Error ? error.message : error ? String(error) : 'غير معروف';
  lastDeviceSaveError = `${tag}: ${raw.length > 110 ? `${raw.slice(0, 110)}…` : raw}`;
  return lastDeviceSaveError;
}

/**
 * (إصلاح v2.0.9) نسخ الملف إلى مستند SAF بالتدفق الأصلي عبر واجهة الملفات الحديثة.
 * سبب ملفات «الحجم 0» السابقة: copyAsync القديمة تحوّل داخلياً وجهات content://
 * إلى مسار محلي لا معنى له فتفشل، وخطة Base64 تنهار مع الفيديوهات الكبيرة —
 * فيبقى الملف الفارغ من createFileAsync يتيمة في مجلدات المستخدم.
 * هنا: نسخ Native Stream بلا مرور بالذاكرة + تحقق أن الحجم المكتوب يطابق الأصل.
 */
async function streamCopyToSafFile(localUri: string, safFileUri: string): Promise<boolean> {
  try {
    const source = new NativeFile(localUri);
    const target = new NativeFile(safFileUri);
    // (v2.0.12) محاولتان: بعض مزوّدات SAF (سامسونج خصوصاً) تُرجع size قديماً/خاطئاً
    // مباشرة بعد كتابة ملف كبير — إعادة المحاولة تعطي النظام فرصة لتحديث المقاس.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await source.copy(target, { overwrite: true });
        const expected = source.size;
        const actual = target.size;
        if (expected === 0 || actual === expected) return true;
        // الحجم غير مطابق؟ ننتظر قليلاً ونعيد قراءته قبل الحكم بالفشل.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const reread = new NativeFile(safFileUri).size;
        if (expected === 0 || reread === expected) return true;
      } catch (copyError) {
        noteDeviceSaveError('نسخ SAF بالتدفق', copyError);
        console.error('[v2.0.12] خطأ النسخ بالتدفق إلى SAF (محاولة ' + (attempt + 1) + '):', copyError);
      }
    }
    return false;
  } catch (error) {
    noteDeviceSaveError('نسخ SAF بالتدفق', error);
    console.error('[v2.0.12] خطأ غير متوقع في النسخ إلى SAF:', error);
    return false;
  }
}

/** ينسخ ملفاً محلياً إلى مجلد SAF الذي اختاره المستخدم (مكان التنزيل). */
/** (v2.0.10) تحقق بديل أن مستند SAF الناتج فيه محتوى فعلًا — عبر واجهة الملفات الحديثة. */
async function isSafFileHasContent(safFileUri: string): Promise<boolean> {
  try {
    const size = new NativeFile(safFileUri).size;
    return typeof size === 'number' && size > 0;
  } catch {
    return false;
  }
}

async function saveFileToSafDirectory(localUri: string, filename: string, mimeType: string, directoryUri: string): Promise<boolean> {
  let safFileUri: string | null = null;
  try {
    const baseName = filename.replace(/\.[^.]+$/, '') || 'download';
    safFileUri = await FileSystem.StorageAccessFramework.createFileAsync(directoryUri, baseName, mimeType);
    // (v2.0.9) النسخ بالتدفق الأصلي أولاً — يعمل مع أي حجم وبلا كارثة ذاكرة.
    // (ملاحظة v2.0.10): NativeFile.size قد يقرأ 0 مع بعض مزودات SAF حتى لو نجح
    // النسخ فعلاً — لذا فشل التتبع وحده لا يلغي النتيجة؛ نتحقق من الملف الناتج بنفسه.
    if (await streamCopyToSafFile(localUri, safFileUri)) return true;
    if (await isSafFileHasContent(safFileUri)) return true;
    // خطة Base64 أخيرة — للملفات الصغيرة فقط (سابقاً كانت تُجرب مع الكل فتنهار).
    const info = await FileSystem.getInfoAsync(localUri).catch(() => null);
    const size = info?.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
    if (size > 0 && size <= SAF_BASE64_FALLBACK_LIMIT) {
      try {
        const data = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.writeAsStringAsync(safFileUri, data, { encoding: FileSystem.EncodingType.Base64 });
        return true;
      } catch (base64Error) {
        noteDeviceSaveError('نسخ SAF (Base64)', base64Error);
        console.error('[v2.0.12] فشلت خطة Base64 الأخيرة:', base64Error);
      }
    }
    // (إصلاح v2.0.12) الحكم بالحذف بعد فحص فعلي: مستند فيه بيانات لا يُحذف أبداً —
    // حذف نسخة ناجحة بسبب قراءة حجم خاطئ كان سبب «فشل النسخ» الزائف على سامسونج.
    if (await isSafFileHasContent(safFileUri)) return true;
    await FileSystem.deleteAsync(safFileUri, { idempotent: true }).catch(() => undefined);
    return false;
  } catch (error) {
    noteDeviceSaveError('إنشاء/حفظ ملف SAF', error);
    console.error('[v2.0.12] فشل الحفظ في مجلد SAF:', error);
    if (safFileUri) await FileSystem.deleteAsync(safFileUri, { idempotent: true }).catch(() => undefined);
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

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', '3gp']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic']);

function mimeFor(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? '*/*';
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

export type ProbedFormat = { format: string; label: string; detail: string };
export type MediaProbeResult = {
  title: string | null;
  type: MediaType;
  /** الصيغ الحقيقية المتاحة لهذا الرابط — فارغة إن فشل الفحص (fallback للقائمة الثابتة). */
  formats: ProbedFormat[];
};

const VIDEO_QUALITY_LABELS: Record<string, string> = {
  '2160': '2160p 4K', '1440': '1440p 2K', '1080': '1080p HD', '720': '720p HD',
  '480': '480p', '360': '360p', '240': '240p', '144': '144p',
};

/**
 * (v2.0.18) فحص الرابط قبل التنزيل: يجلب العنوان الحقيقي ويجرّب الصيغ فعلياً لدى
 * خدمة الاستخراج، فيعرض على المستخدم قائمة حية بما هو متوفر لهذا الرابط تحديداً
 * بدل قائمة ثابتة مكتوبة يدوياً. الفحص لكل صيغة طلب واحد سريع؛ نجرّب الجودات
 * الشائعة فقط حتى لا يتأخر ظهور النافذة، والفشل الفردي يُتجاهل بصمت.
 */
export async function probeMediaSource(sourceUrl: string, type: MediaType): Promise<MediaProbeResult> {
  // العنوان الحقيقي أولاً (يوتيوب عبر oEmbed — بلا تكلفة).
  let title: string | null = null;
  if (isYoutubeUrl(sourceUrl)) {
    title = await fetchYoutubeTitle(sourceUrl).catch(() => null);
  }
  const formats: ProbedFormat[] = [];
  if (!/^https?:\/\//i.test(sourceUrl) || looksLikeDirectMedia(sourceUrl)) {
    return { title, type, formats };
  }
  // الصيغ المرشحة حسب النوع — نجرّبها فعلياً لدى الخدمة.
  const candidates: { format: string; label: string; detail: string; options: MediaRequestOptions }[] =
    type === 'video'
      ? ['1080', '720', '480', '360'].map((q) => ({
          format: `mp4-${q}`,
          label: VIDEO_QUALITY_LABELS[q] ?? `${q}p`,
          detail: q === '1080' ? 'أفضل جودة HD' : q === '720' ? 'جودة عالية' : q === '480' ? 'جودة متوسطة' : 'توفير البيانات',
          options: { mode: 'video' as const, videoQuality: q },
        }))
      : type === 'audio'
        ? ['mp3-320', 'mp3-128', 'm4a-128', 'mp3-64'].map((f) => {
            const [fmt, br] = f.split('-');
            return {
              format: f,
              label: `${fmt.toUpperCase()} ${br}K`,
              detail: br === '320' ? 'أعلى جودة — حجم أكبر' : br === '128' ? 'الأفضل للجوال — متوازن' : 'أصغر حجم',
              options: { mode: 'audio' as const, audioFormat: fmt, audioBitrate: br },
            };
          })
        : [];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const urls = await resolveMediaUrls(sourceUrl, candidate.options);
        return urls.length > 0 && isUsableMediaUrl(urls[0]) ? candidate : null;
      } catch {
        return null;
      }
    }),
  );
  for (const found of results) {
    if (found) formats.push({ format: found.format, label: found.label, detail: found.detail });
  }
  return { title, type, formats };
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
  const maxTasksRef = useRef<MaxTasks>(3);
  const maxTasksCellularRef = useRef<MaxTasks>(2);
  const allowMobileDataRef = useRef(true);
  const isCellularRef = useRef(false);
  /** طول الملف من فحص HEAD — مرجع احتياطي لحساب النسبة حين يحجب الخادم الطول أثناء البث. */
  const remoteLengthRef = useRef<number | null>(null);
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
      remoteLengthRef.current = remoteInfo.length ?? null;
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
            const expected = remoteLengthRef.current ?? item.totalBytes ?? 0;
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
          : remoteLengthRef.current ?? 0;
        const nextProgress = expected > 0 ? progress.totalBytesWritten / expected : 0;
        if (nextProgress <= 0 || nextProgress >= 1) return;
        const now = Date.now();
        // تحديث لحظي كل ربع ثانية بغض النظر عن حجم القفزة — حتى لا يبدو التقدم متجمداً في الملفات الكبيرة.
        if (now - lastAt < 250) return;
        lastAt = now;
        progressRef.current.set(id, { progress: nextProgress, at: now });
        bytesRef.current.set(id, { bytesWritten: progress.totalBytesWritten, totalBytes: expected > 0 ? expected : undefined });
        patchItem(id, { progress: nextProgress, bytesWritten: progress.totalBytesWritten, totalBytes: expected > 0 ? expected : undefined });
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
            // (v2.0.21) السبب الحقيقي القصير بدل النص القديم المخيف — ويُمسح تلقائياً عند نجاح النسخ.
            else if (lastDeviceSaveError) patchItem(entry.id, { error: `لم يُحفظ في مجلد الجهاز — ${lastDeviceSaveError}` });
            }
          })();
        }

        for (const item of merged) {
          if (item.status === 'downloading' || item.status === 'queued') {
            patchItem(item.id, { status: 'queued', progress: 0, error: undefined });
            enqueue(item.id);
          }
          // المهام المتوقفة تبقى متوقفة كما أوقفها المستخدم — لا تُعاد للتحميل تلقائياً.
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
          for (const type of ['video', 'image', 'voice'] as MediaType[]) {
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
      roots.unshift(await publicDownloadRoot());
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
    safAppRootCache = null;
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
    // (v2.0.21) لا نُرجع رسالة الفحص الخام (توست إنجليزي مخيف) — سبب حقيقي قصير أو رسالة ودّية.
    return { ok: false, message: lastDeviceSaveError
      ? `تعذّر النسخ إلى الجهاز — ${lastDeviceSaveError}`
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
      } else if (lastDeviceSaveError) {
        // (v2.0.21) بدل الصمت: السبب الحقيقي القصير — ويُمسح تلقائياً عند نجاح النسخ لاحقاً.
        patchItem(entry.id, { error: `لم يُحفظ في مجلد الجهاز — ${lastDeviceSaveError}` });
      }
    }
    if (pending.length > 0 && moved === 0) setDeviceSaveNeedsFolder(true);
    return moved;
  }, [patchItem]);

  /**
   * (v2.0.20) يفتح منتقي مجلد الجهاز مرة واحدة (SAF الرسمي) ثم ينسخ فوراً كل ملف
   * بقي داخل التطبيق إلى «المختار / Download Max / النوع». يعيد نجاح العملية.
   */
  const pickDeviceFolderNow = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'web') return false;
    const picked = await pickDeviceDirectory();
    if (!picked) return false;
    if (picked !== downloadDirRef.current) await setDownloadDir(picked);
    await syncPendingToDevice();
    setDeviceSaveNeedsFolder(false);
    return true;
  }, [setDownloadDir, syncPendingToDevice]);

  /**
   * تفعيل الحفظ التلقائي في مجلد التنزيلات الحقيقي بجهاز المستخدم — مرة واحدة فقط:
   * 1) إن سارت صلاحية «الوصول لجميع الملفات» نستخدم «Download/Download Max» بلا أي خطوة.
   * 2) وإلا نفتح منتقي المجلدات الرسمي مرة واحدة ونحفظ اختياره، وبعدها كل تنزيل
   *    جديد ينزل تلقائياً فيه. المستخدم لا يضغط «نسخ» أبداً بعد ذلك.
   */
  const enableDeviceAutoSave = useCallback(async (): Promise<{ ok: boolean; where: string | null; message: string }> => {
    if (await hasStorageAccess()) {
      const root = await publicDownloadRoot();
      if (root) {
        for (const type of ['video', 'image', 'voice'] as MediaType[]) {
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
    // (v2.0.8) المسار الأساسي: «المختار / Download Max / video · image · voice».
    const appRoot = await safAppRoot(picked);
    for (const type of ['video', 'image', 'voice'] as MediaType[]) {
      await safSubfolder(appRoot, subfolderFor(type));
    }
    return { ok: true, where: `${picked}${APP_DIR_NAME}`, message: 'تم — كل تنزيل جديد سيُحفظ في مجلد Download Max تلقائياً ✓' };
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
