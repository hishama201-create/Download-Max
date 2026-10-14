import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Directory as NativeDirectory, File as NativeFile } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';
import { Platform, Linking } from 'react-native';
import { setPublicRootProvider } from '@/context/historyDb';
import type { MediaType, DownloadItem } from './types';
import { isYoutubeUrl, fetchYoutubeTitle } from './mediaResolver';

export const SAF_FOLDERS_KEY_PREFIX = '@download-max/saf-folders/';

export function safeFilename(title: string, format: string) {
  // \p{L} يحافظ على الحروف العربية وكل اللغات في اسم الملف.
  const cleaned = title.replace(/[^\p{L}\p{N}\s._-]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'download';
  return `${cleaned}.${format}`;
}

/**
 * (v2.0.17) اسم غير مكرر داخل المجلد: لو الملف موجود يُرقّم تلقائياً
 * «اسم (1).mp4» بدل الكتابة فوق ملف المستخدم القديم.
 */
export async function uniqueFilename(dir: string, filename: string): Promise<string> {
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


export function prettyNameFromUrl(url: string): string | null {
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
export function looksLikeHumanName(name: string): boolean {
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
export async function fetchRemoteFileInfo(mediaUrl: string): Promise<{ filename: string | null; mime: string | null; length: number | null }> {
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
export function extFromMime(mime: string | null): string | null {
  if (!mime) return null;
  const entry = Object.entries(MIME_TYPES).find(([, value]) => value === mime);
  return entry?.[0] ?? null;
}


/** يستنتج نوع الوسائط من نوع MIME الوارد من نظام المشاركة. */
export function typeFromMime(mimeType: string | null): MediaType {
  if (!mimeType) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'video';
}

/** يفصل امتداد الملف من اسمه الأصلي أو من نوع MIME، مع بدائل صالحة دائماً. */
/** اسم المجلد الفرعي حسب نوع الوسيط (تنظيم على طريقة مجلدات التنزيل المعروفة). */
export function subfolderFor(type: MediaType): string {
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  return 'Images';
}

/** اسم مجلد التنزيلات الافتراضي. */
export const APP_DIR_NAME = 'Download Max';
/**
 * (v2.0.12) هيكل Snaptube في جذر التخزين العام — ثابت واحد يغيّر كل شيء:
 * DownloadMax/download/DownloadMax Video|Music|Image (+ DownloadMax/db للسجل).
 */
export const SNAPTUBE_ROOT_NAME = 'DownloadMax';
export const SNAPTUBE_DOWNLOAD_DIR = 'download';
export const SNAPTUBE_VIDEO_DIR = 'DownloadMax Video';
export const SNAPTUBE_MUSIC_DIR = 'DownloadMax Music';
export const SNAPTUBE_IMAGE_DIR = 'DownloadMax Image';
/** (v2.0.18) اسم الألبوم العام في المعرض/ملفات الجهاز — يظهر كـ «Download Max». */
export const ALBUM_NAME = 'Download Max';

/** مجلد النوع في هيكل Snaptube حسب نوع الوسيط. */
export function snaptubeSubfolderFor(type: MediaType): string {
  if (type === 'video') return SNAPTUBE_VIDEO_DIR;
  if (type === 'audio') return SNAPTUBE_MUSIC_DIR;
  return SNAPTUBE_IMAGE_DIR;
}
/**
 * (v2.0.10) هل هذا الرابط يشير لمجلد اسمه «Download Max» أصلاً؟
 * نقرأ معرّف المستند من الرابط (primary:Download Max مثلاً) بعد فك الترميز —
 * لأن الجزء الأخير من روابط SAF قد يكون معرّفاً رقمياً لا اسماً حقيقياً.
 */
export function safUriDisplayName(uri: string): string | null {
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

export function isSafAppRootUri(uri: string): boolean {
  return safUriDisplayName(uri)?.toLowerCase() === APP_DIR_NAME.toLowerCase();
}
/** الجذر العام للتخزين الداخلي في أندرويد — يحتاج صلاحية «الوصول لجميع الملفات». */
export const PUBLIC_ROOT = '/storage/emulated/0/';
/**
 * جذر أرشيف السجل القديم، يُبقى للتوافق مع قاعدة البيانات والملفات السابقة فقط.
 */
export function publicStorageRoot(): string {
  return `${PUBLIC_ROOT}${SNAPTUBE_ROOT_NAME}/`;
}

// (v2.0.12) تزويد موديول قاعدة السجل بمجلد الجذر العام (بلا استيراد دائري).
setPublicRootProvider(() => {
  if (Platform.OS !== 'android') return null;
  return publicStorageRoot();
});
/** مجلد التنزيلات العام في الجهاز. */
export const PUBLIC_DOWNLOAD_DIR = `${PUBLIC_ROOT}Download/`;

/** ملف الاختبار: اسم عادي (أندرويد 11+ يمنع الملفات التي تبدأ بنقطة) وصيغة URI. */
export const PROBE_FILE = `file://${PUBLIC_DOWNLOAD_DIR}download-max-probe.tmp`;

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
export let accessCache: { at: number; reason: string | null } | null = null;

export async function storageAccessError(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  if (accessCache && Date.now() - accessCache.at < 10000) return accessCache.reason;
  const reason = await probeStorageAccess();
  accessCache = { at: Date.now(), reason };
  return reason;
}

export async function probeStorageAccess(): Promise<string | null> {
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
export async function snaptubeTypeDir(type: MediaType): Promise<string | null> {
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
 * (v2.0.22) الحفظ في ألبوم «Download Max» عبر نظام أندرويد الرسمي MediaStore.
 * الإصلاح الجذري: كنا نشترط إذن الوسائط قبل أي محاولة — وهذا الإذن (READ_MEDIA_*)
 * غير معلن في app.json فلا يُمنح على أندرويد 13+ أبداً، فيُتخطى المسار بصمت رغم أن
 * الكتابة في MediaStore لا تحتاج أي إذن على أندرويد 10+ (تأكيد من كود expo نفسه:
 * hasWritePermissions ترجع false على TIRAMISU = لا استثناء أبداً).
 * الآن: محاولة مباشرة أولاً، وطلب الإذن فقط كخطة أخيرة للأجهزة الأقدم.
 */
export async function saveToPublicAlbum(localUri: string, filename: string, type: MediaType): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    let asset = await MediaLibrary.createAssetAsync(localUri).catch((error) => {
      // (v2.0.24) لا نبتلع خطأ المعرض — نسجله حتى نعرف سبب فشل MediaStore الحقيقي.
      noteDeviceSaveError('المعرض (createAsset)', error);
      return null;
    });
    if (!asset) {
      // مسار بديل مباشر: نسخ إلى MediaStore عبر saveToLibraryAsync (بلا أذونات أيضاً).
      const savedDirectly = await MediaLibrary.saveToLibraryAsync(localUri).then(() => true).catch((error) => {
        noteDeviceSaveError('المعرض (saveToLibrary)', error);
        return false;
      });
      if (savedDirectly) return true;
      // فشلت المحاولتان — نطلب الإذن إن أمكن عرضه (أجهزة أقدم) ونعيد المحاولة.
      const current = await MediaLibrary.getPermissionsAsync().catch(() => null);
      if (current?.canAskAgain) {
        const asked = await MediaLibrary.requestPermissionsAsync().catch(() => null);
        if (asked?.granted) {
          asset = await MediaLibrary.createAssetAsync(localUri).catch((error) => {
            noteDeviceSaveError('المعرض (بعد الإذن)', error);
            return null;
          });
          if (!asset) {
            const retried = await MediaLibrary.saveToLibraryAsync(localUri).then(() => true).catch((error) => {
              noteDeviceSaveError('المعرض (بعد الإذن saveToLibrary)', error);
              return false;
            });
            if (retried) return true;
          }
        }
      }
      if (!asset) return false;
    }
    // الملف الآن في المعرض — نجاح ولو فشل تجميعه في ألبوم «Download Max».
    const album = await MediaLibrary.getAlbumAsync(ALBUM_NAME).catch(() => null);
    if (album) await MediaLibrary.addAssetsToAlbumAsync(asset, album, true).catch(() => undefined);
    else await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, true).catch(() => undefined);
    return true;
  } catch (error) {
    noteDeviceSaveError('المعرض', error);
    return false;
  }
}

/** نسخة آمنة من مجلد التنزيلات في تخزين الجهاز: «/storage/emulated/0/Download/Download Max/». */
export async function publicDownloadRoot(): Promise<string> {
  const dir = `${PUBLIC_DOWNLOAD_DIR}${APP_DIR_NAME}/`;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    return '';
  }
  return dir;
}

/**
 * يفتح منتقي مجلدات أندرويد الرسمي (SAF) مرة واحدة — بلا صلاحية «الوصول لجميع الملفات».
 * يُرجع null عند رفض المستخدم أو الإلغاء.
 */
export async function pickDeviceDirectory(): Promise<string | null> {
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
export let safAppRootCache: string | null = null;

export function setSafAppRootCache(uri: string | null): void {
  safAppRootCache = uri;
}

export async function safAppRoot(pickedDirUri: string): Promise<string> {
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
 * 1) مجلد SAF الذي اختاره المستخدم مرة واحدة.
 * 2) Download/Download Max عند منح صلاحية الوصول لجميع الملفات.
 * 3) ألبوم «Download Max» عبر MediaStore كمسار توافق أخير.
 * الأصل يبقى دائماً في مساحة التطبيق (fileUri يشير إليه) — والفشل الكلي لا يعرض أي خطأ.
 */
export async function mirrorToDeviceDownloads(localUri: string, filename: string, type: MediaType, safDir: string | null): Promise<boolean> {
  // (v2.0.21) صفّر سجل الأسباب قبل بدء السلسلة حتى لا يظهر سبب ملف سابق لملف جديد.
  lastDeviceSaveError = null;
  deviceSaveErrorLog = [];
  // ١) المجلد الذي اختاره المستخدم — له الأولوية كي يطابق المسار الظاهر في الإعدادات.
  if (safDir) {
    const appRoot = await safAppRoot(safDir);
    const dir = await safSubfolder(appRoot, subfolderFor(type));
    if (await saveFileToSafDirectory(localUri, filename, mimeFor(filename), dir)) return true;
  } else {
    noteDeviceSaveError('SAF', 'لم يتم اختيار مجلد حفظ في الجهاز');
  }
  // ٢) المسار الموحد في Download عند منح صلاحية التخزين الشاملة.
  if (Platform.OS === 'android' && await hasStorageAccess()) {
    try {
      const root = await publicDownloadRoot();
      if (root) {
        const dir = `${root}${subfolderFor(type)}/`;
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const safeName = await uniqueFilename(dir, filename);
        await FileSystem.copyAsync({ from: localUri, to: `${dir}${safeName}` });
        return true;
      }
    } catch (error) { noteDeviceSaveError('مسار Download', error); /* المسار العام غير متاح أيضاً */ }
  }
  // ٣) ألبوم «Download Max» عبر MediaStore كخيار توافق أخير.
  if (await saveToPublicAlbum(localUri, filename, type)) return true;
  deviceSaveErrorLog.push('المعرض: تعذّر الحفظ في ألبوم Download Max');
  return false;
}

/**
 * يطلب من المستخدم اختيار مجلد التنزيل مرة واحدة (SAF) ويحفظ اختياره بشكل دائم.
 * (إصلاح v2.0.8): سابقاً كان الاختيار يُكتب في مرجع مؤقت فقط فكان يضيع بعد
 * إعادة تشغيل التطبيق ويُطلب من المستخدم من جديد — الآن يمر عبر الحفظ الدائم.
 */
export async function requestAndStoreDeviceDir(
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
export async function findSafChildByName(parentUri: string, name: string): Promise<string | null> {
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

/** ينتقي اسم ملف غير مستخدم داخل مجلد SAF من دون استبدال تنزيل سابق. */
export async function uniqueSafFilename(directoryUri: string, filename: string): Promise<string> {
  if (!(await findSafChildByName(directoryUri, filename))) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    if (!(await findSafChildByName(directoryUri, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

/**
 * (v2.0.12) استعادة أسماء العناصر القديمة المحفوظة كهاش (مثل bd604a8e…):
 * عند فتح التطبيق، أي عنصر مكتمل عنوانه بصمة خادم ونملك رابطه الأصلي نستعلم
 * الخادم مرة واحدة (HEAD) عن اسمه الحقيقي ونحدّث القائمة — القديم يُصحح تلقائياً.
 */
export async function restoreLegacyHashTitles(
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
export let safFoldersKeyCache: string | null = null;
export let safTypeFoldersCache: Map<string, string> | null = null;
/** أقفال الإنشاء: تمنع سباق تهيئة متزامن من إنشاء نفس المجلد مرتين. */
export const safSubfolderInflight = new Map<string, Promise<string>>();

export function clearSafTypeFolderCaches(): void {
  safFoldersKeyCache = null;
  safTypeFoldersCache = null;
  safSubfolderInflight.clear();
}

/** يحمّل روابط مجلدات الأنواع المحفوظة لهذا الجذر من التخزين الدائم. */
export async function loadSafTypeFolders(safDir: string): Promise<Map<string, string>> {
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
export async function persistSafTypeFolders(safDir: string, folders: Map<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(SAF_FOLDERS_KEY_PREFIX + safDir, JSON.stringify(Object.fromEntries(folders)));
  } catch { /* فشل الحفظ غير حرج — الكاش بالذاكرة يكفي للجلسة */ }
}

/** تحقق حي أن رابط المجلد المحفوظ ما زال مقروءاً (لم تنسحب الصلاحية). */
export async function isSafDirAlive(uri: string): Promise<boolean> {
  try {
    await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
    return true;
  } catch { return false; }
}

export async function safSubfolder(directoryUri: string, sub: string): Promise<string> {
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
  for (const type of ['video', 'audio', 'image'] as MediaType[]) {
    await ensureTypeDir(base, type);
  }
  if (Platform.OS === 'android' && await hasStorageAccess()) {
    const publicRoot = await publicDownloadRoot();
    if (publicRoot) {
      for (const type of ['video', 'audio', 'image'] as MediaType[]) {
        const dir = `${publicRoot}${subfolderFor(type)}/`;
        const info = await FileSystem.getInfoAsync(dir).catch(() => null);
        if (!info?.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      }
    }
  }
  // (v2.0.18) الألبوم العام «Download Max» يُنشأ تلقائياً من أول تنزيل عبر MediaStore —
  // لا حاجة لإنشاء مجلدات بالكتابة المباشرة (كانت تفشل بصمت على أجهزة New Architecture).
  return base;
}

/** المسار الفعلي لمجلد التنزيلات المعروض في الإعدادات. */
export async function currentDownloadFolder(): Promise<string> {
  if (Platform.OS === 'android' && (await hasStorageAccess())) {
    const publicRoot = await publicDownloadRoot();
    if (publicRoot) return publicRoot;
  }
  const base = await baseDownloadDir();
  return base ?? FileSystem.documentDirectory ?? '';
}

/**
 * (2) التخزين الآمن: التنزيلات تُحفظ داماً داخل مساحة التطبيق.
 * هذي نفس طريقة سنابتوب: مضمونة 100% وما تعتمد على إذن نظام أبداً.
 * لو حبّ المستخدم يشوف ملفاته في مدير الملفات، يستخدم «نسخ إلى مجلد التنزيلات».
 */
export async function baseDownloadDir(): Promise<string | null> {
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
export async function mediaFilesIn(dir: string, depth = 0): Promise<string[]> {
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
export async function orphanFilesIn(dir: string): Promise<string[]> {
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dir);
    // نتجاهل مجلدات الوسائط الحالية والقديمة عند استعادة الملفات.
    const folders = ['video', 'audio', 'image', 'Video', 'Audio', 'Images', 'Image', 'voice'];
    return names.filter((name) => !name.startsWith('.') && !folders.includes(name));
  } catch {
    return [];
  }
}

/** يستنتج نوع الملف من امتداده: فيديو أو صوت أو صورة. */
export function mediaTypeOf(filename: string): MediaType | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return null;
}

/** يجهز مجلد النوع الفرعي ويعيد المسار مع فاصله. يعيد '' إذا تعذر الإنشاء. */
export async function ensureTypeDir(baseDirectory: string, type: MediaType): Promise<string> {
  try {
    const dir = `${baseDirectory}${subfolderFor(type)}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return dir;
  } catch {
    return '';
  }
}

export function extensionFor(mimeType: string | null, originalName: string | null, type: MediaType) {
  const fromName = originalName?.includes('.') ? originalName.split('.').pop() : null;
  if (fromName && /^[a-z0-9]{2,5}$/i.test(fromName)) return fromName.toLowerCase();
  const fromMime = extFromMime(mimeType);
  if (fromMime) return fromMime;
  // بدائل مضمونة حتى لا يُحفظ الملف أبداً بلا امتداد صالح.
  return type === 'image' ? 'jpg' : type === 'audio' ? 'mp3' : 'mp4';
}

/** حد أقصى لخطة Base64 الاحتياطية — فوقه تنهار ذاكرة JS مع الملفات الكبيرة. */
export const SAF_BASE64_FALLBACK_LIMIT = 24 * 1024 * 1024;

/**
 * (v2.0.21) آخر سبب فشل حقيقي في الحفظ بمجلد الجهاز — يُعرض باختصار بدل الصمت.
 * (v2.0.23) سجل كامل لكل مسار فاشل في السلسلة (AllFiles/SAF/المعرض) — يُعرض تحت
 * الملف كسلسلة أسباب حتى نعرف بالضبط أي أبواب رفضها الجهاز، لا آخر باب فقط.
 */
export let lastDeviceSaveError: string | null = null;
export let deviceSaveErrorLog: string[] = [];
export function noteDeviceSaveError(tag: string, error?: unknown): string {
  const raw = error instanceof Error ? error.message : error ? String(error) : 'غير معروف';
  lastDeviceSaveError = `${tag}: ${raw.length > 110 ? `${raw.slice(0, 110)}…` : raw}`;
  deviceSaveErrorLog.push(lastDeviceSaveError);
  return lastDeviceSaveError;
}
/** (v2.0.23) يبني نص التشخيص الكامل من كل الأبواب الفاشلة في آخر سلسلة نسخ. */
export function deviceSaveErrorSummary(): string | null {
  if (deviceSaveErrorLog.length === 0) return lastDeviceSaveError;
  const joined = deviceSaveErrorLog.slice(0, 3).join(' · ');
  return joined.length > 140 ? `${joined.slice(0, 140)}…` : joined;
}

/**
 * (v2.0.10) تحقق بديل أن مستند SAF الناتج فيه محتوى فعلًا — عبر واجهة الملفات الحديثة.
 */
export async function isSafFileHasContent(safFileUri: string): Promise<boolean> {
  try {
    const size = new NativeFile(safFileUri).size;
    return typeof size === 'number' && size > 0;
  } catch {
    return false;
  }
}

/**
 * (v2.0.24) ينسخ ملفاً محلياً إلى مجلد SAF الذي اختاره المستخدم — بالنمط الصحيح
 * المضمون في كود expo نفسه: نسخ NativeFile (المصدر) ← NativeDirectory (المجلد)
 * مباشرة، بلا إنشاء ملف فارغ مسبقاً.
 *
 * سبب كسر النسخ القديم (v2.0.9–23): كنا ننشئ أولاً ملفاً فارغاً بـ createFileAsync
 * ثم ننسخ المحتوى فوقه — فمع overwrite:false يرمي expo DestinationAlreadyExistsException
 * فوراً (الملف الفارغ موجود أصلاً)، ومع overwrite:true يحذف expo الملف الموجود ثم
 * يكتب في رابط ميت فترمي سامسونج IllegalArgumentException. أما النسخ إلى المجلد نفسه
 * فتجد expo الملف بنفس الاسم، تحذفه عبر SAF عند الاستبدال، ثم تنشئ مستنداً طازجاً
 * بـ createFile وتكتب فيه بتدفق أصلي (copyFileWithChannelFallback) — أي حجم بلا مشاكل.
 */
export async function saveFileToSafDirectory(localUri: string, filename: string, mimeType: string, directoryUri: string): Promise<boolean> {
  try {
    const targetDir = new NativeDirectory(directoryUri);
    let destinationName = await uniqueSafFilename(directoryUri, filename);
    const tempRoot = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    if (!tempRoot) throw new Error('لا يتوفر مجلد مؤقت لإعداد نسخة SAF');
    let copied = false;
    for (let attempt = 0; attempt < 4 && !copied; attempt += 1) {
      let sourceUri = localUri;
      let tempUri: string | null = null;
      try {
        // NativeFile.copy يأخذ اسم المصدر؛ عند تصادم الاسم ننسخ مؤقتاً إلى اسم
        // فريد حتى تصل النسخة إلى SAF بالاسم الجديد، لا فوق الملف السابق.
        if (destinationName !== filename) {
          const tempName = await uniqueFilename(tempRoot, `DownloadMax-${Date.now()}-${destinationName}`);
          tempUri = `${tempRoot}${tempName}`;
          await FileSystem.copyAsync({ from: localUri, to: tempUri });
          sourceUri = tempUri;
        }
        await new NativeFile(sourceUri).copy(targetDir, { overwrite: false });
        copied = true;
      } catch (copyError) {
        noteDeviceSaveError('نسخ SAF بلا استبدال', copyError);
        const alternative = await uniqueSafFilename(directoryUri, destinationName);
        if (alternative === destinationName) break;
        destinationName = alternative;
      } finally {
        if (tempUri) await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => undefined);
      }
    }
    if (copied) {
      const child = await findSafChildByName(directoryUri, destinationName);
      if (child && await isSafFileHasContent(child)) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (child && await isSafFileHasContent(child)) return true;
    }
    // خطة Base64 الأخيرة عبر مستند جديد طازج باسم فريد — للملفات الصغيرة فقط
    // (كتابة مستند SAF موجود غير موثوقة على سامسونج: canWrite قد ترجع false).
    const info = await FileSystem.getInfoAsync(localUri).catch(() => null);
    const size = info?.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
    if (size > 0 && size <= SAF_BASE64_FALLBACK_LIMIT) {
      try {
        const fallbackName = await uniqueSafFilename(directoryUri, destinationName);
        const baseName = fallbackName.replace(/\.[^.]+$/, '') || 'download';
        const ext = (fallbackName.split('.').pop() || 'bin').toLowerCase();
        const fallbackUri = await FileSystem.StorageAccessFramework.createFileAsync(
          directoryUri,
          `${baseName}.${ext}`,
          mimeType,
        );
        const data = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
        await FileSystem.writeAsStringAsync(fallbackUri, data, { encoding: FileSystem.EncodingType.Base64 });
        return true;
      } catch (base64Error) {
        noteDeviceSaveError('نسخ SAF (Base64)', base64Error);
      }
    }
    return false;
  } catch (error) {
    noteDeviceSaveError('حفظ ملف SAF', error);
    // فشل الحفظ في المجلد المختار — يبقى الملف في مجلد التطبيق.
    return false;
  }
}

/** أنواع MIME الصحيحة لكل صيغة حتى يفتح Android الملف بالتطبيق المناسب. */
export const MIME_TYPES: Record<string, string> = {
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

export const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', '3gp']);
export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);
export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic']);

export function mimeFor(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? '*/*';
}
