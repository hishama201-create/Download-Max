import type { MediaRequestOptions, MediaType } from './types';
import { isUsableMediaUrl, looksLikeDirectMedia } from './urlHelpers';

/**
 * خدمة تحويل روابط الصفحات إلى روابط وسائط مباشرة.
 * يمكن تغييرها لكل بيئة عبر EXPO_PUBLIC_EXTRACTOR_URL (تُثبَّت وقت البناء).
 */
export const EXTRACTOR_API_URL =
  process.env.EXPO_PUBLIC_EXTRACTOR_URL?.trim() || 'https://api-production-85a7.up.railway.app/';


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

/**
 * يستخرج روابط الوسائط المباشرة من رابط الصفحة.
 * يدعم كاروسيل الصور (تيك توك/إنستجرام/فيسبوك) عبر حقل picker الذي يعيد قائمة بكل الصور.
 * ويمرر جودة الفيديو أو صيغة/معدل الصوت المطلوبة لخدمة الاستخراج.
 */
export async function resolveMediaUrls(sourceUrl: string, options?: MediaRequestOptions): Promise<string[]> {
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
