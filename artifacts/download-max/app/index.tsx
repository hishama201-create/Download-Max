import { Feather } from '@expo/vector-icons';
import Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import * as FileSystem from 'expo-file-system/legacy';
import { useIncomingShare } from 'expo-sharing';
import { cleanupSlideshowTemp, fetchSlideshowBundle, generateSlideshowVideo } from '../context/slideshow';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DownloadItem, MediaType, useDownloads, previewCarouselImages } from '@/context/DownloadContext';
import { AccentKey, accentSwatches, MaxTasks, ThemeMode, useAppSettings } from '@/context/SettingsContext';

const formats: Record<MediaType, { format: string; label: string; detail: string }[]> = {
  video: [
    { format: 'mp4', label: 'فيديو MP4', detail: 'توافق واسع' },
    { format: 'webm', label: 'فيديو WebM', detail: 'حجم أصغر' },
  ],
  audio: [
    { format: 'mp3', label: 'صوت MP3', detail: 'يعمل على كل الأجهزة' },
    { format: 'm4a', label: 'صوت M4A', detail: 'جودة أفضل' },
  ],
  image: [
    { format: 'jpg', label: 'صورة JPG', detail: 'مشاركة سهلة' },
    { format: 'png', label: 'صورة PNG', detail: 'جودة عالية' },
  ],
};

/** خيارات جودة الفيديو (تُرسل لخدمة الاستخراج كـ videoQuality). */
const videoQualities = [
  { value: '1080', label: '1080p', detail: 'أفضل جودة HD' },
  { value: '720', label: '720p', detail: 'جودة عالية' },
  { value: '480', label: '480p', detail: 'جودة متوسطة' },
  { value: '360', label: '360p', detail: 'توفير البيانات' },
  { value: '240', label: '240p', detail: 'حجم صغير' },
  { value: '144', label: '144p', detail: 'أصغر حجم' },
];

/** خيارات معدل الصوت (تُرسل لخدمة الاستخراج كـ audioBitrate). */
const audioBitrates = [
  { value: '320', label: '320K', detail: 'أعلى جودة — حجم أكبر' },
  { value: '256', label: '256K', detail: 'جودة ممتازة' },
  { value: '160', label: '160K', detail: 'جودة جيدة جداً' },
  { value: '128', label: '128K', detail: 'الأفضل للجوال — متوازن' },
  { value: '70', label: '70K', detail: 'أصغر حجم — للسماعات' },
];

/** خيارات نافذة المزيد من الصيغ: أزواج (اسم عرض، قيمة تنسيق). */
function qualityChoices(type: MediaType) {
  if (type === 'video') {
    return [
      ...videoQualities.map((q) => ({ format: `mp4-${q.value}`, label: q.label, detail: q.detail })),
      ...videoQualities.filter((q) => ['1080', '720', '480'].includes(q.value)).map((q) => ({ format: `webm-${q.value}`, label: `${q.label} WebM`, detail: q.detail })),
    ];
  }
  if (type === 'audio') {
    return [
      ...['mp3', 'm4a'].flatMap((fmt) => audioBitrates.map((b) => ({ format: `${fmt}-${b.value}`, label: `${fmt.toUpperCase()} ${b.label}`, detail: b.detail }))),
    ];
  }
  return formats.image.map((entry) => ({ format: entry.format, label: entry.label, detail: entry.detail }));
}

const typeLabels: Record<MediaType, string> = { video: 'فيديو', audio: 'صوت', image: 'صورة' };
const typeIcons: Record<MediaType, keyof typeof Feather.glyphMap> = { video: 'video', audio: 'headphones', image: 'image' };

/** يحوّل المحارف الخفية (اتجاه RTL/أصفار العرض) إلى فراغات حتى لا تلتصق بالروابط. */
function stripInvisibleChars(value: string) {
  return value.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ');
}

/** يستخرج رابطاً صالحاً من نص مشاركة: يدعم الروابط المقسمة والنطاقات بلا بروتوكول ويوحد روابط يوتيوب. */
function extractUrl(value: string) {
  const cleaned = stripInvisibleChars(value).trim();
  // 1) رابط كامل ببروتوكول: نلتقط حتى فراغ حقيقي.
  const full = cleaned.match(/https?:\/\/[^\s]+/i)?.[0];
  if (full) {
    const candidate = full.replace(/[,);.!]+$/, '');
    // روابط يوتيوب المقطوعة: youtu.be/ID&si=... أو watch?v=ID&... بمعرف ناقص — نصلحها إن أمكن.
    const fixed = fixIncompleteYoutubeUrl(candidate) ?? candidate;
    return fixed;
  }
  // 2) نطاق بلا بروتوكول (youtu.be/xxx، tiktok.com/...): نلتقطه ونعيد بناءه.
  const bare = cleaned.match(/((?:www\.|m\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|soundcloud\.com|twitter\.com|x\.com)\/[^\s]+)/i)?.[1];
  if (bare) {
    const candidate = bare.replace(/[,);.!]+$/, '');
    const fixed = fixIncompleteYoutubeUrl(`https://${candidate}`) ?? `https://${candidate}`;
    return fixed;
  }
  return cleaned;
}

/**
 * يصلح روابط يوتيوب الناقصة الشائعة من المشاركة:
 * - معرف أقل من 11 حرفاً في youtu.be أو watch?v= → نحاول استخراج المعرف الصحيح من أي جزء آخر في النص.
 * - الرابط الذي يبدأ بـ "&" أو ينتهي قبل معاملاته → نعيد تركيبه.
 * يعيد الرابط المصحح أو null إذا لم يُمكن الإصلاح.
 */
function fixIncompleteYoutubeUrl(candidate: string): string | null {
  const ytIdPattern = /^[A-Za-z0-9_-]{11}$/;
  const youtuMatch = candidate.match(/youtu\.be\/([A-Za-z0-9_-]+)/i);
  const watchMatch = candidate.match(/[?&]v=([A-Za-z0-9_-]+)/i);
  const currentId = youtuMatch?.[1] ?? watchMatch?.[1] ?? null;
  if (currentId && ytIdPattern.test(currentId)) return null; // المعرّف صحيح أصلاً
  if (!currentId) return null; // ليس رابط يوتيوب مقطوعاً
  return candidate; // معرّف ناقص — يعاد كما هو ليُعرض خطأ واضح للمستخدم لاحقاً
}

/** هل الرابط رابط يوتيوب بمعرّف ناقص (أقل من 11 حرفاً)؟ */
function isIncompleteYoutubeUrl(url: string): boolean {
  const youtuMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]+)/i);
  const watchMatch = url.match(/[?&]v=([A-Za-z0-9_-]+)/i);
  const id = youtuMatch?.[1] ?? watchMatch?.[1] ?? null;
  return !!id && !/^[A-Za-z0-9_-]{11}$/.test(id);
}

function domainFor(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'رابط جديد';
  }
}

function guessedTitle(url: string) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/[-_]+/g, ' ').slice(0, 48) : 'ملف من الإنترنت';
  } catch {
    return 'ملف من الإنترنت';
  }
}

/** يخمّن نوع الوسيط من الرابط: امتداد الملف في المسار أو نطاق موقع معروف. يعيد null إن لم يستطع التحديد. */
function guessMediaTypeFromUrl(url: string): MediaType | null {
  let path = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.replace(/^www\./, '');
    // نطاقات معروفة بنوعها بغض النظر عن الامتداد (إنستغرام/بينترست صور عادةً، ويوتيوب وتيك توك فيديو...).
    if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|dai\.ly|tiktok\.com|twitter\.com|x\.com|twitch\.tv|facebook\.com|fb\.watch)$/.test(host)) return 'video';
    if (/(^|\.)(soundcloud\.com|spotify\.com|audiomack\.com|anchor\.fm)$/.test(host)) return 'audio';
    if (/(^|\.)(imgur\.com|flickr\.com|pinterest\.com|pin\.it|unsplash\.com|500px\.com|instagram\.com)$/.test(host)) return 'image';
  } catch {
    return null;
  }
  const last = path.split('/').filter(Boolean).pop() ?? '';
  if (/\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif)$/.test(last)) return 'image';
  if (/\.(mp4|m4v|webm|mov|mkv|avi|3gp|flv|ts)$/.test(last)) return 'video';
  if (/\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|wma)$/.test(last)) return 'audio';
  return null;
}

/** هل الرابط ملف وسائط مباشر (ينتهي بامتداد صورة/فيديو/صوت)؟ هؤلاء يُفتحون فوراً بدون فحص شبكة. */
function isDirectMediaLink(url: string): boolean {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif|mp4|m4v|webm|mov|mkv|avi|3gp|flv|ts|mp3|m4a|wav|aac|ogg|oga|opus|flac|wma)$/i.test(last);
  } catch {
    return false;
  }
}

function formatBytes(value?: number) {
  if (!value) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function percentLabel(item: DownloadItem) {
  const percent = Math.min(Math.floor(item.progress * 100), 99);
  return `${percent}%`;
}

/** يعرض اسم مجلد التنزيل المختار بصيغة مقروءة من SAF URI. */
function dirLabel(uri: string) {
  try {
    const decoded = decodeURIComponent(uri);
    const afterColon = decoded.includes(':') ? decoded.split(':').pop() ?? '' : decoded;
    const segment = afterColon.split('/').filter(Boolean).pop();
    return segment || 'مجلد مخصص';
  } catch {
    return 'مجلد مخصص';
  }
}

function useSafeIncomingShare() {
  if (Platform.OS === 'web') {
    return {
      resolvedSharedPayloads: [] as { contentUri: string | null; contentType: string | null; contentMimeType: string | null; originalName: string | null; value: string }[],
      clearSharedPayloads: () => undefined,
    };
  }
  return useIncomingShare();
}

/** يخمن نوع MIME من امتداد الملف لمشاركته بنوع صحيح. */
function mimeFromFile(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video/mp4';
  if (['mp3', 'm4a', 'wav', 'aac'].includes(ext)) return 'audio/mpeg';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return '*/*';
}

// ————— يوتيوب: بحث حقيقي عبر Data API v3 —————

type YoutubeVideo = { id: string; title: string; channel: string; thumbnail: string; views: string; duration: string };

/** تنسيق مدة الفيديو من صيغة ISO-8601 (PT4M13S) إلى 4:13. */
function formatIsoDuration(iso: string) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const [, h, m, s] = match;
  const hours = h ? `${h}:` : '';
  const minutes = m ? `${h ? m!.padStart(2, '0') : m}:` : h ? '00:' : '';
  const seconds = s ? s.padStart(2, '0') : '00';
  return `${hours}${minutes}${seconds}`;
}

async function searchYoutube(query: string, apiKey: string, signal?: AbortSignal): Promise<YoutubeVideo[]> {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const searchResponse = await fetch(searchUrl, { signal });
  if (!searchResponse.ok) throw new Error('تعذر الوصول إلى يوتيوب. تحقق من الاتصال.');
  const searchData = await searchResponse.json();
  const videos: { id: { videoId?: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url: string } } } }[] = searchData.items ?? [];
  const ids = videos.map((entry) => entry.id.videoId).filter(Boolean).join(',');
  if (!ids) return [];
  let details: Record<string, { items?: { id: string; statistics?: { viewCount?: string }; contentDetails?: { duration?: string } }[] }> = {};
  try {
    const detailsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${ids}&key=${apiKey}`, { signal });
    if (detailsResponse.ok) details = await detailsResponse.json();
  } catch {
    // التفاصيل اختيارية — البحث يكفي
  }
  return videos
    .filter((entry) => entry.id.videoId)
    .map((entry) => {
      const id = entry.id.videoId!;
      const extra = details[id]?.items?.[0];
      const viewCount = extra?.statistics?.viewCount;
      return {
        id,
        title: entry.snippet.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
        channel: entry.snippet.channelTitle,
        thumbnail: entry.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        views: viewCount ? `${new Intl.NumberFormat('ar', { notation: 'compact' }).format(Number(viewCount))} مشاهدة` : '',
        duration: extra?.contentDetails?.duration ? formatIsoDuration(extra.contentDetails.duration) : '',
      };
    });
}

function YoutubePanel({ colors, onBack, onDownload, notice }: {
  colors: Palette;
  onBack: () => void;
  onDownload: (videoUrl: string) => void;
  notice: string;
}) {
  const apiKey = 'AIzaSyDVZgxxaq37dDj5wQ9wQrPO4Oumju4gI44';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YoutubeVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());

  async function runSearch(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const found = await searchYoutube(trimmed, apiKey);
      setResults(found);
      if (found.length === 0) setError('لا توجد نتائج لهذا البحث');
    } catch {
      setError('تعذر البحث. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setLoading(false);
    }
  }

  function handleDownload(video: YoutubeVideo) {
    setDownloadingIds((current) => new Set(current).add(video.id));
    onDownload(`https://www.youtube.com/watch?v=${video.id}`);
    setTimeout(() => {
      setDownloadingIds((current) => {
        const next = new Set(current);
        next.delete(video.id);
        return next;
      });
    }, 2500);
  }

  return <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
    <View style={styles.panelHeader}>
      <Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable>
      <Text style={[styles.panelTitle, { color: colors.foreground }]}>يوتيوب</Text>
      <View style={[styles.ytBadge, { backgroundColor: `${colors.destructive}16` }]}><Feather name="youtube" size={17} color={colors.destructive} /></View>
    </View>
    <View style={[styles.ytSearchWrap, { backgroundColor: colors.background, borderColor: colors.input }]}>
      <Feather name="search" size={17} color={colors.mutedForeground} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void runSearch(query)}
        placeholder="ابحث عن فيديو أو أغنية..."
        placeholderTextColor={colors.mutedForeground}
        style={[styles.searchInput, { color: colors.foreground }]}
        returnKeyType="search"
      />
      <Pressable onPress={() => void runSearch(query)} disabled={loading} style={[styles.ytSearchButton, { backgroundColor: colors.primary }]}>
        {loading ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Feather name="search" size={15} color={colors.primaryForeground} />}
      </Pressable>
    </View>
    {error ? <Text style={[styles.ytError, { color: colors.destructive }]}>{error}</Text> : null}
    <FlatList
      data={results}
      keyExtractor={(item) => item.id}
      style={styles.ytList}
      contentContainerStyle={results.length === 0 ? styles.ytListEmpty : undefined}
      ListEmptyComponent={
        loading ? null : (
          <View style={styles.ytEmpty}>
            <View style={[styles.ytEmptyIcon, { backgroundColor: `${colors.destructive}12` }]}><Feather name="youtube" size={30} color={colors.destructive} /></View>
            <Text style={[styles.ytEmptyTitle, { color: colors.foreground }]}>ابحث وحمّل من يوتيوب</Text>
            <Text style={[styles.ytEmptyHint, { color: colors.mutedForeground }]}>اكتب اسم أغنية أو فيديو واضغط البحث، ثم حمّل ما يعجبك مباشرة</Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <View style={[styles.ytRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.ytThumbWrap}>
            <Image source={{ uri: item.thumbnail }} style={styles.ytThumb} resizeMode="cover" />
            {item.duration ? <View style={styles.ytDuration}><Text style={styles.ytDurationText}>{item.duration}</Text></View> : null}
          </View>
          <View style={styles.ytBody}>
            <Text style={[styles.ytTitle, { color: colors.cardForeground }]} numberOfLines={2}>{item.title}</Text>
            <Text style={[styles.ytMeta, { color: colors.mutedForeground }]} numberOfLines={1}>{item.channel}{item.views ? ` · ${item.views}` : ''}</Text>
          </View>
          <Pressable
            accessibilityLabel={`تحميل ${item.title}`}
            onPress={() => handleDownload(item)}
            disabled={downloadingIds.has(item.id)}
            style={[styles.ytDownloadButton, { backgroundColor: downloadingIds.has(item.id) ? colors.muted : colors.primary }]}
          >
            {downloadingIds.has(item.id)
              ? <ActivityIndicator size="small" color={colors.primaryForeground} />
              : <Feather name="download" size={17} color={colors.primaryForeground} />}
          </Pressable>
        </View>
      )}
    />
  </Pressable>;
}

