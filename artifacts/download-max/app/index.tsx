import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useIncomingShare } from 'expo-sharing';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DownloadItem, MediaType, useDownloads } from '@/context/DownloadContext';
import { AccentKey, accentSwatches, ThemeMode, useAppSettings } from '@/context/SettingsContext';

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

const typeLabels: Record<MediaType, string> = { video: 'فيديو', audio: 'صوت', image: 'صورة' };
const typeIcons: Record<MediaType, keyof typeof Feather.glyphMap> = { video: 'video', audio: 'headphones', image: 'image' };

function extractUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '') ?? value.trim();
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

function formatBytes(value?: number) {
  if (!value) return '—';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function useSafeIncomingShare() {
  if (Platform.OS === 'web') {
    return {
      resolvedSharedPayloads: [] as { contentUri: string | null; value: string }[],
      clearSharedPayloads: () => undefined,
    };
  }
  return useIncomingShare();
}

function DownloadRow({ item, onRetry, onRemove, onShare }: {
  item: DownloadItem;
  onRetry: () => void;
  onRemove: () => void;
  onShare: () => void;
}) {
  const colors = useColors();
  const isActive = item.status === 'downloading' || item.status === 'queued';
  const iconColor = item.status === 'completed' ? colors.accentForeground : item.status === 'failed' ? colors.destructive : colors.primary;
  return (
    <View style={[styles.downloadRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.fileIcon, { backgroundColor: `${iconColor}16` }]}>
        <Feather name={typeIcons[item.type]} size={19} color={iconColor} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.cardForeground }]} numberOfLines={1}>{item.title}</Text>
        <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
          {typeLabels[item.type]} · {item.format.toUpperCase()} · {item.status === 'completed' ? 'اكتمل' : item.status === 'failed' ? 'تعذر التحميل' : isActive ? 'جارٍ التحميل' : 'في الانتظار'}
        </Text>
        {isActive ? (
          <View style={[styles.progressTrack, { backgroundColor: colors.muted }]}>
            <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${Math.max(item.progress * 100, 8)}%` }]} />
          </View>
        ) : item.error ? (
          <Text style={[styles.errorText, { color: colors.destructive }]} numberOfLines={2}>{item.error}</Text>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        {item.status === 'completed' && item.fileUri ? (
          <Pressable testID="share-file" accessibilityLabel="مشاركة الملف" onPress={onShare} style={styles.iconButton}>
            <Feather name="share-2" size={18} color={colors.primary} />
          </Pressable>
        ) : item.status === 'failed' ? (
          <Pressable testID="retry-download" accessibilityLabel="إعادة المحاولة" onPress={onRetry} style={styles.iconButton}>
            <Feather name="refresh-cw" size={18} color={colors.primary} />
          </Pressable>
        ) : (
          <ActivityIndicator size="small" color={colors.primary} />
        )}
        <Pressable testID="remove-download" accessibilityLabel="حذف من السجل" onPress={onRemove} style={styles.iconButton}>
          <Feather name="x" size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

type Palette = ReturnType<typeof useColors>;

function FeatureRow({ icon, text, colors }: { icon: keyof typeof Feather.glyphMap; text: string; colors: Palette }) {
  return <View style={styles.featureRow}><View style={[styles.featureIcon, { backgroundColor: `${colors.primary}14` }]}><Feather name={icon} size={16} color={colors.primary} /></View><Text style={[styles.featureText, { color: colors.foreground }]}>{text}</Text></View>;
}

function SettingsPanel({ colors, themeMode, accent, onThemeChange, onAccentChange, onBack }: {
  colors: Palette;
  themeMode: ThemeMode;
  accent: AccentKey;
  onThemeChange: (mode: ThemeMode) => void;
  onAccentChange: (value: AccentKey) => void;
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
    <View style={[styles.settingsNote, { backgroundColor: colors.background, borderColor: colors.border }]}><Feather name="info" size={17} color={colors.primary} /><Text style={[styles.settingsNoteText, { color: colors.mutedForeground }]}>يتم حفظ اختياراتك تلقائياً على هذا الجهاز.</Text></View>
  </Pressable>;
}

function AboutPanel({ colors, onBack }: { colors: Palette; onBack: () => void }) {
  return <Pressable style={[styles.settingsPanel, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
    <View style={styles.panelHeader}><Pressable onPress={onBack} style={styles.backButton}><Feather name="arrow-right" size={21} color={colors.foreground} /></Pressable><Text style={[styles.panelTitle, { color: colors.foreground }]}>حول التطبيق</Text><View style={{ width: 34 }} /></View>
    <View style={styles.aboutHero}><View style={[styles.aboutMark, { backgroundColor: colors.primary }]}><Feather name="arrow-down" size={31} color={colors.primaryForeground} /></View><Text style={[styles.aboutName, { color: colors.foreground }]}>Download <Text style={{ color: colors.primary }}>Max</Text></Text><Text style={[styles.aboutVersion, { color: colors.mutedForeground }]}>الإصدار 1.0.0</Text></View>
    <View style={[styles.aboutCard, { backgroundColor: colors.background, borderColor: colors.border }]}><Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>المطور</Text><Text style={[styles.aboutDeveloper, { color: colors.foreground }]}>هشام الصبري</Text></View>
    <Text style={[styles.aboutDescription, { color: colors.mutedForeground }]}>تطبيق يساعدك على تنظيم تنزيلاتك من الروابط المسموح باستخدامها، مع تجربة بسيطة وسريعة.</Text>
  </Pressable>;
}

export default function HomeScreen() {
  const colors = useColors();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const { items, activeCount, addDownload, retryDownload, removeDownload, clearCompleted } = useDownloads();
  const { themeMode, accent, hasSeenOnboarding, setThemeMode, setAccent, completeOnboarding } = useAppSettings();
  const { resolvedSharedPayloads, clearSharedPayloads } = useSafeIncomingShare();
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<'home' | 'downloads'>('home');
  const [mediaFilter, setMediaFilter] = useState<MediaType | 'all'>('all');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [selectedFormat, setSelectedFormat] = useState('mp4');
  const [showFormatSheet, setShowFormatSheet] = useState(false);
  const [panel, setPanel] = useState<'menu' | 'settings' | 'about' | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const shared = resolvedSharedPayloads[0];
    if (!shared) return;
    const value = shared.contentUri ?? shared.value;
    if (value) {
      setInput(value);
      setActiveTab('home');
      setNotice('تم استلام الرابط من المشاركة');
      clearSharedPayloads();
    }
  }, [resolvedSharedPayloads, clearSharedPayloads]);

  const url = extractUrl(input);
  const hasValidUrl = /^https?:\/\/\S+$/i.test(url);
  const selectedOption = formats[mediaType].find((option) => option.format === selectedFormat) ?? formats[mediaType][0];
  const downloadItems = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const filteredItems = useMemo(
    () => mediaFilter === 'all' ? downloadItems : downloadItems.filter((item) => item.type === mediaFilter),
    [downloadItems, mediaFilter],
  );

  function changeType(type: MediaType) {
    setMediaType(type);
    setSelectedFormat(formats[type][0].format);
    void Haptics.selectionAsync();
  }

  async function handleDownload() {
    Keyboard.dismiss();
    if (!hasValidUrl) {
      setNotice('ألصق رابطاً صحيحاً يبدأ بـ https://');
      return;
    }
    await addDownload({
      url,
      title: guessedTitle(url),
      type: mediaType,
      format: selectedOption.format,
      quality: mediaType === 'audio' ? 'أفضل جودة متاحة' : 'المصدر الأصلي',
    });
    setNotice('أُضيف التحميل إلى القائمة');
    setActiveTab('downloads');
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    setIsRefreshing(false);
  }

  function showShare(item: DownloadItem) {
    if (item.fileUri) void Share.share({ url: item.fileUri, message: item.title });
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
                  </View>
                  <View style={[styles.heroOrb, { borderColor: `${colors.primary}28` }]}>
                    <Feather name="arrow-down" size={46} color={colors.primary} />
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
                  <Feather name="sliders" size={19} color={colors.mutedForeground} />
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
        ) : (
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
                    <Text style={[styles.pageSubtitle, { color: colors.mutedForeground }]}>{downloadItems.length ? `${downloadItems.length} ملفات في السجل` : 'كل ما نزلته يظهر هنا'}</Text>
                  </View>
                  {downloadItems.some((item) => item.status === 'completed') ? <Pressable onPress={clearCompleted}><Text style={[styles.clearCompleted, { color: colors.primary }]}>مسح المكتمل</Text></Pressable> : null}
                </View>
                <View style={styles.filterRow}>
                  {([{ key: 'all', label: 'الكل', icon: 'grid' }, { key: 'video', label: 'فيديو', icon: 'video' }, { key: 'audio', label: 'صوت', icon: 'headphones' }, { key: 'image', label: 'صور', icon: 'image' }] as { key: MediaType | 'all'; label: string; icon: keyof typeof Feather.glyphMap }[]).map((filter) => <Pressable key={filter.key} onPress={() => setMediaFilter(filter.key)} style={[styles.filterChip, { backgroundColor: mediaFilter === filter.key ? colors.primary : colors.card, borderColor: mediaFilter === filter.key ? colors.primary : colors.border }]}><Feather name={filter.icon} size={14} color={mediaFilter === filter.key ? colors.primaryForeground : colors.mutedForeground} /><Text style={[styles.filterText, { color: mediaFilter === filter.key ? colors.primaryForeground : colors.mutedForeground }]}>{filter.label}</Text></Pressable>)}
                </View>
              </>
            }
            ListHeaderComponentStyle={styles.listHeader}
            ListEmptyComponent={<View style={[styles.emptyState, { backgroundColor: colors.card, borderColor: colors.border }]}><View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}><Feather name="download-cloud" size={28} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>{downloadItems.length ? 'لا توجد ملفات من هذا النوع' : 'لا توجد تنزيلات بعد'}</Text><Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>{downloadItems.length ? 'اختر تصنيفاً آخر لمشاهدة ملفاتك.' : 'ألصق رابطاً من الشاشة الرئيسية وابدأ أول تنزيل لك.'}</Text><Pressable onPress={() => setActiveTab('home')} style={[styles.emptyButton, { backgroundColor: colors.primary }]}><Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>إضافة رابط</Text></Pressable></View>}
            renderItem={({ item }) => <DownloadRow item={item} onRetry={() => void retryDownload(item.id)} onRemove={() => void removeDownload(item.id)} onShare={() => showShare(item)} />}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          />
        )}
      </View>

      <View style={[styles.bottomNav, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Platform.OS === 'web' ? 34 : Math.max(insets.bottom, 10) }]}>
        <Pressable testID="tab-home" accessibilityLabel="الرئيسية" onPress={() => setActiveTab('home')} style={styles.navItem}>
          <Feather name="home" size={21} color={activeTab === 'home' ? colors.primary : colors.mutedForeground} />
          <Text style={[styles.navLabel, { color: activeTab === 'home' ? colors.primary : colors.mutedForeground }]}>الرئيسية</Text>
        </Pressable>
        <Pressable testID="tab-downloads" accessibilityLabel="التنزيلات" onPress={() => setActiveTab('downloads')} style={styles.navItem}>
          <View><Feather name="download" size={21} color={activeTab === 'downloads' ? colors.primary : colors.mutedForeground} />{activeCount > 0 ? <View style={[styles.navDot, { backgroundColor: colors.primary }]} /> : null}</View>
          <Text style={[styles.navLabel, { color: activeTab === 'downloads' ? colors.primary : colors.mutedForeground }]}>التنزيلات</Text>
        </Pressable>
      </View>

      <Modal visible={showFormatSheet} transparent animationType="slide" onRequestClose={() => setShowFormatSheet(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowFormatSheet(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>اختر الصيغة</Text>
            {formats[mediaType].map((option) => {
              const selected = option.format === selectedFormat;
              return <TouchableOpacity key={option.format} testID={`format-${option.format}`} onPress={() => { setSelectedFormat(option.format); setShowFormatSheet(false); }} style={[styles.optionRow, { borderColor: colors.border }]}>
                <View style={[styles.optionRadio, { borderColor: selected ? colors.primary : colors.input }]}>{selected ? <View style={[styles.optionRadioInner, { backgroundColor: colors.primary }]} /> : null}</View>
                <View style={styles.optionCopy}><Text style={[styles.optionTitle, { color: colors.foreground }]}>{option.label}</Text><Text style={[styles.optionDetail, { color: colors.mutedForeground }]}>{option.detail}</Text></View>
                {selected ? <Feather name="check" size={19} color={colors.primary} /> : null}
              </TouchableOpacity>;
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={panel !== null} transparent animationType="slide" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setPanel(null)}>
          {panel === 'menu' ? (
            <Pressable style={[styles.drawer, { backgroundColor: colors.card }]} onPress={(event) => event.stopPropagation()}>
              <View style={styles.drawerHeader}><View style={[styles.drawerMark, { backgroundColor: colors.primary }]}><Feather name="arrow-down" size={18} color={colors.primaryForeground} /></View><View><Text style={[styles.drawerTitle, { color: colors.foreground }]}>Download <Text style={{ color: colors.primary }}>Max</Text></Text><Text style={[styles.drawerSubtitle, { color: colors.mutedForeground }]}>مركز التحكم</Text></View><Pressable onPress={() => setPanel(null)} style={styles.closeButton}><Feather name="x" size={21} color={colors.mutedForeground} /></Pressable></View>
              <View style={[styles.drawerDivider, { backgroundColor: colors.border }]} />
              <Pressable onPress={() => { setPanel(null); setActiveTab('home'); }} style={styles.menuItem}><Feather name="home" size={20} color={colors.primary} /><Text style={[styles.menuItemText, { color: colors.foreground }]}>الرئيسية</Text><Feather name="chevron-left" size={17} color={colors.mutedForeground} /></Pressable>
              <Pressable onPress={() => { setPanel(null); setActiveTab('downloads'); }} style={styles.menuItem}><Feather name="download" size={20} color={colors.primary} /><Text style={[styles.menuItemText, { color: colors.foreground }]}>التنزيلات</Text><Feather name="chevron-left" size={17} color={colors.mutedForeground} /></Pressable>
              <Pressable onPress={() => setPanel('settings')} style={styles.menuItem}><Feather name="sliders" size={20} color={colors.primary} /><Text style={[styles.menuItemText, { color: colors.foreground }]}>الإعدادات</Text><Feather name="chevron-left" size={17} color={colors.mutedForeground} /></Pressable>
              <Pressable onPress={() => setPanel('about')} style={styles.menuItem}><Feather name="info" size={20} color={colors.primary} /><Text style={[styles.menuItemText, { color: colors.foreground }]}>حول التطبيق</Text><Feather name="chevron-left" size={17} color={colors.mutedForeground} /></Pressable>
              <View style={styles.drawerFooter}><Text style={[styles.drawerFooterText, { color: colors.mutedForeground }]}>الإصدار 1.0.0</Text><Text style={[styles.drawerFooterText, { color: colors.mutedForeground }]}>صُنع بعناية</Text></View>
            </Pressable>
          ) : panel === 'settings' ? (
            <SettingsPanel colors={colors} themeMode={themeMode} accent={accent} onThemeChange={setThemeMode} onAccentChange={setAccent} onBack={() => setPanel('menu')} />
          ) : (
            <AboutPanel colors={colors} onBack={() => setPanel('menu')} />
          )}
        </Pressable>
      </Modal>

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
  heroOrb: { width: 112, height: 112, borderRadius: 56, borderWidth: 18, justifyContent: 'center', alignItems: 'center', opacity: 0.9, marginRight: -35 },
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
  clearCompleted: { fontSize: 12, fontWeight: '700', paddingBottom: 3 },
  filterRow: { flexDirection: 'row', gap: 7, marginBottom: 8 },
  filterChip: { minHeight: 34, borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  filterText: { fontSize: 11, fontWeight: '700' },
  downloadRow: { borderRadius: 17, borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center' },
  fileIcon: { width: 42, height: 42, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  rowBody: { flex: 1, marginLeft: 11, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: '800' },
  rowMeta: { fontSize: 10, marginTop: 4 },
  progressTrack: { height: 4, borderRadius: 3, marginTop: 9, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
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
  menuItem: { minHeight: 57, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 12 },
  menuItemText: { flex: 1, fontSize: 14, fontWeight: '700' },
  drawerFooter: { marginTop: 'auto', paddingBottom: 35, flexDirection: 'row', justifyContent: 'space-between' },
  drawerFooterText: { fontSize: 10 },
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
});