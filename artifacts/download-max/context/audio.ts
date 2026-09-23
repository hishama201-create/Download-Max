import { FFmpegKit, FFprobeKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * محرك تحويل الفيديو إلى صوت (استخراج المسار الصوتي) عبر FFmpeg المدمج.
 * - الصيغ المدعومة: MP3 و M4A (AAC) — كلاهما يُشغَّل على كل الأجهزة.
 * - يحافظ على البِت ريت الأصلي للمصدر عند النسخ المباشر، ويستخدم جودة عالية عند إعادة الترميز.
 */

export type AudioFormat = 'mp3' | 'm4a';

const TMP_DIR = `${FileSystem.documentDirectory ?? ''}audio-tmp/`;

/** يزيل بادئة file:// لأن FFmpeg يتعامل مع مسارات مطلقة مباشرة. */
function nativePath(uri: string) {
  return uri.replace(/^file:\/\//, '');
}

/** ينظف اسم الملف من المحارف الخطرة على نظام الملفات مع الحفاظ على العربية. */
export function safeAudioName(title: string) {
  return title
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'audio';
}

/** يفحص أن الملف فيديو حقيقي قابل للتحويل (موجود وحجمه أكبر من صفر). */
export async function canExtractAudio(fileUri: string): Promise<boolean> {
  if (Platform.OS === 'web' || !fileUri) return false;
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    return info.exists && 'size' in info && typeof info.size === 'number' && info.size > 0;
  } catch {
    return false;
  }
}

/** يقرأ مدة المقطع الصوتي بالثواني عبر FFprobe، أو يعيد 0 عند الفشل. */
async function probeDuration(path: string): Promise<number> {
  try {
    const session = await FFprobeKit.getMediaInformation(nativePath(path));
    const info = await session.getMediaInformation();
    const duration = Number(info?.getDuration?.() ?? 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

/** يشغّل أمر FFmpeg ويعيد نجاحه. */
async function runFfmpeg(command: string): Promise<boolean> {
  const session = await FFmpegKit.execute(command);
  const code = await session.getReturnCode();
  return !!code && ReturnCode.isSuccess(code);
}

export type ExtractAudioResult = {
  ok: boolean;
  /** مسار الملف الصوتي الناتج (بصيغة file://) أو null عند الفشل. */
  fileUri: string | null;
  /** حجم الملف الناتج بالبايت، أو undefined عند تعذر القراءة. */
  size?: number;
  /** رسالة خطأ مفهومة عند الفشل. */
  error?: string;
};

/**
 * يستخرج المسار الصوتي من فيديو محلي ويحوّله إلى MP3 أو M4A.
 * - MP3: إعادة ترميز بجودة عالية (192k) — أوسع توافق ممكن.
 * - M4A: نسخ المسار الصوتي الأصلي (AAC) كما هو بلا فقدان جودة إن كان AAC، وإلا إعادة ترميز.
 * onProgress يُستدعى برسالة حالة لعرضها للمستخدم.
 */
export async function extractAudioFromVideo(input: {
  videoUri: string;
  title: string;
  format: AudioFormat;
  onProgress?: (message: string) => void;
}): Promise<ExtractAudioResult> {
  const { videoUri, title, format, onProgress } = input;
  if (Platform.OS === 'web') return { ok: false, fileUri: null, error: 'التحويل متاح في تطبيق أندرويد فقط.' };
  if (!(await canExtractAudio(videoUri))) {
    return { ok: false, fileUri: null, error: 'ملف الفيديو غير موجود أو تالف.' };
  }

  onProgress?.('جارٍ تحضير التحويل...');
  try {
    await FileSystem.makeDirectoryAsync(TMP_DIR, { intermediates: true }).catch(() => undefined);
    const baseName = safeAudioName(title);
    // اسم مؤقت فريد لتجنب الكتابة فوق ملف سابق بنفس الاسم.
    const stamp = Date.now();
    const tempOutput = `${TMP_DIR}${stamp}-${baseName}.${format}`;

    const videoPath = nativePath(videoUri);
    const outputPath = nativePath(tempOutput);

    onProgress?.('جارٍ تحليل الفيديو...');
    const duration = await probeDuration(videoPath);

    // أمر التحويل: نستخرج المسار الصوتي فقط (-vn) مع أفضل جودة ممكنة.
    const codecArgs = format === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', '192k'] // إعادة ترميز MP3 بجودة عالية
      : ['-c:a', 'copy']; // M4A: نسخ AAC الأصلي بلا فقدان (وإن لم يكن AAC يفشل ونعيد الترميز)

    const command = [
      '-y',
      '-i', `'${videoPath}'`,
      '-vn', // بدون الفيديو — صوت فقط
      ...codecArgs,
      // نقتطع حتى نهاية التسجيل الأصلي لتجنب ملفات أطول من المصدر عند النسخ المباشر.
      ...(duration > 0 ? ['-t', duration.toFixed(3)] : []),
      '-map_metadata', '0', // نقل وسوم الملف (العنوان...) إن وُجدت
      '-movflags', '+faststart',
      `'${outputPath}'`,
    ].join(' ');

    onProgress?.(duration > 30 ? 'جارٍ التحويل... قد يستغرق قليلاً' : 'جارٍ التحويل...');
    let ok = await runFfmpeg(command);

    // فشل النسخ المباشر (المصدر ليس AAC) — نعيد الترميز بجودة عالية.
    if (!ok && format === 'm4a') {
      const reencode = [
        '-y',
        '-i', `'${videoPath}'`,
        '-vn',
        '-c:a', 'aac', '-b:a', '192k',
        ...(duration > 0 ? ['-t', duration.toFixed(3)] : []),
        '-movflags', '+faststart',
        `'${outputPath}'`,
      ].join(' ');
      ok = await runFfmpeg(reencode);
    }

    if (!ok) {
      return { ok: false, fileUri: null, error: 'فشل التحويل — صيغة الفيديو غير مدعومة. جرّب MP3.' };
    }

    const info = await FileSystem.getInfoAsync(tempOutput);
    if (!info.exists || ('size' in info && info.size === 0)) {
      return { ok: false, fileUri: null, error: 'فشل التحويل — لم يُنتج FFmpeg ملفاً صالحاً.' };
    }

    onProgress?.('تم التحويل ✓');
    return { ok: true, fileUri: tempOutput, size: 'size' in info ? info.size : undefined };
  } catch {
    return { ok: false, fileUri: null, error: 'حدث خطأ غير متوقع أثناء التحويل.' };
  }
}