function DownloadRow({ item, onRetry, onPause, onResume, onRemove, onShare, onOpen, onVault, onMore, selected, onSelect }: {
  item: DownloadItem;
  onRetry: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
  onShare: () => void;
  onOpen: () => void;
  onVault: () => void;
  onMore: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const colors = useColors();
  const isActive = item.status === 'downloading' || item.status === 'queued';
  const isPaused = item.status === 'paused';
  const iconColor = item.status === 'completed' ? colors.accentForeground : item.status === 'failed' ? colors.destructive : isPaused ? colors.mutedForeground : colors.primary;
  const statusLabel = item.status === 'completed'
    ? 'اكتمل'
    : item.status === 'failed'
      ? 'تعذر التحميل'
      : isPaused
        ? `متوقف مؤقتاً · ${percentLabel(item)}`
        : isActive
          ? `جارٍ التحميل · ${percentLabel(item)}`
          : 'في الانتظار';
  return (
    <Pressable
      onLongPress={onSelect}
      delayLongPress={350}
      onPress={item.status === 'completed' && item.fileUri ? onOpen : undefined}
      style={[styles.downloadRow, { backgroundColor: colors.card, borderColor: selected ? colors.primary : colors.border, borderWidth: selected ? 1.6 : 1 }]}
    >
      {selected ? (
        <View style={[styles.selectionCheck, { backgroundColor: colors.primary }]}>
          <Feather name="check" size={13} color="#fff" />
        </View>
      ) : null}
      {item.status === 'completed' && item.thumbnailUri ? (
        <View style={[styles.fileThumbWrap, { backgroundColor: colors.muted }]}>
          <Image source={{ uri: item.thumbnailUri }} style={styles.fileThumbImage} resizeMode="cover" />
          {item.type === 'video' ? (
            <View style={styles.fileThumbBadge}>
              <Feather name="play" size={10} color="#fff" />
            </View>
          ) : null}
        </View>
      ) : item.status === 'completed' && item.type === 'audio' ? (
        <View style={[styles.vinylDisc, { backgroundColor: colors.background }]}>
          <View style={styles.vinylGrooves} />
          <View style={[styles.vinylLabel, { backgroundColor: iconColor }]}>
            <Feather name="headphones" size={13} color="#fff" />
          </View>
        </View>
      ) : (
        <View style={[styles.fileIcon, { backgroundColor: `${iconColor}16` }]}>
          <Feather name={typeIcons[item.type]} size={19} color={iconColor} />
        </View>
      )}
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.cardForeground }]} numberOfLines={1}>{item.title}</Text>
        <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
          {typeLabels[item.type]} · {item.format.toUpperCase()} · {statusLabel}
          {(isActive || isPaused) && item.bytesWritten ? ` · ${formatBytes(item.bytesWritten)}` : ''}
          {item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''}
        </Text>
        {isActive || isPaused ? (
          <View style={styles.progressLine}>
            <View style={[styles.progressTrack, { backgroundColor: colors.muted }]}>
              <View style={[styles.progressFill, { backgroundColor: isPaused ? colors.mutedForeground : colors.primary, width: `${Math.max(item.progress * 100, 4)}%` }]} />
            </View>
            <Text style={[styles.progressPercent, { color: isPaused ? colors.mutedForeground : colors.primary }]}>{percentLabel(item)}</Text>
          </View>
        ) : item.error ? (
          <Text style={[styles.errorText, { color: colors.destructive }]} numberOfLines={2}>{item.error}</Text>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        {item.status === 'completed' && item.fileUri ? (
          <>
            <Pressable testID="open-file" accessibilityLabel="فتح الملف" onPress={onOpen} style={[styles.iconButton, styles.openButton, { backgroundColor: colors.primary }]}>
              <Feather name="play" size={15} color={colors.primaryForeground} />
            </Pressable>
            <Pressable
              testID="more-actions"
              accessibilityLabel="خيارات إضافية"
              onPress={onMore}
              style={styles.iconButton}
            >
              <Feather name="more-vertical" size={18} color={colors.mutedForeground} />
            </Pressable>
          </>
        ) : item.status === 'failed' ? (
          <Pressable testID="retry-download" accessibilityLabel="إعادة المحاولة" onPress={onRetry} style={styles.iconButton}>
            <Feather name="refresh-cw" size={18} color={colors.primary} />
          </Pressable>
        ) : isPaused ? (
          <Pressable testID="resume-download" accessibilityLabel="استئناف التحميل" onPress={onResume} style={styles.iconButton}>
            <Feather name="play" size={18} color={colors.primary} />
          </Pressable>
        ) : (
          <Pressable testID="pause-download" accessibilityLabel="إيقاف مؤقت" onPress={onPause} style={styles.iconButton}>
            <Feather name="pause" size={18} color={colors.primary} />
          </Pressable>
        )}
        <Pressable testID="remove-download" accessibilityLabel="حذف من السجل" onPress={onRemove} style={styles.iconButton}>
          <Feather name="x" size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </Pressable>
  );
}

type Palette = ReturnType<typeof useColors>;

