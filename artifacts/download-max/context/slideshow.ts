import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';

/**
 * توليد فيديو عرض تقديمي (Slideshow) من صور الكاروسيل والموسيقى المرفقة.
 * مثل منشورات تيك توك المصورة: الصور تتعاقب مع مدة موسيقى المنشور وتُركّب فيديو MP4 حقيقياً على الجهاز.
 */

export type SlideshowBundle = {
  images: string[];
  music: string | null;
};

const TMP_DIR = `${FileSystem.documentDirectory ?? ''}slideshow-tmp/`;

/** يجلب بيانات المنشور المختلط (الصور + الموسيقى) من خدمة احتياطية قابلة للتبديل عبر متغير البيئة. */
export async function fetchSlideshowBundle(sourceUrl: string): Promise<SlideshowBundle> {
  if (Platform.OS === 'web' || !/^https?:\/\//i.test(sourceUrl)) return { images: [], music: null };
  try {
    const fallbackBase = process.env.EXPO_PUBLIC_SLIDESHOW_FALLBACK_URL?.trim() || 'https://tikwm.com/api/';
    const response = await fetch(`${fallbackBase}?url=${encodeURIComponent(sourceUrl)}&hd=1`);
    if (!response.ok) return { images: [], music: null };
    const payload = await response.json();
    const data = payload?.data ?? {};
    const images: string[] = Array.isArray(data.images)
      ? data.images.filter((entry: unknown): entry is string => typeof entry === 'string' && !!entry)
      : [];
    const music: string | null = typeof data.music === 'string' && data.music ? data.music : null;
    return { images, music };
  } catch {
    return { images: [], music: null };
  }
}

/** يزيل بادئة file:// لأن FFmpeg يتعامل مع مسارات مطلقة مباشرة. */
function nativePath(uri: string) {
  return uri.replace(/^file:\/\//, '');
}

/** يشغّل أمر FFmpeg ويعيد نجاحه. */
async function runFfmpeg(command: string): Promise<boolean> {
  const session = await FFmpegKit.execute(command);
  const code = await session.getReturnCode();
  return !!code && ReturnCode.isSuccess(code);
}

/** يقرأ مدة المقطع الصوتي بالثواني عبر FFprobe، أو يعيد 0 عند الفشل. */
async function probeAudioDuration(path: string): Promise<number> {
  try {
    const session = await (await import('@wokcito/ffmpeg-kit-react-native')).FFprobeKit.getMediaInformation(nativePath(path));
    const info = await session.getMediaInformation();
    const duration = Number(info?.getDuration?.() ?? 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

/**
 * يولّد فيديو MP4 من الصور والموسيقى:
 * - كل صورة تظهر لمدة متساوية تغطي طول الموسيقى (أو 3 ثوانٍ بلا موسيقى).
 * - الصور تُوسَّط بمقاس 720×1280 مع خلفية سوداء، 30 إطاراً/ثانية.
 * يعيد مسار الملف الناتج أو null عند الفشل.
 */
export async function generateSlideshowVideo(input: {
  images: string[];
  music: string | null;
  title: string;
  onProgress?: (message: string) => void;
}): Promise<string | null> {
  const { images, music, title, onProgress } = input;
  if (images.length === 0) return null;
  onProgress?.('جارٍ تحضير التوليد...');
  await FileSystem.makeDirectoryAsync(TMP_DIR, { intermediates: true }).catch(() => undefined);

  try {
    // 1) تنزيل الصور محلياً بالترتيب
    const imagePaths: string[] = [];
    for (let index = 0; index < images.length; index++) {
      onProgress?.(`جارٍ تنزيل الصور (${index + 1}/${images.length})...`);
      const target = `${TMP_DIR}img-${index}.jpg`;
      const result = await FileSystem.downloadAsync(images[index], target);
      if (result.status !== 200) return null;
      imagePaths.push(nativePath(result.uri));
    }

    // 2) تنزيل الموسيقى إن وُجدت وحساب مدة كل صورة
    let audioPath: string | null = null;
    let perImage = 3;
    if (music) {
      onProgress?.('جارٍ تنزيل الموسيقى...');
      const audioTarget = `${TMP_DIR}audio-src`;
      const result = await FileSystem.downloadAsync(music, audioTarget);
      if (result.status === 200) {
        audioPath = nativePath(result.uri);
        const duration = await probeAudioDuration(audioPath);
        if (duration > 0) perImage = Math.max(1, Math.min(10, duration / images.length));
      }
    }

    // 3) ملف قائمة concat مع مدة كل صورة (تكرار الأخيرة حتى تُطبَّق مدتها)
    const listPath = `${TMP_DIR}list.txt`;
    const lines = ['ffconcat version 1.0'];
    for (const path of imagePaths) {
      lines.push(`file '${path}'`);
      lines.push(`duration ${perImage.toFixed(3)}`);
    }
    lines.push(`file '${imagePaths[imagePaths.length - 1]}'`);
    await FileSystem.writeAsStringAsync(listPath, lines.join('\n'), { encoding: FileSystem.EncodingType.UTF8 });

    // 4) تركيب الفيديو: MPEG-4 مدعوم عالمياً + AAC للموسيقى
    const safeTitle = title.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().slice(0, 48) || 'slideshow';
    const outputPath = nativePath(`${TMP_DIR}${safeTitle}.mp4`);
    onProgress?.('جارٍ تركيب الفيديو...');
    const command = [
      '-y',
      '-f', 'concat', '-safe', '0', '-i', `'${listPath}'`,
      ...(audioPath ? ['-i', `'${audioPath}'`] : []),
      '-c:v', 'mpeg4', '-q:v', '4',
      '-vf', 'fps=30,scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black',
      '-pix_fmt', 'yuv420p',
      ...(audioPath ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : ['-an']),
      '-movflags', '+faststart',
      `'${outputPath}'`,
    ].join(' ');

    const ok = await runFfmpeg(command);
    if (!ok) return null;
    const info = await FileSystem.getInfoAsync(`${TMP_DIR}${safeTitle}.mp4`);
    if (!info.exists || ('size' in info && info.size === 0)) return null;
    return `${TMP_DIR}${safeTitle}.mp4`;
  } catch {
    return null;
  }
}

/** ينظّف مجلد الملفات المؤقت بعد التوليد أو الفشل. */
export async function cleanupSlideshowTemp(keepFile?: string | null) {
  try {
    const entries = await FileSystem.readDirectoryAsync(TMP_DIR);
    for (const entry of entries) {
      const full = `${TMP_DIR}${entry}`;
      if (keepFile && full === keepFile) continue;
      await FileSystem.deleteAsync(full, { idempotent: true });
    }
  } catch {
    // المجلد غير موجود — لا شيء للتنظيف
  }
}
