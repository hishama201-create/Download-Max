import * as VideoThumbnails from 'expo-video-thumbnails';
import { Platform } from 'react-native';

/**
 * محرك توليد الصور المصغّرة للملفات المكتملة:
 * - الفيديو: لقطة حقيقية من داخل الملف (عند الثانية الثانية، مع fallback للإطار الأول).
 * - الصور: تُعرض الملف نفسه — لا حاجة للتوليد.
 * - الصوت: لا مصغرة من هذا المحرك — يعرض في الواجهة قرص فينيل مصمم بالأنماط.
 */

export async function generateVideoThumbnail(fileUri: string): Promise<string | null> {
  if (Platform.OS === 'web' || !fileUri) return null;
  try {
    // نحاول لقطة عند الثانية الثانية (أجمل من الإطار الأول الأسود أحياناً).
    const result = await VideoThumbnails.getThumbnailAsync(fileUri, { quality: 0.85, time: 2000 });
    return result.uri;
  } catch {
    try {
      // فيديو قصير جداً — إطار البداية.
      const result = await VideoThumbnails.getThumbnailAsync(fileUri, { quality: 0.85 });
      return result.uri;
    } catch {
      return null;
    }
  }
}