function PinPad({ draft, colors, onDigit, onDelete }: {
  draft: string;
  colors: Palette;
  onDigit: (digit: string) => void;
  onDelete: () => void;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <View>
      <View style={styles.pinDots}>
        {[0, 1, 2, 3].map((index) => (
          <View key={index} style={[styles.pinDot, { borderColor: colors.border }, draft.length > index && { backgroundColor: colors.primary, borderColor: colors.primary }]} />
        ))}
      </View>
      <View style={styles.pinGrid}>
        {keys.map((key) => (
          <Pressable key={key} onPress={() => onDigit(key)} style={[styles.pinKey, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={[styles.pinKeyText, { color: colors.foreground }]}>{key}</Text>
          </Pressable>
        ))}
        <View style={styles.pinKey} />
        <Pressable onPress={() => onDigit('0')} style={[styles.pinKey, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Text style={[styles.pinKeyText, { color: colors.foreground }]}>0</Text>
        </Pressable>
        <Pressable onPress={onDelete} style={styles.pinKey} accessibilityLabel="حذف الرقم">
          <Feather name="delete" size={21} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

function VaultPanel({ colors, pin, setPin, vaultItems, onBack, onOpen, onMoveOut, onRemove }: {
  colors: Palette;
  pin: string | null;
  setPin: (value: string | null) => void;
  vaultItems: DownloadItem[];
  onBack: () => void;
  onOpen: (item: DownloadItem) => void;
  onMoveOut: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const [stage, setStage] = useState<'entry' | 'create' | 'confirm'>(pin ? 'entry' : 'create');
  const [draft, setDraft] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<MediaType | 'all'>('all');

  function complete(code: string) {
    setDraft('');
    if (stage === 'entry') {
      if (code === pin) {
        setError(false);
        setUnlocked(true);
      } else {
        setError(true);
      }
    } else if (stage === 'create') {
      setFirstPin(code);
      setStage('confirm');
    } else {
      if (code === firstPin) {
        setPin(code);
        setError(false);
        setUnlocked(true);
      } else {
        setError(true);
        setFirstPin('');
        setStage('create');
      }
    }
  }

  function pressDigit(digit: string) {
    if (draft.length >= 4) return;
    const next = draft + digit;
    setDraft(next);
    if (next.length === 4) setTimeout(() => complete(next), 160);
  }

  const filtered = filter === 'all' ? vaultItems : vaultItems.filter((item) => item.type === filter);

  return (
    <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
      <View style={styles.panelHeader}>
        <Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable>
        <Text style={[styles.panelTitle, { color: colors.foreground }]}>Vault · الخزنة</Text>
        <View style={{ width: 34 }} />
      </View>

      {!unlocked ? (
        <View style={styles.vaultLockWrap}>
          <View style={[styles.vaultLockIcon, { backgroundColor: `${colors.primary}14` }]}>
            <Feather name={pin ? 'lock' : 'shield'} size={34} color={colors.primary} />
          </View>
          <Text style={[styles.vaultTitle, { color: colors.foreground }]}>{pin ? 'أدخل الرمز السري' : 'اختر رمزاً سرياً'}</Text>
          <Text style={[styles.vaultSubtitle, { color: colors.mutedForeground }]}>
            {pin ? 'رمز من 4 أرقام لفتح ملفاتك الخاصة' : stage === 'confirm' ? 'أعد إدخال الرمز للتأكيد' : 'احتفظ بملفاتك الخاصة هنا · لن تظهر في التشغيل أو التنزيلات'}
          </Text>
          {error ? <Text style={[styles.vaultError, { color: colors.destructive }]}>رمز خاطئ، حاول مرة أخرى</Text> : null}
          <PinPad draft={draft} colors={colors} onDigit={pressDigit} onDelete={() => setDraft((current) => current.slice(0, -1))} />
        </View>
      ) : (
        <>
          <View style={styles.vaultOpenHeader}>
            <Text style={[styles.vaultCount, { color: colors.mutedForeground }]}>{vaultItems.length} ملفات خاصة</Text>
            <Pressable testID="lock-vault" accessibilityLabel="قفل الخزنة" onPress={() => { setUnlocked(false); setDraft(''); }} style={[styles.lockPill, { backgroundColor: colors.primary }]}>
              <Feather name="lock" size={15} color={colors.primaryForeground} />
              <Text style={[styles.lockPillText, { color: colors.primaryForeground }]}>LOCK</Text>
            </Pressable>
          </View>
          <View style={styles.filterRow}>
            {([{ key: 'all', label: 'الكل', icon: 'grid' }, { key: 'image', label: 'صور', icon: 'image' }, { key: 'audio', label: 'صوت', icon: 'headphones' }, { key: 'video', label: 'فيديو', icon: 'video' }] as { key: MediaType | 'all'; label: string; icon: keyof typeof Feather.glyphMap }[]).map((chip) => (
              <Pressable key={chip.key} onPress={() => setFilter(chip.key)} style={[styles.filterChip, { backgroundColor: filter === chip.key ? colors.primary : colors.background, borderColor: filter === chip.key ? colors.primary : colors.border }]}>
                <Feather name={chip.icon} size={14} color={filter === chip.key ? colors.primaryForeground : colors.mutedForeground} />
                <Text style={[styles.filterText, { color: filter === chip.key ? colors.primaryForeground : colors.mutedForeground }]}>{chip.label}</Text>
              </Pressable>
            ))}
          </View>
          {filtered.length === 0 ? (
            <View style={styles.vaultEmpty}>
              <View style={[styles.vaultEmptyFolder, { backgroundColor: `${colors.primary}12` }]}>
                <Feather name="folder" size={40} color={colors.primary} />
                <View style={[styles.vaultEmptyBadge, { backgroundColor: colors.primary }]}><Feather name="lock" size={11} color={colors.primaryForeground} /></View>
              </View>
              <Text style={[styles.vaultTitle, { color: colors.foreground }]}>احتفظ بملفاتك الخاصة هنا</Text>
              <Text style={[styles.vaultSubtitle, { color: colors.mutedForeground }]}>الملفات في الخزنة لن تُرى في تبويب التشغيل أو قائمة التنزيلات</Text>
            </View>
          ) : (
            <View style={styles.vaultList}>
              {filtered.map((item) => (
                <View key={item.id} style={[styles.downloadRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <View style={[styles.fileIcon, { backgroundColor: `${colors.primary}16` }]}>
                    <Feather name={typeIcons[item.type]} size={19} color={colors.primary} />
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowTitle, { color: colors.cardForeground }]} numberOfLines={1}>{item.title}</Text>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>{typeLabels[item.type]} · {formatBytes(item.totalBytes)}</Text>
                  </View>
                  <View style={styles.rowActions}>
                    <Pressable accessibilityLabel="تشغيل" onPress={() => onOpen(item)} style={[styles.iconButton, styles.openButton, { backgroundColor: colors.primary }]}>
                      <Feather name="play" size={14} color={colors.primaryForeground} />
                    </Pressable>
                    <Pressable accessibilityLabel="إخراج من الخزنة" onPress={() => onMoveOut(item.id)} style={styles.iconButton}>
                      <Feather name="unlock" size={16} color={colors.primary} />
                    </Pressable>
                    <Pressable accessibilityLabel="حذف نهائي" onPress={() => onRemove(item.id)} style={styles.iconButton}>
                      <Feather name="trash-2" size={16} color={colors.destructive} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}

/** حساب الأيام المتبقية قبل الحذف التلقائي من سلة المحذوفات (30 يوماً). */
function daysLeftInTrash(deletedAt: number) {
  const elapsed = Date.now() - deletedAt;
  const remaining = Math.ceil((30 * 24 * 60 * 60 * 1000 - elapsed) / (24 * 60 * 60 * 1000));
  return Math.max(remaining, 0);
}

function TrashPanel({ colors, trashItems, onBack, onRestore, onDelete, onEmpty }: {
  colors: Palette;
  trashItems: DownloadItem[];
  onBack: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onEmpty: () => void;
}) {
  return <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
    <View style={styles.panelHeader}><Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable><Text style={[styles.panelTitle, { color: colors.foreground }]}>سلة المحذوفات</Text>{trashItems.length > 0 ? <Pressable onPress={onEmpty} accessibilityLabel="تفريغ السلة"><Feather name="trash-2" size={19} color={colors.destructive} /></Pressable> : <View style={{ width: 34 }} />}</View>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground, marginBottom: 8 }]}>تبقى الملفات 30 يوماً ثم تُحذف تلقائياً</Text>
    {trashItems.length === 0 ? (
      <View style={[styles.trashEmpty, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={[styles.trashEmptyIcon, { backgroundColor: `${colors.primary}12` }]}><Feather name="trash-2" size={30} color={colors.primary} /></View>
        <Text style={[styles.trashEmptyTitle, { color: colors.foreground }]}>السلة فارغة</Text>
        <Text style={[styles.trashEmptyHint, { color: colors.mutedForeground }]}>الملفات المحذوفة تظهر هنا 30 يوماً قبل حذفها نهائياً</Text>
      </View>
    ) : (
      trashItems.map((item) => (
        <View key={item.id} style={[styles.trashRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={[styles.fileIcon, { backgroundColor: `${colors.mutedForeground}14` }]}>
            <Feather name={typeIcons[item.type]} size={17} color={colors.mutedForeground} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={[styles.rowTitle, { color: colors.cardForeground }]} numberOfLines={1}>{item.title}</Text>
            <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
              {typeLabels[item.type]} · {formatBytes(item.totalBytes)} · يُحذف بعد {daysLeftInTrash(item.deletedAt!)} يوم
            </Text>
          </View>
          <View style={styles.rowActions}>
            <Pressable testID={`restore-${item.id}`} accessibilityLabel="استعادة الملف" onPress={() => onRestore(item.id)} style={styles.iconButton}>
              <Feather name="rotate-ccw" size={17} color={colors.primary} />
            </Pressable>
            <Pressable testID={`purge-${item.id}`} accessibilityLabel="حذف نهائي" onPress={() => onDelete(item.id)} style={styles.iconButton}>
              <Feather name="trash-2" size={17} color={colors.destructive} />
            </Pressable>
          </View>
        </View>
      ))
    )}
  </Pressable>;
}

function FeatureRow({ icon, text, colors }: { icon: keyof typeof Feather.glyphMap; text: string; colors: Palette }) {
  return <View style={styles.featureRow}><View style={[styles.featureIcon, { backgroundColor: `${colors.primary}14` }]}><Feather name={icon} size={16} color={colors.primary} /></View><Text style={[styles.featureText, { color: colors.foreground }]}>{text}</Text></View>;
}

function SettingsPanel({ colors, themeMode, accent, maxTasks, maxTasksCellular, allowMobileData, downloadDir, onThemeChange, onAccentChange, onMaxTasks, onMaxTasksCellular, onAllowMobileData, onChooseDownloadDir, onClearDownloadDir, onBack }: {
  colors: Palette;
  themeMode: ThemeMode;
  accent: AccentKey;
  maxTasks: MaxTasks;
  maxTasksCellular: MaxTasks;
  allowMobileData: boolean;
  downloadDir: string | null;
  onMaxTasksCellular: (value: MaxTasks) => void;
  onThemeChange: (mode: ThemeMode) => void;
  onAccentChange: (value: AccentKey) => void;
  onMaxTasks: (value: MaxTasks) => void;
  onAllowMobileData: (value: boolean) => void;
  onChooseDownloadDir: () => void;
  onClearDownloadDir: () => void;
  onBack: () => void;
}) {
  const themeOptions: { value: ThemeMode; label: string; icon: keyof typeof Feather.glyphMap }[] = [
    { value: 'system', label: 'تلقائي', icon: 'smartphone' },
    { value: 'light', label: 'فاتح', icon: 'sun' },
    { value: 'dark', label: 'داكن', icon: 'moon' },
  ];
  return <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
    <View style={styles.panelHeader}><Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable><Text style={[styles.panelTitle, { color: colors.foreground }]}>الإعدادات</Text><View style={{ width: 34 }} /></View>
    <Text style={[styles.settingsLabel, { color: colors.foreground }]}>المظهر</Text>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>اختر طريقة عرض التطبيق</Text>
    <View style={[styles.themeOptions, { backgroundColor: colors.background }]}>
      {themeOptions.map((option) => <Pressable key={option.value} onPress={() => onThemeChange(option.value)} style={[styles.themeOption, themeMode === option.value && { backgroundColor: colors.card, borderColor: colors.primary }]}><Feather name={option.icon} size={18} color={themeMode === option.value ? colors.primary : colors.mutedForeground} /><Text style={[styles.themeOptionText, { color: themeMode === option.value ? colors.foreground : colors.mutedForeground }]}>{option.label}</Text></Pressable>)}
    </View>
    <Text style={[styles.settingsLabel, { color: colors.foreground, marginTop: 27 }]}>لون التطبيق</Text>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>غيّر اللون الرئيسي للأزرار والعناصر النشطة</Text>
    <View style={styles.colorOptions}>
      {(Object.keys(accentSwatches) as AccentKey[]).map((key) => <Pressable key={key} testID={`accent-${key}`} accessibilityLabel={`اختيار اللون ${key}`} onPress={() => onAccentChange(key)} style={[styles.colorOption, { backgroundColor: accentSwatches[key] }, accent === key && styles.colorOptionSelected]}><Feather name="check" size={17} color="#fff" style={{ opacity: accent === key ? 1 : 0 }} /></Pressable>)}
    </View>
    <Text style={[styles.settingsLabel, { color: colors.foreground, marginTop: 27 }]}>التنزيلات المتزامنة</Text>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>كم ملفاً يُنزّل في نفس الوقت</Text>
    <View style={styles.queueOptions}>
      {([1, 2, 3, 4] as const).map((value) => (
        <Pressable key={value} testID={`max-tasks-${value}`} accessibilityLabel={`${value} مهام على Wi-Fi`} onPress={() => onMaxTasks(value)} style={[styles.queueOption, { backgroundColor: colors.background, borderColor: maxTasks === value ? colors.primary : colors.border }]}>
          <Text style={[styles.themeOptionText, { color: maxTasks === value ? colors.primary : colors.mutedForeground }]}>{value}</Text>
        </Pressable>
      ))}
    </View>
    <Text style={[styles.settingsLabel, { color: colors.foreground, marginTop: 20 }]}>مهام بيانات الجوال</Text>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>حد أقل يوفر باقتك أثناء التنقل</Text>
    <View style={styles.queueOptions}>
      {([1, 2, 3, 4] as const).map((value) => (
        <Pressable key={value} testID={`max-tasks-cellular-${value}`} accessibilityLabel={`${value} مهام على بيانات الجوال`} onPress={() => onMaxTasksCellular(value)} style={[styles.queueOption, { backgroundColor: colors.background, borderColor: maxTasksCellular === value ? colors.primary : colors.border }]}>
          <Text style={[styles.themeOptionText, { color: maxTasksCellular === value ? colors.primary : colors.mutedForeground }]}>{value}</Text>
        </Pressable>
      ))}
    </View>
    <Text style={[styles.settingsLabel, { color: colors.foreground, marginTop: 27 }]}>مكان التنزيل</Text>
    <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>اختر مجلداً في الجهاز لحفظ الملفات فيه، أو اتركه في مجلد التطبيق</Text>
    <View style={[styles.dirRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Feather name="folder" size={19} color={colors.primary} style={{ marginTop: 1 }} />
      <Text style={[styles.dirText, { color: colors.foreground }]} numberOfLines={1}>
        {downloadDir ? `${dirLabel(downloadDir)} · محفوظ ✓` : 'مجلد التطبيق (افتراضي)'}
      </Text>
    </View>
    <View style={styles.dirActions}>
      <Pressable testID="choose-download-dir" accessibilityLabel="اختيار مجلد التنزيل" onPress={onChooseDownloadDir} style={[styles.dirButton, { backgroundColor: colors.primary }]}>
        <Feather name="edit" size={14} color={colors.primaryForeground} />
        <Text style={[styles.dirButtonText, { color: colors.primaryForeground }]}>{downloadDir ? 'تغيير' : 'اختيار مجلد'}</Text>
      </Pressable>
      {downloadDir ? (
        <Pressable testID="clear-download-dir" accessibilityLabel="إزالة مجلد التنزيل" onPress={onClearDownloadDir} style={[styles.dirButton, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}>
          <Feather name="x-circle" size={14} color={colors.destructive} />
          <Text style={[styles.dirButtonText, { color: colors.destructive }]}>إزالة</Text>
        </Pressable>
      ) : null}
    </View>
    <View style={[styles.switchRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={[styles.settingsLabel, { color: colors.foreground, fontSize: 13 }]}>التنزيل عبر بيانات الجوال</Text>
        <Text style={[styles.settingsHint, { color: colors.mutedForeground }]}>عند الإيقاف ينتظر التطبيق شبكة Wi-Fi</Text>
      </View>
      <Switch testID="mobile-data-switch" value={allowMobileData} onValueChange={onAllowMobileData} trackColor={{ true: colors.primary, false: colors.input }} thumbColor="#ffffff" />
    </View>
    <View style={[styles.settingsNote, { backgroundColor: colors.background, borderColor: colors.border }]}><Feather name="info" size={17} color={colors.primary} /><Text style={[styles.settingsNoteText, { color: colors.mutedForeground }]}>يتم حفظ اختياراتك تلقائياً على هذا الجهاز.</Text></View>
  </Pressable>;
}

function AboutPanel({ colors, onBack }: { colors: Palette; onBack: () => void }) {
  return <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
    <View style={styles.panelHeader}><Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable><Text style={[styles.panelTitle, { color: colors.foreground }]}>حول التطبيق</Text><View style={{ width: 34 }} /></View>
    <View style={styles.aboutHero}><View style={[styles.aboutMark, { backgroundColor: colors.primary }]}><Feather name="arrow-down" size={31} color={colors.primaryForeground} /></View><Text style={[styles.aboutName, { color: colors.foreground }]}>Download <Text style={{ color: colors.primary }}>Max</Text></Text><Text style={[styles.aboutVersion, { color: colors.mutedForeground }]}>الإصدار 1.11.0</Text></View>
    <View style={[styles.aboutCard, { backgroundColor: colors.background, borderColor: colors.border }]}><Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>المطور</Text><Text style={[styles.aboutDeveloper, { color: colors.foreground }]}>هشام الصبري</Text></View>
    <Text style={[styles.aboutDescription, { color: colors.mutedForeground }]}>تطبيق يساعدك على تنظيم تنزيلاتك من الروابط المسموح باستخدامها، مع تجربة بسيطة وسريعة.</Text>
  </Pressable>;
}

export default function HomeScreen() {
  const colors = useColors();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const { items, activeCount, waitingForWifi, addDownload, addSmartDownload, addCarouselImages, addSharedFile, retryDownload, pauseDownload, resumeDownload, removeDownload, openFile, shareFile, moveToVault, removeFromVault, setQueueOptions, downloadDir, setDownloadDir, restoreFromTrash, deletePermanently, emptyTrash, convertVideoToAudio, resolveCarouselVideo } = useDownloads();
  const { themeMode, accent, hasSeenOnboarding, maxTasks, maxTasksCellular, allowMobileData, vaultPin, setThemeMode, setAccent, setMaxTasks, setMaxTasksCellular, setAllowMobileData, setVaultPin, completeOnboarding } = useAppSettings();
  const { resolvedSharedPayloads, clearSharedPayloads } = useSafeIncomingShare();
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<'home' | 'downloads'>('home');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialog, setDeleteDialog] = useState<{ mode: 'selection' | 'single'; id?: string } | null>(null);
  /** الملف المفتوح قائمته السياقية (زر النقاط ⋮) — للتحويل إلى صوت. */
  const [moreMenu, setMoreMenu] = useState<DownloadItem | null>(null);
  /** صيغة الصوت المختارة في نافذة التحويل. */
  const [convertFormat, setConvertFormat] = useState<'mp3' | 'm4a'>('mp3');
  /** التحويل قيد التنفيذ — لمنع الضغط المزدوج. */
  const [converting, setConverting] = useState(false);
  const [youtubeKey, setYoutubeKey] = useState('AIzaSyDVZgxxaq37dDj5wQ9wQrPO4Oumju4gI44');
  const [mediaFilter, setMediaFilter] = useState<MediaType | 'all'>('all');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [selectedFormat, setSelectedFormat] = useState('mp4');
  const [showFormatSheet, setShowFormatSheet] = useState(false);
  const [rememberFormat, setRememberFormat] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [panel, setPanel] = useState<'menu' | 'settings' | 'about' | 'vault' | 'trash' | 'youtube' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  // شبكة اختيار صور الكاروسيل: الصور مصغّرة مع صح/بدون صح ثم تنزيل المحدد فقط.
  const [carouselGallery, setCarouselGallery] = useState<{ urls: string[]; selected: boolean[]; title?: string } | null>(null);
  // نافذة المحتوى المختلط: منشور يحتوي صوراً ونسخة فيديو قصير معاً — نسأل المستخدم أيهما يريد.
  const [mixedPrompt, setMixedPrompt] = useState<{ url: string; imageCount: number } | null>(null);

  // مزامنة إعدادات الطابور (المهام المتزامنة + بيانات الجوال) مع سياق التنزيل.
  useEffect(() => {
    setQueueOptions({ maxTasks, maxTasksCellular, allowMobileData });
  }, [maxTasks, maxTasksCellular, allowMobileData, setQueueOptions]);

  // الإشعار السفلي يختفي تلقائياً بعد 7 ثوانٍ.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  // استقبال المشاركات: الملفات (صور/فيديو/صوت) تُحفظ مباشرةً، والروابط تُعبّأ في الحقل.
  useEffect(() => {
    const shared = resolvedSharedPayloads[0];
    if (!shared) return;
    clearSharedPayloads();
    // المشاركة النصية (text/plain وغيره) دائماً تُعالج كرابط وتُفحص — حتى لو انضافت مسارات ملفات معاً.
    // الملفات الحقيقية فقط (صورة/فيديو/صوت MIME مع contentUri) تُحفظ مباشرة بدون فحص.
    const sharedTextHasUrl = !!extractUrl(shared.value ?? '');
    const isFileShare = shared.contentUri && shared.contentType && !shared.contentType.startsWith('text/') && !sharedTextHasUrl;
    if (isFileShare) {
      void addSharedFile(shared.contentUri!, shared.contentMimeType ?? null, shared.originalName ?? null);
      setActiveTab('downloads');
      setNotice('تم حفظ الملف المشارَك في التنزيلات ✓');
      return;
    }
    const value = shared.value ?? '';
    const extracted = extractUrl(value);
    if (extracted) {
      setInput(extracted);
      setActiveTab('home');
      // مسار الروابط الاجتماعية: يطبّق التعرف من اسم الموقع ثم يفتح خيارات الصيغ (أو يحمل مع تذكر الاختيار).
      const applyGuessedShareFlow = (alreadyScanned: boolean) => {
        const guessed = guessMediaTypeFromUrl(extracted);
        if (guessed) {
          changeType(guessed);
          if (rememberFormat) {
            void startDownload(extracted, { type: guessed, format: qualityChoices(guessed)[0].format, skipMixedCheck: alreadyScanned });
          } else {
            setPendingUrl(extracted);
            setShowFormatSheet(true);
          }
          return;
        }
        setNotice('تم استلام الرابط من المشاركة');
      };
      // رابط يوتيوب بمعرّف ناقص (المشاركة قصّته) — رسالة واضحة بدل فشل الاستخراج الغامض.
      if (isIncompleteYoutubeUrl(extracted)) {
        setNotice('وصل رابط يوتيوب غير مكتمل من المشاركة — انسخ الرابط كاملاً وحاول مجدداً 📋');
        return;
      }
      // روابط الملفات المباشرة (.jpg/.mp4/.mp3...) تُفتح فوراً بدون فحص — لا احتمال محتوى مختلط فيها.
      if (isDirectMediaLink(extracted)) {
        applyGuessedShareFlow(false);
        return;
      }
      // الروابط الاجتماعية (تيك توك/إنستغرام/سناب/فيسبوك...): نفحص المحتوى الفعلي أولاً —
      // الكاروسيل (صور + نسخة فيديو قصير) يسأل المستخدم دائماً: فيديو أم صور؟ قبل أي تحميل.
      void (async () => {
        setNotice('جارٍ فحص الرابط...');
        const gallery = await previewCarouselImages(extracted);
        setNotice(null);
        if (gallery.length > 1) {
          changeType('video');
          setMixedPrompt({ url: extracted, imageCount: gallery.length });
          return;
        }
        applyGuessedShareFlow(true);
      })();
    }
    }, [resolvedSharedPayloads, clearSharedPayloads, addSharedFile]);

  const url = extractUrl(input);
  const hasValidUrl = /^https?:\/\/\S+$/i.test(url);
  const selectedOption = qualityChoices(mediaType).find((option) => option.format === selectedFormat) ?? qualityChoices(mediaType)[0];
  const downloadItems = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const visibleItems = useMemo(() => downloadItems.filter((item) => !item.inVault && !item.deletedAt), [downloadItems]);
  const vaultItems = useMemo(() => downloadItems.filter((item) => item.inVault && !item.deletedAt && item.status === 'completed'), [downloadItems]);
  const trashItems = useMemo(() => downloadItems.filter((item) => item.deletedAt), [downloadItems]);
  const searchableItems = useMemo(
    () => visibleItems.filter((item) => item.title.toLowerCase().includes(searchQuery.trim().toLowerCase())),
    [visibleItems, searchQuery],
  );
  const filteredItems = useMemo(
    () => mediaFilter === 'all' ? searchableItems : searchableItems.filter((item) => item.type === mediaFilter),
    [searchableItems, mediaFilter],
  );
  const stats = useMemo(() => ({
    total: visibleItems.filter((item) => item.status === 'completed').length,
    bytes: visibleItems.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0),
  }), [visibleItems]);

  function changeType(type: MediaType) {
    setMediaType(type);
    setSelectedFormat(qualityChoices(type)[0].format);
    void Haptics.selectionAsync();
  }

  async function handleDownload() {
    Keyboard.dismiss();
    if (!hasValidUrl) {
      setNotice('ألصق رابطاً صحيحاً يبدأ بـ https://');
      return;
    }
    if (isIncompleteYoutubeUrl(url)) {
      setNotice('رابط يوتيوب غير مكتمل — انسخ الرابط كاملاً من زر المشاركة 📋');
      return;
    }
    if (!rememberFormat) {
      setPendingUrl(url);
      setShowFormatSheet(true);
      return;
    }
    await startDownload(url);
  }

  /** يبدأ التحميل بالصيغة المختارة (أو الصيغة الممررة صراحةً)؛ إن كان الرابط منشوراً مختلطاً (صور + فيديو) يُسأل المستخدم أولاً عن الشكل المطلوب. */
  async function startDownload(targetUrl: string, overrides?: { type: MediaType; format: string; skipMixedCheck?: boolean }) {
    // فحص المحتوى المختلط يُتخطى فقط عندما فُحص الرابط للتو (مثل مسار المشاركة) — لا إعادة فحص مكررة.
    if (overrides?.skipMixedCheck) {
      const type = overrides.type;
      const format = overrides.format;
      const count = await addSmartDownload({
        url: targetUrl,
        title: guessedTitle(targetUrl),
        type,
        format,
        quality: qualityChoices(type).find((entry) => entry.format === format)?.label ?? 'المصدر الأصلي',
      });
      setNotice(count > 1 ? `كاروسيل صور: أُضيفت ${count} صور للتحميل ✓` : 'أُضيف التحميل إلى القائمة');
      setActiveTab('downloads');
      return;
    }
    setNotice('جارٍ تحليل الرابط...');
    try {
      const gallery = await previewCarouselImages(targetUrl);
      if (gallery.length > 1) {
        setNotice(null);
        // محتوى مختلط: المنشور يحتوي صوراً وغالباً نسخة فيديو قصير — نسأل المستخدم أيهما يريد (كل المنصات).
        // استثناء: من طلب صوراً صراحةً (تبويب الصور) نفتح شبكة الصور مباشرة بدون سؤال.
        if (overrides?.type === 'image') {
          setCarouselGallery({ urls: gallery, selected: gallery.map(() => true), title: guessedTitle(targetUrl) });
          return;
        }
        setMixedPrompt({ url: targetUrl, imageCount: gallery.length });
        return;
      }
    } catch {
      // فشل الفحص المسبق — نكمل مسار التنزيل العادي ويعرض الخطأ داخل المهمة.
    }
    const type = overrides?.type ?? mediaType;
    const format = overrides?.format ?? selectedFormat;
    const count = await addSmartDownload({
      url: targetUrl,
      title: guessedTitle(targetUrl),
      type,
      format,
      quality: qualityChoices(type).find((entry) => entry.format === format)?.label ?? 'المصدر الأصلي',
    });
    setNotice(count > 1 ? `كاروسيل صور: أُضيفت ${count} صور للتحميل ✓` : 'أُضيف التحميل إلى القائمة');
    setActiveTab('downloads');
  }

  /** اختيار المستخدم في نافذة المحتوى المختلط: نسخة الفيديو القصير (بجودته المختارة) أو كل صور الألبوم. */
  async function handleMixedChoice(choice: 'video' | 'image') {
    if (!mixedPrompt) return;
    const target = mixedPrompt.url;
    setMixedPrompt(null);
    if (choice === 'image') {
      setNotice('جارٍ تحضير صور المنشور...');
      try {
        const gallery = await previewCarouselImages(target);
        setNotice(null);
        if (gallery.length > 0) {
          setCarouselGallery({ urls: gallery, selected: gallery.map(() => true), title: guessedTitle(target) });
          return;
        }
      } catch {
        setNotice(null);
      }
      // تعذر جلب الصور — نضيف المهمة كصورة عادية.
      await addSmartDownload({ url: target, title: guessedTitle(target), type: 'image', format: 'jpg', quality: 'صورة' });
      setNotice('أُضيف التحميل إلى القائمة');
      setActiveTab('downloads');
      return;
    }
    // فيديو: نحاول جلب نسخة الفيديو الحقيقية للمنشور المختلط (من أي منصة).
    setNotice('جارٍ تجهيز نسخة الفيديو...');
    const quality = selectedFormat.split('-')[1] ?? '720';
    const videoUrl = await resolveCarouselVideo(target, quality);
    if (videoUrl) {
      setNotice(null);
    } else {
      // لا نسخة جاهزة — نولّد فيديو العرض التقديمي محلياً من الصور والموسيقى (مثل AhaTik).
      setNotice('جارٍ توليد فيديو العرض التقديمي... قد يستغرق قليلاً');
      const bundle = await fetchSlideshowBundle(target);
      if (bundle.images.length === 0) {
        setNotice(null);
        setNotice('لا تتوفر نسخة فيديو لهذا المنشور — جرّب تنزيل الصور 📸');
        return;
      }
      const generated = await generateSlideshowVideo({
        images: bundle.images,
        music: bundle.music,
        title: guessedTitle(target),
        onProgress: (message) => setNotice(message),
      });
      setNotice(null);
      if (!generated) {
        void cleanupSlideshowTemp();
        setNotice('تعذّر توليد الفيديو — جرّب تنزيل الصور 📸');
        return;
      }
      await addDownload({
        url: generated,
        title: guessedTitle(target),
        type: 'video',
        format: 'mp4',
        quality: 'عرض تقديمي (مولّد)',
        resolvedUrl: true,
      });
      setActiveTab('downloads');
      setNotice('تم توليد فيديو العرض التقديمي ✓');
      return;
    }
    await addDownload({
      url: videoUrl,
      title: guessedTitle(target),
      type: 'video',
      format: 'mp4',
      quality: 'نسخة العرض المولّدة',
      resolvedUrl: true,
    });
    setNotice('أُضيف الفيديو إلى القائمة ✓');
    setActiveTab('downloads');
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    setIsRefreshing(false);
  }

  function showShare(item: DownloadItem) {
    void shareFile(item);
  }

  function showOpen(item: DownloadItem) {
    void openFile(item);
  }



  /** يفتح منتقي مجلدات أندرويد لاختيار مكان حفظ التنزيلات. */
  async function chooseDownloadDir() {
    if (Platform.OS === 'web') {
      setNotice('خيار المجلد متاح في تطبيق أندرويد');
      return;
    }
    const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permissions.granted) return;
    await setDownloadDir(permissions.directoryUri);
    setNotice(`سيُحفظ في: ${dirLabel(permissions.directoryUri)} ✓`);
  }

  function vaultAction(item: DownloadItem) {
    void moveToVault(item.id);
    setNotice('نُقل الملف إلى الخزنة 🔒');
  }

  /** يبدأ تحويل الفيديو المختار إلى صوت بالصيغة المحددة. */
  async function runConvert() {
    const target = moreMenu;
    if (!target || converting) return;
    setConverting(true);
    setNotice('جارٍ تحويل الفيديو إلى صوت...');
    try {
      const ok = await convertVideoToAudio(target.id, convertFormat, (message) => setNotice(message));
      if (ok) {
        setNotice(`تم التحويل إلى ${convertFormat.toUpperCase()} ✓ الملف في القائمة`);
      } else {
        setNotice('تعذّر التحويل — تأكد أن الملف فيديو سليم وحاول مجدداً');
      }
    } finally {
      setConverting(false);
      setMoreMenu(null);
    }
  }

  /** الضغط المطوّل يدخل وضع التحديد المتعدد. */
  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  /** مشاركة الملفات المحددة عبر لوحة مشاركة أندرويد (ملف واحد أو عدة ملفات). */
  async function shareSelected() {
    const targets = visibleItems.filter((item) => selectedIds.has(item.id) && item.fileUri);
    if (targets.length === 0) {
      setNotice('الملفات المحددة لم تكتمل بعد');
      return;
    }
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      setNotice('المشاركة غير مدعومة على هذا الجهاز');
      return;
    }
    if (targets.length === 1) {
      await Sharing.shareAsync(targets[0].fileUri!, { mimeType: mimeFromFile(targets[0].fileUri!), dialogTitle: 'مشاركة الملف' });
    } else {
      await Sharing.shareAsync(targets[0].fileUri!, { mimeType: mimeFromFile(targets[0].fileUri!), dialogTitle: `مشاركة ${targets.length} ملفات (شارك الباقي من المشغل)` });
    }
    setSelectedIds(new Set());
  }

  /** حذف المحدد: مع تحذير بين السلة أو الحذف النهائي. */
  async function confirmDelete(permanent: boolean) {
    if (!deleteDialog) return;
    const ids = deleteDialog.mode === 'selection'
      ? [...selectedIds]
      : deleteDialog.id ? [deleteDialog.id] : [];
    setDeleteDialog(null);
    for (const id of ids) {
      if (permanent) await deletePermanently(id);
      else await removeDownload(id);
    }
    setSelectedIds(new Set());
    setNotice(permanent ? `حُذف ${ids.length} ملف نهائياً` : `نُقل ${ids.length} ملف إلى السلة ♻️`);
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View>
          <View style={styles.brandLine}>
            <View style={[styles.brandMark, { backgroundColor: colors.primary }]}>
              <Feather name="arrow-down" size={17} color={colors.primaryForeground} />
            </View>
            <Text style={[styles.brandName, { color: colors.foreground }]}>Download <Text style={{ color: colors.primary }}>Max</Text></Text>
          </View>
          <Text style={[styles.brandSubline, { color: colors.mutedForeground }]}>تحميلك، بطريقة أبسط</Text>
        </View>
        <Pressable testID="open-menu" accessibilityLabel="فتح القائمة" onPress={() => setPanel('menu')} style={[styles.queuePill, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.menuLines}><View style={[styles.menuLine, { backgroundColor: colors.foreground }]} /><View style={[styles.menuLine, { backgroundColor: colors.foreground, width: 13 }]} /><View style={[styles.menuLine, { backgroundColor: colors.foreground, width: 9 }]} /></View>
          {activeCount > 0 ? <View style={[styles.countBadge, { backgroundColor: colors.primary }]}><Text style={styles.countText}>{activeCount}</Text></View> : null}
        </Pressable>
      </View>

      <View style={styles.content}>
        {activeTab === 'home' ? (
          <FlatList
            data={[{ key: 'home' }]}
            keyExtractor={(item) => item.key}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={colors.primary} />}
            contentContainerStyle={styles.homeContent}
            renderItem={() => (
              <>
                <View style={[styles.hero, { backgroundColor: scheme === 'dark' ? colors.card : '#eaf2ff' }]}>
                  <View style={styles.heroCopy}>
                    <Text style={[styles.eyebrow, { color: colors.primary }]}>روابطك في مكان واحد</Text>
                    <Text style={[styles.heroTitle, { color: colors.foreground }]}>حمّل ما تحتاجه{'\n'}بدون تعقيد.</Text>
                    <Text style={[styles.heroBody, { color: colors.mutedForeground }]}>شارك الرابط من متصفحك، اختر نوع الملف، واترك الباقي لـ Download Max.</Text>
                    <View style={[styles.heroStat, { backgroundColor: `${colors.primary}14` }]}>
                      <Feather name="check-circle" size={13} color={colors.primary} />
                      <Text style={[styles.heroStatText, { color: colors.primary }]}>{stats.total} ملف جاهز في مكتبتك</Text>
                    </View>
                  </View>
                  <View style={[styles.heroOrb, { borderColor: `${colors.primary}28` }]}>
                    <View style={[styles.heroOrbInner, { backgroundColor: `${colors.primary}14` }]}>
                      <Feather name="arrow-down" size={44} color={colors.primary} />
                    </View>
                  </View>
                </View>

                <View style={[styles.inputCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.sectionLabel, { color: colors.foreground }]}>أضف رابطاً للبدء</Text>
                  <View style={[styles.urlInputWrap, { backgroundColor: colors.background, borderColor: hasValidUrl ? colors.primary : colors.input }]}>
                    <Feather name="link" size={19} color={hasValidUrl ? colors.primary : colors.mutedForeground} />
                    <TextInput
                      testID="url-input"
                      accessibilityLabel="رابط الوسائط"
                      value={input}
                      onChangeText={setInput}
                      placeholder="الصق رابط الفيديو أو الصورة هنا"
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      returnKeyType="done"
                      onSubmitEditing={handleDownload}
                      style={[styles.urlInput, { color: colors.foreground }]}
                    />
                    {input.length > 0 ? <Pressable onPress={() => setInput('')} style={styles.clearInput}><Feather name="x-circle" size={18} color={colors.mutedForeground} /></Pressable> : null}
                  </View>
                  <Text style={[styles.helperText, { color: colors.mutedForeground }]}>تقدر أيضاً تستخدم زر المشاركة من أي متصفح</Text>
                </View>

                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={[styles.sectionTitle, { color: colors.foreground }]}>نوع الملف</Text>
                    <Text style={[styles.sectionHint, { color: colors.mutedForeground }]}>اختر ما يناسبك</Text>
                  </View>
                </View>
                <View style={styles.typeRow}>
                  {(Object.keys(typeLabels) as MediaType[]).map((type) => {
                    const selected = mediaType === type;
                    return (
                      <Pressable key={type} testID={`type-${type}`} accessibilityLabel={`اختيار ${typeLabels[type]}`} onPress={() => changeType(type)} style={[styles.typeCard, { backgroundColor: selected ? colors.primary : colors.card, borderColor: selected ? colors.primary : colors.border }]}>
                        <Feather name={typeIcons[type]} size={22} color={selected ? colors.primaryForeground : colors.primary} />
                        <Text style={[styles.typeLabel, { color: selected ? colors.primaryForeground : colors.foreground }]}>{typeLabels[type]}</Text>
                        {selected ? <View style={[styles.selectedDot, { backgroundColor: colors.primaryForeground }]} /> : null}
                      </Pressable>
                    );
                  })}
                </View>

                <Pressable testID="format-selector" accessibilityLabel="اختيار الصيغة" onPress={() => setShowFormatSheet(true)} style={[styles.formatSelector, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={[styles.formatIcon, { backgroundColor: `${colors.primary}14` }]}><Feather name="file-text" size={18} color={colors.primary} /></View>
                  <View style={styles.formatCopy}>
                    <Text style={[styles.formatTitle, { color: colors.foreground }]}>{selectedOption.label}</Text>
                    <Text style={[styles.formatDetail, { color: colors.mutedForeground }]}>{selectedOption.detail}</Text>
                  </View>
                  <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
                </Pressable>

                <Pressable testID="start-download" accessibilityLabel="بدء التنزيل" onPress={handleDownload} style={({ pressed }) => [styles.downloadButton, { backgroundColor: colors.primary, opacity: pressed ? 0.86 : 1 }]}>
                  <Feather name="download" size={20} color={colors.primaryForeground} />
                  <Text style={[styles.downloadButtonText, { color: colors.primaryForeground }]}>بدء التنزيل</Text>
                </Pressable>
                <Text style={[styles.legalNote, { color: colors.mutedForeground }]}>نزّل فقط المحتوى الذي تملكه أو لديك إذن باستخدامه.</Text>
              </>
            )}
          />
        ) : activeTab === 'downloads' ? (
          <FlatList
            data={filteredItems}
            keyExtractor={(item) => item.id}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={colors.primary} />}
            contentContainerStyle={[styles.downloadsContent, downloadItems.length === 0 && styles.emptyList]}
            ListHeaderComponent={
              <>
                <View style={styles.downloadsHeader}>
                  <View>
                    <Text style={[styles.pageTitle, { color: colors.foreground }]}>التنزيلات</Text>
                    <Text style={[styles.pageSubtitle, { color: colors.mutedForeground }]}>{visibleItems.length ? `${visibleItems.length} ملفات · ${stats.total} مكتمل · ${formatBytes(stats.bytes)}` : 'كل ما نزلته يظهر هنا'}</Text>
                  </View>
                  <View style={styles.headerActions}>
                    <Pressable testID="toggle-search" accessibilityLabel="بحث في التنزيلات" onPress={() => { setShowSearch((value) => !value); setSearchQuery(''); }} style={styles.headerActionButton}>
                      <Feather name={showSearch ? 'x' : 'search'} size={18} color={colors.primary} />
                    </Pressable>
                  </View>
                </View>
                {showSearch ? (
                  <View style={[styles.searchWrap, { backgroundColor: colors.background, borderColor: colors.input }]}>
                    <Feather name="search" size={17} color={colors.mutedForeground} />
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="ابحث باسم الملف..."
                      placeholderTextColor={colors.mutedForeground}
                      style={[styles.searchInput, { color: colors.foreground }]}
                      returnKeyType="search"
                    />
                  </View>
                ) : null}
                {waitingForWifi && activeCount > 0 ? (
                  <View style={[styles.wifiBanner, { backgroundColor: `${colors.primary}12`, borderColor: `${colors.primary}44` }]}>
                    <Feather name="wifi-off" size={16} color={colors.primary} />
                    <Text style={[styles.wifiBannerText, { color: colors.primary }]}>بانتظار اتصال Wi-Fi — التنزيل عبر بيانات الجوال معطّل من الإعدادات</Text>
                  </View>
                ) : null}
                <View style={styles.filterRow}>
                  {([{ key: 'all', label: 'الكل', icon: 'grid' }, { key: 'video', label: 'فيديو', icon: 'video' }, { key: 'audio', label: 'صوت', icon: 'headphones' }, { key: 'image', label: 'صور', icon: 'image' }] as { key: MediaType | 'all'; label: string; icon: keyof typeof Feather.glyphMap }[]).map((filter) => { const count = filter.key === 'all' ? visibleItems.length : visibleItems.filter((entry) => entry.type === filter.key).length; return <Pressable key={filter.key} onPress={() => setMediaFilter(filter.key)} style={[styles.filterChip, { backgroundColor: mediaFilter === filter.key ? colors.primary : colors.card, borderColor: mediaFilter === filter.key ? colors.primary : colors.border }]}><Feather name={filter.icon} size={14} color={mediaFilter === filter.key ? colors.primaryForeground : colors.mutedForeground} /><Text style={[styles.filterText, { color: mediaFilter === filter.key ? colors.primaryForeground : colors.mutedForeground }]}>{filter.label}</Text><View style={[styles.filterCount, { backgroundColor: mediaFilter === filter.key ? `${colors.primaryForeground}26` : `${colors.mutedForeground}18` }]}><Text style={[styles.filterCountText, { color: mediaFilter === filter.key ? colors.primaryForeground : colors.mutedForeground }]}>{count}</Text></View></Pressable>; })}
                </View>
              </>
            }
            ListHeaderComponentStyle={styles.listHeader}
            ListEmptyComponent={<View style={[styles.emptyState, { backgroundColor: colors.card, borderColor: colors.border }]}><View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}><Feather name="download-cloud" size={28} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>{downloadItems.length ? 'لا توجد ملفات من هذا النوع' : 'لا توجد تنزيلات بعد'}</Text><Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>{downloadItems.length ? 'اختر تصنيفاً آخر لمشاهدة ملفاتك.' : 'ألصق رابطاً من الشاشة الرئيسية وابدأ أول تنزيل لك.'}</Text><Pressable onPress={() => setActiveTab('home')} style={[styles.emptyButton, { backgroundColor: colors.primary }]}><Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>إضافة رابط</Text></Pressable></View>}
            renderItem={({ item }) => <DownloadRow item={item} selected={selectedIds.has(item.id)} onSelect={() => toggleSelection(item.id)} onRetry={() => void retryDownload(item.id)} onPause={() => void pauseDownload(item.id)} onResume={() => void resumeDownload(item.id)} onRemove={() => { setDeleteDialog({ mode: 'single', id: item.id }); }} onShare={() => showShare(item)} onOpen={() => showOpen(item)} onVault={() => vaultAction(item)} onMore={() => setMoreMenu(item)} />}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          />
        ) : null}
      </View>

      <View style={[styles.bottomNav, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 10) }]}>
        <Pressable testID="tab-home" accessibilityLabel="الرئيسية" onPress={() => setActiveTab('home')} style={styles.navItem}>
          <Feather name="home" size={21} color={activeTab === 'home' ? colors.primary : colors.mutedForeground} />
          <Text style={[styles.navLabel, { color: activeTab === 'home' ? colors.primary : colors.mutedForeground }]}>الرئيسية</Text>
        </Pressable>
        <Pressable testID="tab-youtube" accessibilityLabel="يوتيوب" onPress={() => setPanel('youtube')} style={styles.navItem}>
          <Feather name="youtube" size={21} color={colors.destructive} />
          <Text style={[styles.navLabel, { color: colors.mutedForeground }]}>يوتيوب</Text>
        </Pressable>
        <Pressable testID="tab-downloads" accessibilityLabel="التنزيلات" onPress={() => setActiveTab('downloads')} style={styles.navItem}>
          <View><Feather name="download" size={21} color={activeTab === 'downloads' ? colors.primary : colors.mutedForeground} />{activeCount > 0 ? <View style={[styles.navDot, { backgroundColor: colors.primary }]} /> : null}</View>
          <Text style={[styles.navLabel, { color: activeTab === 'downloads' ? colors.primary : colors.mutedForeground }]}>التنزيلات</Text>
        </Pressable>
      </View>

      <Modal visible={showFormatSheet} transparent animationType="slide" onRequestClose={() => setShowFormatSheet(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowFormatSheet(false)}>
          <Pressable style={[styles.sheet, styles.sheetTall, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>المزيد من الصيغ</Text>
            <FlatList
              data={qualityChoices(mediaType)}
              keyExtractor={(entry) => entry.format}
              style={{ flexGrow: 0 }}
              renderItem={({ item: option }) => {
                const selected = option.format === selectedFormat;
                return <TouchableOpacity key={option.format} testID={`format-${option.format}`} onPress={() => { setSelectedFormat(option.format); }} style={[styles.optionRow, { borderColor: selected ? colors.primary : colors.border }]}>
                  <View style={[styles.optionRadio, { borderColor: selected ? colors.primary : colors.input }]}>{selected ? <View style={[styles.optionRadioInner, { backgroundColor: colors.primary }]} /> : null}</View>
                  <View style={styles.optionCopy}><Text style={[styles.optionTitle, { color: colors.foreground }]}>{option.label}</Text><Text style={[styles.optionDetail, { color: colors.mutedForeground }]}>{option.detail}</Text></View>
                  {selected ? <Feather name="check" size={19} color={colors.primary} /> : null}
                </TouchableOpacity>;
              }}
            />
            <Pressable onPress={() => setRememberFormat((value) => !value)} style={styles.rememberRow}>
              <Switch value={rememberFormat} onValueChange={(value) => setRememberFormat(value)} trackColor={{ true: colors.primary, false: colors.muted }} thumbColor="#fff" />
              <Text style={[styles.rememberText, { color: colors.foreground }]}>تذكر اختياري — تحميل مباشر بدون هذه النافذة</Text>
            </Pressable>
            <Pressable testID="confirm-format" onPress={() => { setShowFormatSheet(false); if (pendingUrl) { const target = pendingUrl; setPendingUrl(null); void startDownload(target); } }} style={[styles.sheetConfirm, { backgroundColor: colors.primary }]}>
              <Text style={[styles.sheetConfirmText, { color: colors.primaryForeground }]}>تحميل الآن</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* شبكة اختيار صور الكاروسيل: مصغّرات + صح/بدون صح + تنزيل المحدد فقط */}
      <Modal visible={mixedPrompt !== null} transparent animationType="fade" onRequestClose={() => setMixedPrompt(null)}>
        <Pressable style={styles.dialogOverlay} onPress={() => setMixedPrompt(null)}>
          <Pressable style={[styles.dialogCard, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.dialogIcon, { backgroundColor: `${colors.primary}14` }]}>
              <Feather name="layers" size={26} color={colors.primary} />
            </View>
            <Text style={[styles.dialogTitle, { color: colors.foreground }]}>هذا المنشور متاح بشكلين</Text>
            <Text style={[styles.dialogBody, { color: colors.mutedForeground }]}>
              يحتوي {mixedPrompt?.imageCount ?? 0} صور ونسخة فيديو قصير مدموجة — كيف تريد التنزيل؟
            </Text>
            <Pressable testID="mixed-as-video" onPress={() => void handleMixedChoice('video')} style={[styles.dialogButton, { backgroundColor: colors.primary }]}>
              <Feather name="film" size={17} color={colors.primaryForeground} />
              <Text style={[styles.dialogButtonText, { color: colors.primaryForeground }]}>تحميل فيديو العرض التقديمي 🎬</Text>
            </Pressable>
            <Pressable testID="mixed-as-image" onPress={() => void handleMixedChoice('image')} style={[styles.dialogButton, { backgroundColor: `${colors.primary}16` }]}>
              <Feather name="image" size={17} color={colors.primary} />
              <Text style={[styles.dialogButtonText, { color: colors.primary }]}>تحميل الصورة ({mixedPrompt?.imageCount ?? 0}) 📸</Text>
            </Pressable>
            <Pressable onPress={() => setMixedPrompt(null)} style={styles.dialogCancel}>
              <Text style={[styles.dialogCancelText, { color: colors.mutedForeground }]}>إلغاء</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={carouselGallery !== null} transparent animationType="slide" onRequestClose={() => setCarouselGallery(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCarouselGallery(null)}>
          <Pressable style={[styles.sheet, styles.sheetTall, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            <View style={styles.galleryHeader}>
              <Text style={[styles.sheetTitle, { color: colors.foreground, marginBottom: 0 }]}>صور المنشور ({carouselGallery?.urls.length ?? 0})</Text>
              <Pressable testID="gallery-close" accessibilityLabel="إغلاق شبكة الصور" onPress={() => setCarouselGallery(null)} style={styles.galleryClose}>
                <Feather name="x" size={21} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <Pressable testID="gallery-select-all" accessibilityLabel="تحديد الكل" onPress={() => { void Haptics.selectionAsync(); setCarouselGallery((state) => state ? { ...state, selected: state.urls.map(() => true) } : state); }} style={styles.gallerySelectAll}>
              <Feather name="check-square" size={17} color={colors.primary} />
              <Text style={[styles.gallerySelectAllText, { color: colors.primary }]}>تحديد الكل</Text>
            </Pressable>
            <FlatList
              data={carouselGallery?.urls ?? []}
              keyExtractor={(item, index) => `${index}-${item.slice(-24)}`}
              numColumns={3}
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ gap: 7 }}
              columnWrapperStyle={{ gap: 7 }}
              renderItem={({ item, index }) => {
                const selected = carouselGallery?.selected[index] ?? false;
                return <TouchableOpacity testID={`gallery-image-${index}`} accessibilityLabel={`صورة ${index + 1}`} onPress={() => { void Haptics.selectionAsync(); setCarouselGallery((state) => state ? { ...state, selected: state.selected.map((value, cursor) => (cursor === index ? !value : value)) } : state); }} activeOpacity={0.85} style={[styles.galleryCell, { borderColor: selected ? colors.primary : 'transparent' }]}>
                  <Image source={{ uri: item }} style={styles.galleryImage} resizeMode="cover" />
                  <View style={[styles.galleryCheck, { backgroundColor: selected ? colors.primary : 'rgba(0,0,0,0.55)' }]}>
                    {selected ? <Feather name="check" size={13} color="#fff" /> : null}
                  </View>
                </TouchableOpacity>;
              }}
            />
            <Pressable
              testID="gallery-download"
              accessibilityLabel="تنزيل الصور المحددة"
              disabled={!carouselGallery || carouselGallery.selected.every((value) => !value)}
              onPress={() => {
                if (!carouselGallery) return;
                const picked = carouselGallery.urls.filter((_, index) => carouselGallery.selected[index]);
                setCarouselGallery(null);
                void addCarouselImages({ urls: picked, title: carouselGallery.title }).then((count) => {
                  setNotice(`تمت إضافة ${count} صور للتحميل ✓`);
                  setActiveTab('downloads');
                });
              }}
              style={[styles.sheetConfirm, styles.galleryDownload, { backgroundColor: colors.primary, opacity: carouselGallery && carouselGallery.selected.some(Boolean) ? 1 : 0.4 }]}
            >
              <Feather name="download" size={17} color={colors.primaryForeground} />
              <Text style={[styles.sheetConfirmText, { color: colors.primaryForeground }]}>تنزيل الصور ({carouselGallery?.selected.filter(Boolean).length ?? 0})</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={panel !== null} transparent animationType="slide" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setPanel(null)}>
          {panel === 'menu' ? (
            <Pressable style={[styles.drawer, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
              <View style={styles.drawerHeader}><LinearGradient style={styles.drawerMark} colors={[colors.primary, `${colors.primary}55`]}><Feather name="arrow-down" size={18} color={colors.primaryForeground} /></LinearGradient><View><Text style={[styles.drawerTitle, { color: colors.foreground }]}>Download <Text style={{ color: colors.primary }}>Max</Text></Text><Text style={[styles.drawerSubtitle, { color: colors.mutedForeground }]}>مركز التحكم</Text></View><Pressable onPress={() => setPanel(null)} style={styles.closeButton}><Feather name="x" size={21} color={colors.mutedForeground} /></Pressable></View>
              <View style={[styles.drawerDivider, { backgroundColor: colors.border }]} />
              <Text style={[styles.drawerSection, { color: colors.mutedForeground }]}>تصفّح</Text>
              <Pressable onPress={() => { setPanel(null); setActiveTab('home'); }} style={[styles.menuItem, { backgroundColor: activeTab === 'home' ? `${colors.primary}14` : 'transparent' }]}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.primary}12` }]}><Feather name="home" size={16} color={colors.primary} /></View><Text style={[styles.menuItemText, { color: activeTab === 'home' ? colors.primary : colors.foreground }]}>الرئيسية</Text></Pressable>
              <Pressable onPress={() => { setPanel(null); setActiveTab('downloads'); }} style={[styles.menuItem, { backgroundColor: activeTab === 'downloads' ? `${colors.primary}14` : 'transparent' }]}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.primary}12` }]}><Feather name="download" size={16} color={colors.primary} /></View><Text style={[styles.menuItemText, { color: activeTab === 'downloads' ? colors.primary : colors.foreground }]}>التنزيلات</Text><View style={[styles.menuBadge, { backgroundColor: `${colors.primary}16` }]}><Text style={[styles.menuBadgeText, { color: colors.primary }]}>{visibleItems.length}</Text></View></Pressable>
              <Text style={[styles.drawerSection, { color: colors.mutedForeground }]}>مكتبتي</Text>
              <Pressable onPress={() => setPanel('vault')} testID="menu-vault" style={styles.menuItem}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.accentForeground}14` }]}><Feather name="lock" size={16} color={colors.accentForeground} /></View><Text style={[styles.menuItemText, { color: colors.foreground }]}>الخزنة</Text><View style={[styles.menuBadge, { backgroundColor: `${colors.accentForeground}16` }]}><Text style={[styles.menuBadgeText, { color: colors.accentForeground }]}>{vaultItems.length}</Text></View></Pressable>
              <Pressable onPress={() => setPanel('trash')} testID="menu-trash" style={styles.menuItem}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.mutedForeground}12` }]}><Feather name="trash-2" size={16} color={colors.mutedForeground} /></View><Text style={[styles.menuItemText, { color: colors.foreground }]}>سلة المحذوفات</Text><View style={[styles.menuBadge, { backgroundColor: `${colors.destructive}16` }]}><Text style={[styles.menuBadgeText, { color: colors.destructive }]}>{trashItems.length}</Text></View></Pressable>
              <Text style={[styles.drawerSection, { color: colors.mutedForeground }]}>أدوات</Text>
              <Pressable onPress={() => setPanel('settings')} style={styles.menuItem}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.mutedForeground}12` }]}><Feather name="sliders" size={16} color={colors.mutedForeground} /></View><Text style={[styles.menuItemText, { color: colors.foreground }]}>الإعدادات</Text></Pressable>
              <Pressable onPress={() => setPanel('about')} style={styles.menuItem}><View style={[styles.menuItemIcon, { backgroundColor: `${colors.primary}12` }]}><Feather name="info" size={16} color={colors.primary} /></View><Text style={[styles.menuItemText, { color: colors.foreground }]}>حول التطبيق</Text></Pressable>
              <View style={[styles.drawerFooterPill, { borderColor: colors.border }]}><Text style={[styles.drawerFooterPillText, { color: colors.mutedForeground }]}>الإصدار 1.11.0 · صُنع بعناية</Text></View>
            </Pressable>
          ) : panel === 'settings' ? (
            <SettingsPanel colors={colors} themeMode={themeMode} accent={accent} maxTasks={maxTasks} maxTasksCellular={maxTasksCellular} allowMobileData={allowMobileData} downloadDir={downloadDir} onThemeChange={setThemeMode} onAccentChange={setAccent} onMaxTasks={setMaxTasks} onMaxTasksCellular={setMaxTasksCellular} onAllowMobileData={setAllowMobileData} onChooseDownloadDir={chooseDownloadDir} onClearDownloadDir={() => { void setDownloadDir(null); setNotice('عاد التنزيل إلى مجلد التطبيق'); }} onBack={() => setPanel('menu')} />
          ) : panel === 'vault' ? (
            <VaultPanel colors={colors} pin={vaultPin} setPin={setVaultPin} vaultItems={vaultItems} onBack={() => setPanel('menu')} onOpen={showOpen} onMoveOut={(id) => void removeFromVault(id)} onRemove={(id) => void removeDownload(id)} />
          ) : panel === 'trash' ? (
            <TrashPanel colors={colors} trashItems={trashItems} onBack={() => setPanel('menu')} onRestore={(id) => { void restoreFromTrash(id); setNotice('أُعيد الملف إلى التنزيلات ✓'); }} onDelete={(id) => void deletePermanently(id)} onEmpty={() => { void emptyTrash(); setNotice('فُرّغت سلة المحذوفات 🗑️'); }} />
          ) : panel === 'youtube' ? (
            <YoutubePanel colors={colors} onBack={() => setPanel('menu')} onDownload={(videoUrl: string) => { setPanel(null); void addSmartDownload({ url: videoUrl, type: 'video', format: 'mp4', quality: 'المصدر الأصلي' }).then((count) => { setNotice('أُضيف التحميل إلى القائمة'); setActiveTab('downloads'); }); }} notice={notice ?? ''} />
          ) : (
            <AboutPanel colors={colors} onBack={() => setPanel('menu')} />
          )}
        </Pressable>
      </Modal>

      {/* نافذة تأكيد الحذف: سلة المحذوفات أو حذف نهائي */}
      <Modal visible={deleteDialog !== null} transparent animationType="fade" onRequestClose={() => setDeleteDialog(null)}>
        <Pressable style={styles.dialogOverlay} onPress={() => setDeleteDialog(null)}>
          <Pressable style={[styles.dialogCard, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.dialogIcon, { backgroundColor: `${colors.destructive}14` }]}>
              <Feather name="alert-triangle" size={26} color={colors.destructive} />
            </View>
            <Text style={[styles.dialogTitle, { color: colors.foreground }]}>تأكيد الحذف</Text>
            <Text style={[styles.dialogBody, { color: colors.mutedForeground }]}>
              {deleteDialog?.mode === 'selection' ? `حذف ${selectedIds.size} ملفات المحددة؟` : 'حذف هذا الملف؟'}
            </Text>
            <Pressable testID="delete-to-trash" onPress={() => void confirmDelete(false)} style={[styles.dialogButton, { backgroundColor: `${colors.primary}16` }]}>
              <Feather name="trash-2" size={17} color={colors.primary} />
              <Text style={[styles.dialogButtonText, { color: colors.primary }]}>حذف إلى سلة المحذوفات</Text>
            </Pressable>
            <Pressable testID="delete-permanent" onPress={() => void confirmDelete(true)} style={[styles.dialogButton, { backgroundColor: `${colors.destructive}14` }]}>
              <Feather name="x-circle" size={17} color={colors.destructive} />
              <Text style={[styles.dialogButtonText, { color: colors.destructive }]}>حذف نهائي</Text>
            </Pressable>
            <Pressable onPress={() => setDeleteDialog(null)} style={styles.dialogCancel}>
              <Text style={[styles.dialogCancelText, { color: colors.mutedForeground }]}>إلغاء</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* القائمة الذكية لزر النقاط ⋮ — ورقة سفلية برأس الملف وإجراءات تتكيف مع النوع */}
      <Modal visible={moreMenu !== null} transparent animationType="slide" onRequestClose={() => setMoreMenu(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setMoreMenu(null)}>
          <Pressable style={[styles.moreSheet, { backgroundColor: colors.card, paddingBottom: Platform.OS === 'web' ? 24 : Math.max(insets.bottom, 16) }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            {moreMenu ? (
              <View style={[styles.moreHeader, { borderBottomColor: colors.border }]}>
                {moreMenu.status === 'completed' && moreMenu.thumbnailUri ? (
                  <View style={styles.moreHeaderThumbWrap}>
                    <Image source={{ uri: moreMenu.thumbnailUri }} style={styles.moreHeaderThumb} resizeMode="cover" />
                    {moreMenu.type === 'video' ? (
                      <View style={styles.moreHeaderThumbBadge}>
                        <Feather name="play" size={10} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                ) : (
                  <View style={[styles.moreHeaderIcon, { backgroundColor: `${colors.primary}14` }]}>
                    <Feather name={typeIcons[moreMenu.type]} size={22} color={colors.primary} />
                  </View>
                )}
                <View style={styles.moreHeaderText}>
                  <Text style={[styles.moreHeaderTitle, { color: colors.foreground }]} numberOfLines={2}>{moreMenu.title}</Text>
                  <Text style={[styles.moreHeaderMeta, { color: colors.mutedForeground }]}>{typeLabels[moreMenu.type]} · {moreMenu.format.toUpperCase()}{moreMenu.totalBytes ? ` · ${formatBytes(moreMenu.totalBytes)}` : ''}</Text>
                </View>
              </View>
            ) : null}
            {moreMenu?.type === 'video' ? (
              <View style={styles.convertFormatRow}>
                {([['mp3', 'MP3', 'أوسع توافق'], ['m4a', 'M4A', 'جودة أصلية']] as const).map(([value, label, detail]) => (
                  <Pressable
                    key={value}
                    testID={`convert-${value}`}
                    onPress={() => setConvertFormat(value)}
                    style={[styles.convertFormatCard, { borderColor: convertFormat === value ? colors.primary : colors.border, backgroundColor: convertFormat === value ? `${colors.primary}12` : 'transparent' }]}
                  >
                    <Text style={[styles.convertFormatLabel, { color: convertFormat === value ? colors.primary : colors.foreground }]}>{label}</Text>
                    <Text style={[styles.convertFormatDetail, { color: colors.mutedForeground }]}>{detail}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {moreMenu?.type === 'video' ? (
              <Pressable
                testID="convert-run"
                onPress={() => void runConvert()}
                disabled={converting}
                style={[styles.moreRow, { opacity: converting ? 0.6 : 1 }]}
              >
                <View style={[styles.moreRowIcon, { backgroundColor: `${colors.primary}12` }]}>
                  {converting ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="music" size={18} color={colors.primary} />}
                </View>
                <Text style={[styles.moreRowText, { color: colors.foreground }]}>{converting ? 'جارٍ التحويل...' : `تحويل إلى صوت (${convertFormat.toUpperCase()})`}</Text>
              </Pressable>
            ) : null}
            <Pressable testID="menu-vault" onPress={() => { const target = moreMenu; setMoreMenu(null); if (target) vaultAction(target); }} style={styles.moreRow}>
              <View style={[styles.moreRowIcon, { backgroundColor: `${colors.accentForeground}14` }]}>
                <Feather name="lock" size={18} color={colors.accentForeground} />
              </View>
              <Text style={[styles.moreRowText, { color: colors.foreground }]}>القفل في الخزنة</Text>
            </Pressable>
            <Pressable testID="menu-share" onPress={() => { const target = moreMenu; setMoreMenu(null); if (target) showShare(target); }} style={styles.moreRow}>
              <View style={[styles.moreRowIcon, { backgroundColor: `${colors.primary}12` }]}>
                <Feather name="share-2" size={18} color={colors.primary} />
              </View>
              <Text style={[styles.moreRowText, { color: colors.foreground }]}>مشاركة</Text>
            </Pressable>
            <Pressable testID="menu-delete" onPress={() => { const target = moreMenu; setMoreMenu(null); if (target) setDeleteDialog({ mode: 'single', id: target.id }); }} style={styles.moreRow}>
              <View style={[styles.moreRowIcon, { backgroundColor: `${colors.destructive}12` }]}>
                <Feather name="trash-2" size={18} color={colors.destructive} />
              </View>
              <Text style={[styles.moreRowText, { color: colors.destructive }]}>حذف الملف</Text>
              <Text style={[styles.moreRowHint, { color: colors.mutedForeground }]}>سلة 30 يوماً أو نهائي</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* شريط التحديد السفلي: مشاركة وحذف للملفات المحددة */}
      {selectedIds.size > 0 && !panel ? (
        <View style={[styles.selectionBar, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Platform.OS === 'web' ? 30 : Math.max(insets.bottom, 10) }]}>
          <Pressable onPress={() => setSelectedIds(new Set())} style={styles.selectionCountWrap}>
            <Feather name="x" size={16} color={colors.mutedForeground} />
            <Text style={[styles.selectionCount, { color: colors.foreground }]}>{selectedIds.size} محدد</Text>
          </Pressable>
          <View style={styles.selectionActions}>
            <Pressable testID="selection-share" onPress={() => void shareSelected()} style={[styles.selectionAction, { backgroundColor: colors.primary }]}>
              <Feather name="share-2" size={16} color={colors.primaryForeground} />
              <Text style={[styles.selectionActionText, { color: colors.primaryForeground }]}>مشاركة</Text>
            </Pressable>
            <Pressable testID="selection-delete" onPress={() => setDeleteDialog({ mode: 'selection' })} style={[styles.selectionAction, { backgroundColor: `${colors.destructive}16` }]}>
              <Feather name="trash-2" size={16} color={colors.destructive} />
              <Text style={[styles.selectionActionText, { color: colors.destructive }]}>حذف</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <Modal visible={!hasSeenOnboarding} transparent animationType="fade" onRequestClose={completeOnboarding}>
        <View style={styles.onboardingBackdrop}>
          <View style={[styles.onboardingCard, { backgroundColor: colors.card }]}>
            <Pressable testID="close-onboarding" accessibilityLabel="إغلاق الترحيب" onPress={completeOnboarding} style={styles.onboardingClose}><Feather name="x" size={20} color={colors.mutedForeground} /></Pressable>
            <View style={[styles.onboardingIcon, { backgroundColor: `${colors.primary}18` }]}><Feather name="download-cloud" size={30} color={colors.primary} /></View>
            <Text style={[styles.onboardingKicker, { color: colors.primary }]}>مرحباً بك في</Text>
            <Text style={[styles.onboardingTitle, { color: colors.foreground }]}>Download Max</Text>
            <Text style={[styles.onboardingBody, { color: colors.mutedForeground }]}>كل ما تحتاجه لتنظيم تنزيلاتك في مكان واحد.</Text>
            <View style={styles.featureList}>
              <FeatureRow icon="share-2" text="استقبل الروابط مباشرة من زر المشاركة" colors={colors} />
              <FeatureRow icon="layers" text="اختر بين الفيديو والصوت والصور" colors={colors} />
              <FeatureRow icon="activity" text="تابع تقدم التنزيلات وسجل ملفاتك" colors={colors} />
            </View>
            <Pressable testID="start-using-app" onPress={completeOnboarding} style={[styles.onboardingButton, { backgroundColor: colors.primary }]}><Text style={[styles.onboardingButtonText, { color: colors.primaryForeground }]}>ابدأ الاستخدام</Text><Feather name="arrow-left" size={18} color={colors.primaryForeground} /></Pressable>
          </View>
        </View>
      </Modal>

      {notice ? <Pressable onPress={() => setNotice(null)} style={[styles.notice, { backgroundColor: colors.foreground }]}><Feather name="check-circle" size={17} color={colors.primary} /><Text style={[styles.noticeText, { color: colors.background }]}>{notice}</Text><Feather name="x" size={16} color={colors.mutedForeground} /></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerActionButton: { width: 34, height: 34, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  searchWrap: { minHeight: 44, borderRadius: 13, borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  searchInput: { flex: 1, fontSize: 13, minHeight: 42, textAlign: 'left' },
  wifiBanner: { borderRadius: 13, borderWidth: 1, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  wifiBannerText: { flex: 1, fontSize: 11, fontWeight: '700', lineHeight: 16 },
  pinDots: { flexDirection: 'row', justifyContent: 'center', gap: 14, marginTop: 18 },
  pinDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  pinGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 22, width: 252, alignSelf: 'center' },
  pinKey: { width: 77, height: 56, borderRadius: 15, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  pinKeyText: { fontSize: 20, fontWeight: '800' },
  vaultLockWrap: { alignItems: 'center', paddingTop: 8 },
  vaultLockIcon: { width: 76, height: 76, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  vaultTitle: { fontSize: 19, fontWeight: '800', marginTop: 4 },
  vaultSubtitle: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7, maxWidth: 290 },
  vaultError: { fontSize: 12, fontWeight: '700', marginTop: 12 },
  vaultOpenHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  vaultCount: { fontSize: 12, fontWeight: '700' },
  lockPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 12 },
  lockPillText: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  vaultEmpty: { flex: 1, minHeight: 300, justifyContent: 'center', alignItems: 'center' },
  vaultEmptyFolder: { width: 92, height: 92, borderRadius: 30, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  vaultEmptyBadge: { position: 'absolute', bottom: -6, right: -6, width: 26, height: 26, borderRadius: 13, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#ffffff' },
  vaultList: { gap: 10, paddingBottom: 8 },
  queueOptions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  queueOption: { flex: 1, minHeight: 56, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, borderRadius: 15, borderWidth: 1, padding: 13 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 13 },
  brandLine: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 30, height: 30, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  brandName: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  brandSubline: { fontSize: 11, marginTop: 4, marginLeft: 39 },
  queuePill: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  menuLines: { gap: 3, alignItems: 'flex-end' },
  menuLine: { width: 17, height: 2, borderRadius: 2 },
  countBadge: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3 },
  countText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  content: { flex: 1 },
  homeContent: { padding: 20, paddingBottom: 36 },
  hero: { borderRadius: 24, padding: 21, minHeight: 178, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  heroCopy: { flex: 1, zIndex: 1 },
  eyebrow: { fontSize: 12, fontWeight: '700', marginBottom: 9 },
  heroTitle: { fontSize: 28, lineHeight: 33, fontWeight: '800', letterSpacing: -0.7 },
  heroBody: { fontSize: 12, lineHeight: 18, marginTop: 11, maxWidth: 224 },
  heroOrb: { width: 112, height: 112, borderRadius: 56, borderWidth: 18, justifyContent: 'center', alignItems: 'center', opacity: 0.95, marginRight: -35 },
  heroOrbInner: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  heroStat: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 11 },
  heroStatText: { fontSize: 11, fontWeight: '700' },
  inputCard: { borderRadius: 20, borderWidth: 1, padding: 16, marginTop: 18 },
  sectionLabel: { fontSize: 14, fontWeight: '800', marginBottom: 11 },
  urlInputWrap: { minHeight: 52, borderRadius: 14, borderWidth: 1, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  urlInput: { flex: 1, fontSize: 13, minHeight: 50, textAlign: 'left' },
  clearInput: { padding: 5 },
  helperText: { fontSize: 11, marginTop: 9 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 25, marginBottom: 11 },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  sectionHint: { fontSize: 11, marginTop: 3 },
  typeRow: { flexDirection: 'row', gap: 10 },
  typeCard: { flex: 1, minHeight: 83, borderRadius: 17, borderWidth: 1, padding: 13, justifyContent: 'space-between' },
  typeLabel: { fontSize: 13, fontWeight: '700' },
  selectedDot: { position: 'absolute', top: 12, right: 12, width: 6, height: 6, borderRadius: 3 },
  formatSelector: { minHeight: 68, borderRadius: 17, borderWidth: 1, marginTop: 13, padding: 12, flexDirection: 'row', alignItems: 'center' },
  formatIcon: { width: 38, height: 38, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  formatCopy: { flex: 1, marginLeft: 11 },
  formatTitle: { fontSize: 13, fontWeight: '800' },
  formatDetail: { fontSize: 11, marginTop: 3 },
  downloadButton: { minHeight: 54, borderRadius: 16, marginTop: 13, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9 },
  downloadButtonText: { fontSize: 15, fontWeight: '800' },
  legalNote: { fontSize: 10, textAlign: 'center', marginTop: 12 },
  bottomNav: { minHeight: 68, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  navItem: { minWidth: 90, alignItems: 'center', gap: 4 },
  navLabel: { fontSize: 11, fontWeight: '700' },
  navDot: { position: 'absolute', width: 7, height: 7, borderRadius: 4, top: -2, right: -5 },
  downloadsContent: { padding: 20, paddingBottom: 34 },
  listHeader: { paddingBottom: 7 },
  downloadsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16 },
  pageTitle: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5 },
  pageSubtitle: { fontSize: 12, marginTop: 5 },
  filterRow: { flexDirection: 'row', gap: 7, marginBottom: 8 },
  filterChip: { minHeight: 34, borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  filterText: { fontSize: 11, fontWeight: '700' },
  filterCount: { minWidth: 19, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  filterCountText: { fontSize: 10, fontWeight: '800' },
  downloadRow: { borderRadius: 17, borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center', shadowColor: '#0e1a2b', shadowOpacity: 0.05, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  fileIcon: { width: 42, height: 42, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  fileThumbWrap: { width: 56, height: 56, borderRadius: 12, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  fileThumbImage: { width: '100%', height: '100%' },
  fileThumbBadge: { position: 'absolute', bottom: 3, right: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  vinylDisc: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  vinylGrooves: { position: 'absolute', width: 56, height: 56, borderRadius: 28, borderWidth: 5, borderColor: 'rgba(128,128,128,0.18)', top: 0, left: 0 },
  vinylLabel: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, marginLeft: 11, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: '800' },
  rowMeta: { fontSize: 10, marginTop: 4 },
  progressLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  progressTrack: { flex: 1, height: 7, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
  progressPercent: { fontSize: 11, fontWeight: '800', minWidth: 32, textAlign: 'right' },
  openButton: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  dirRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 15, padding: 13, marginTop: 10 },
  dirText: { flex: 1, fontSize: 13, fontWeight: '600' },
  dirActions: { flexDirection: 'row', gap: 9, marginTop: 10 },
  dirButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 12 },
  dirButtonText: { fontSize: 13, fontWeight: '700' },
  trashRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 15, padding: 12, marginTop: 9 },
  trashEmpty: { minHeight: 300, borderRadius: 20, borderWidth: 1, justifyContent: 'center', alignItems: 'center', padding: 24, marginTop: 12 },
  trashEmptyIcon: { width: 74, height: 74, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  trashEmptyTitle: { fontSize: 16, fontWeight: '800', marginBottom: 5 },
  trashEmptyHint: { fontSize: 12, textAlign: 'center', lineHeight: 19, paddingHorizontal: 12 },
  errorText: { fontSize: 10, lineHeight: 14, marginTop: 6 },
  rowActions: { flexDirection: 'row', alignItems: 'center', marginLeft: 5, gap: 1 },
  iconButton: { padding: 7 },
  emptyList: { flexGrow: 1 },
  emptyState: { flex: 1, minHeight: 330, borderRadius: 22, borderWidth: 1, justifyContent: 'center', alignItems: 'center', padding: 25, marginTop: 25 },
  emptyIcon: { width: 62, height: 62, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 17, fontWeight: '800' },
  emptyBody: { textAlign: 'center', fontSize: 12, lineHeight: 18, marginTop: 8, maxWidth: 260 },
  emptyButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 13, marginTop: 18 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(5, 15, 28, 0.52)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 21, paddingBottom: 32 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 18 },
  sheetTitle: { fontSize: 20, fontWeight: '800', marginBottom: 8 },
  optionRow: { minHeight: 66, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 13 },
  optionRadio: { width: 21, height: 21, borderRadius: 11, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  optionRadioInner: { width: 11, height: 11, borderRadius: 6 },
  optionCopy: { flex: 1 },
  optionTitle: { fontSize: 14, fontWeight: '700' },
  optionDetail: { fontSize: 11, marginTop: 3 },
  drawerBackdrop: { flex: 1, backgroundColor: 'rgba(5, 15, 28, 0.52)', justifyContent: 'flex-start' },
  drawer: { width: '84%', minHeight: '100%', paddingTop: 58, paddingHorizontal: 21, borderTopRightRadius: 25, borderBottomRightRadius: 25 },
  drawerHeader: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  drawerMark: { width: 40, height: 40, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  drawerTitle: { fontSize: 18, fontWeight: '800' },
  drawerSubtitle: { fontSize: 11, marginTop: 3 },
  closeButton: { marginLeft: 'auto', padding: 6 },
  drawerDivider: { height: 1, marginVertical: 22 },
  drawerSection: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 8, marginBottom: 4, paddingHorizontal: 12 },
  menuItem: { minHeight: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 12 },
  menuItemIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuBadge: { minWidth: 22, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7 },
  menuBadgeText: { fontSize: 10, fontWeight: '800' },
  menuItemText: { flex: 1, fontSize: 14, fontWeight: '700' },
  drawerFooterPill: { marginTop: 'auto', alignSelf: 'center', marginBottom: 35, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
  drawerFooterPillText: { fontSize: 10, fontWeight: '700' },
  settingsPanel: { width: '84%', minHeight: '100%', paddingTop: 58, paddingHorizontal: 21, borderTopRightRadius: 25, borderBottomRightRadius: 25 },
  panelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 },
  backButton: { width: 34, height: 34, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  panelTitle: { fontSize: 19, fontWeight: '800' },
  settingsLabel: { fontSize: 16, fontWeight: '800' },
  settingsHint: { fontSize: 11, marginTop: 5 },
  themeOptions: { flexDirection: 'row', borderRadius: 15, padding: 4, gap: 4, marginTop: 14 },
  themeOption: { flex: 1, minHeight: 65, borderRadius: 12, borderWidth: 1, borderColor: 'transparent', justifyContent: 'center', alignItems: 'center', gap: 5 },
  themeOptionText: { fontSize: 11, fontWeight: '700' },
  colorOptions: { flexDirection: 'row', gap: 13, marginTop: 17 },
  colorOption: { width: 35, height: 35, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  colorOptionSelected: { borderWidth: 3, borderColor: '#ffffff', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  settingsNote: { marginTop: 30, borderRadius: 15, borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  settingsNoteText: { fontSize: 11, flex: 1, lineHeight: 17 },
  aboutHero: { alignItems: 'center', marginTop: 15, marginBottom: 25 },
  aboutMark: { width: 74, height: 74, borderRadius: 25, justifyContent: 'center', alignItems: 'center', marginBottom: 13 },
  aboutName: { fontSize: 23, fontWeight: '800' },
  aboutVersion: { fontSize: 11, marginTop: 5 },
  aboutCard: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 18 },
  aboutLabel: { fontSize: 11 },
  aboutDeveloper: { fontSize: 16, fontWeight: '800', marginTop: 6 },
  aboutDescription: { fontSize: 12, lineHeight: 20, textAlign: 'center', paddingHorizontal: 15 },
  onboardingBackdrop: { flex: 1, backgroundColor: 'rgba(5, 15, 28, 0.62)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  onboardingCard: { width: '100%', borderRadius: 26, padding: 24, alignItems: 'center' },
  onboardingClose: { position: 'absolute', top: 15, right: 15, padding: 7 },
  onboardingIcon: { width: 70, height: 70, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginTop: 8, marginBottom: 16 },
  onboardingKicker: { fontSize: 12, fontWeight: '700' },
  onboardingTitle: { fontSize: 27, fontWeight: '800', marginTop: 3 },
  onboardingBody: { fontSize: 12, textAlign: 'center', lineHeight: 19, marginTop: 8 },
  featureList: { width: '100%', gap: 12, marginTop: 23, marginBottom: 23 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  featureIcon: { width: 34, height: 34, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  featureText: { flex: 1, fontSize: 12, fontWeight: '600' },
  onboardingButton: { minHeight: 52, width: '100%', borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  onboardingButtonText: { fontSize: 14, fontWeight: '800' },
  notice: { position: 'absolute', left: 18, right: 18, bottom: 84, minHeight: 47, borderRadius: 15, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, elevation: 5, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  noticeText: { flex: 1, fontSize: 12, fontWeight: '700' },
  selectionCheck: { position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', zIndex: 5 },
  selectionBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 11, borderTopWidth: 1, elevation: 8, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 14, shadowOffset: { width: 0, height: -4 } },
  selectionCountWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  selectionCount: { fontSize: 13, fontWeight: '800' },
  selectionActions: { flexDirection: 'row', gap: 9 },
  selectionAction: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 17, paddingVertical: 10, borderRadius: 13 },
  selectionActionText: { fontSize: 13, fontWeight: '800' },
  dialogOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 28 },
  dialogCard: { width: '100%', maxWidth: 400, borderRadius: 20, padding: 22, alignItems: 'center' },
  dialogIcon: { width: 58, height: 58, borderRadius: 29, justifyContent: 'center', alignItems: 'center', marginBottom: 13 },
  dialogTitle: { fontSize: 17, fontWeight: '800', marginBottom: 6 },
  dialogBody: { fontSize: 13, textAlign: 'center', marginBottom: 17 },
  dialogButton: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', paddingVertical: 13, borderRadius: 13, marginBottom: 9 },
  convertFormatRow: { flexDirection: 'row', gap: 10, width: '100%', marginBottom: 14 },
  convertFormatCard: { flex: 1, borderWidth: 1.6, borderRadius: 13, paddingVertical: 11, alignItems: 'center', gap: 2 },
  convertFormatLabel: { fontSize: 15, fontWeight: '800' },
  convertFormatDetail: { fontSize: 11 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  moreSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 10, paddingHorizontal: 18 },
  moreHeader: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1 },
  moreHeaderIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  moreHeaderThumbWrap: { width: 62, height: 44, borderRadius: 9, overflow: 'hidden' },
  moreHeaderThumb: { width: '100%', height: '100%' },
  moreHeaderThumbBadge: { position: 'absolute', bottom: 3, left: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.62)', alignItems: 'center', justifyContent: 'center' },
  moreHeaderText: { flex: 1 },
  moreHeaderTitle: { fontSize: 15, fontWeight: '800', textAlign: 'right' },
  moreHeaderMeta: { fontSize: 12, marginTop: 2, textAlign: 'right' },
  moreRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 13, paddingVertical: 13 },
  moreRowIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  moreRowText: { flex: 1, fontSize: 15, fontWeight: '700', textAlign: 'right' },
  moreRowHint: { fontSize: 11 },
  dialogButtonText: { fontSize: 14, fontWeight: '800' },
  dialogCancel: { paddingVertical: 8, marginTop: 3 },
  dialogCancelText: { fontSize: 13, fontWeight: '700' },
  ytBadge: { width: 34, height: 34, borderRadius: 17, justifyContent: 'center', alignItems: 'center' },
  ytSearchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9, marginBottom: 12 },
  ytSearchButton: { width: 36, height: 36, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  ytError: { fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 9 },
  ytList: { flex: 1 },
  ytListEmpty: { flexGrow: 1, justifyContent: 'center' },
  ytEmpty: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  ytEmptyIcon: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginBottom: 4 },
  ytEmptyTitle: { fontSize: 16, fontWeight: '800' },
  ytEmptyHint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 20, lineHeight: 20 },
  ytRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, padding: 9, marginBottom: 9 },
  ytThumbWrap: { position: 'relative' },
  ytThumb: { width: 118, height: 68, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.08)' },
  ytDuration: { position: 'absolute', bottom: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.82)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  ytDurationText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  ytBody: { flex: 1, gap: 3 },
  ytTitle: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  ytMeta: { fontSize: 11 },
  ytDownloadButton: { width: 40, height: 40, borderRadius: 13, justifyContent: 'center', alignItems: 'center' },
  galleryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  galleryClose: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(127,127,127,0.12)' },
  gallerySelectAll: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginBottom: 12, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 11, backgroundColor: 'rgba(127,127,127,0.10)' },
  gallerySelectAllText: { fontSize: 13, fontWeight: '800' },
  galleryCell: { flex: 1 / 3, aspectRatio: 0.82, borderRadius: 12, borderWidth: 2.5, overflow: 'hidden' },
  galleryImage: { width: '100%', height: '100%' },
  galleryCheck: { position: 'absolute', top: 7, right: 7, width: 23, height: 23, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  galleryDownload: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 12 },
  sheetTall: { maxHeight: '78%' },
  rememberRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, marginTop: 4 },
  rememberText: { flex: 1, fontSize: 13, fontWeight: '700', lineHeight: 19 },
  sheetConfirm: { borderRadius: 15, paddingVertical: 15, alignItems: 'center', marginTop: 6 },
  sheetConfirmText: { fontSize: 15, fontWeight: '800' },
});