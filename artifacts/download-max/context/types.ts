// أنواع مشتركة بين ملفات التنزيل (نُقلت من DownloadContext.tsx بدون أي تغيير في المنطق).
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
export type MediaType = 'video' | 'audio' | 'image';

/** خيارات طلب الاستخراج: جودة الفيديو أو صيغة/معدل الصوت. */
export type MediaRequestOptions =
  | { mode: 'video'; videoQuality?: string }
  | { mode: 'audio'; audioFormat?: string; audioBitrate?: string }
  | { mode: 'image' };

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
