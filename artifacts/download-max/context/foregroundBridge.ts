import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { DownloadItem } from './types';

// — (v2.0.29) جسر الخدمة الأمامية من v2.0.26: يرفع أولوية التطبيق أثناء التنزيل —
// بحيث لا يجمد أندرويد (Doze) الشبكة خلف تطبيقات أخرى أو شاشة مقفلة.
type ForegroundDownloadBridge = {
  upsertDownload: (id: string, title: string, fileUri: string, totalBytes: number, paused: boolean) => void;
  updateDownload: (id: string, title: string, fileUri: string, totalBytes: number, paused: boolean) => void;
  removeDownload: (id: string) => void;
  consumePendingActions: () => Promise<{ id: string; action: string }[]>;
};

export const foregroundDownloadNativeModule = NativeModules.DownloadForeground;
export const foregroundDownloadBridge = foregroundDownloadNativeModule as ForegroundDownloadBridge | undefined;
let notificationPermissionRequested = false;

export async function requestDownloadNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  try {
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) return true;
    if (notificationPermissionRequested) return false;
    notificationPermissionRequested = true;
    return (await PermissionsAndroid.request(permission, {
      title: 'إشعارات التنزيلات',
      message: 'اسمح بالإشعارات لمتابعة تقدم التنزيل والتحكم به عند استخدام تطبيقات أخرى.',
      buttonPositive: 'السماح',
      buttonNegative: 'ليس الآن',
    })) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function updateForegroundDownload(item: DownloadItem, fileUri = '', totalBytes = item.totalBytes ?? 0, paused = false) {
  if (Platform.OS !== 'android') return;
  try {
    foregroundDownloadBridge?.updateDownload(item.id, item.title, fileUri, totalBytes, paused);
  } catch {
    // الإشعار واجهة مساعدة؛ لا نوقف التنزيل إن تعذر تحديثه.
  }
}

export function upsertForegroundDownload(item: DownloadItem, fileUri = '', totalBytes = item.totalBytes ?? 0, paused = false) {
  if (Platform.OS !== 'android') return;
  try {
    foregroundDownloadBridge?.upsertDownload(item.id, item.title, fileUri, totalBytes, paused);
  } catch {
    // الإشعار واجهة مساعدة؛ لا نوقف التنزيل إن تعذر تشغيله.
  }
}

export function removeForegroundDownload(id: string) {
  if (Platform.OS !== 'android') return;
  try {
    foregroundDownloadBridge?.removeDownload(id);
  } catch {
    // لا يؤثر فشل تنظيف الإشعار في سجل التنزيل.
  }
}
