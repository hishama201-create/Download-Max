/** يحاول استخراج اسم ملف مقروء من مسار الرابط المباشر. */
/**
 * (v2.0.16) بعض خدمات الاستخراج ترجع رابطاً وهمياً (مثل link.invalid) بدل رابط حقيقي،
 * فيبدأ التنزيل ويفشل بلا أمل وتكرار المحاولة يفشل بنفس الشكل. نرفضه مبكراً برسالة واضحة.
 */
export function isUsableMediaUrl(url: string): boolean {
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

export function looksLikeDirectMedia(url: string) {
  return /\.(mp4|webm|mov|m4v|mp3|m4a|wav|aac|jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
}
