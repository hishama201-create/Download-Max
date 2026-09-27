/**
 * (إضافة v2.0.12) سجل التنزيلات في قاعدة بيانات SQLite حقيقية — بطلب صاحب التطبيق:
 * ملف قاعدة بيانات موحّد (downloads.db) موجود دائماً في التخزين المشترك داخل
 * «DownloadMax/db/» ليُفتح من أي تطبيق قواعد بيانات على الجهاز — مثل Snaptube.
 *
 * آلية العمل: محرك SQLite الرسمي (expo-sqlite) يفتح قواعده داخل مساحة التطبيق،
 * لذا نسجّل كل تغيير في القاعدة الداخلية فوراً (سريع وآمن)، ثم نأخذ لقطة متسقة
 * عبر backupDatabaseAsync إلى ملف تصدير وننسخه إلى المسار العام.
 * غياب صلاحية «All Files Access» لا يعطل شيئاً — السجل يعمل داخلياً، ويعاد
 * التصدير تلقائياً مع أول كتابة بعد منح الصلاحية.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

/** اسم القاعدة الداخلية (مساحة التطبيق). */
const INTERNAL_DB_NAME = 'download-max-history.db';
/** قاعدة اللقطة المتسقة المصدَّرة (تنسخ بعد كل تغيير إلى التخزين العام). */
const EXPORT_DB_NAME = 'download-max-history-export.db';
/** اسم مجلد قاعدة البيانات في جذر التخزين العام. */
export const DB_DIR_NAME = 'db';
/** اسم ملف القاعدة المصدَّر في التخزين العام. */
export const DB_FILE_NAME = 'downloads.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let exportDbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
/** يزوّدنا بمجلد الجذر العام (يُربط من DownloadContext لتفادي الاستيراد الدائري). */
let publicRootProvider: (() => string | null) | null = null;

export function setPublicRootProvider(provider: () => string | null): void {
  publicRootProvider = provider;
}

/** يفتح (وينشئ) قاعدة السجل الداخلية ويجهّز جدول التنزيلات. */
async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(INTERNAL_DB_NAME);
      await db.execAsync(
        `PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS downloads (
           id TEXT PRIMARY KEY NOT NULL,
           title TEXT NOT NULL,
           url TEXT NOT NULL,
           type TEXT NOT NULL,
           format TEXT NOT NULL,
           quality TEXT,
           status TEXT NOT NULL,
           progress REAL NOT NULL DEFAULT 0,
           bytes_written INTEGER,
           total_bytes INTEGER,
           file_uri TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );`,
      );
      return db;
    })().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** يفتح قاعدة التصدير (تُستبدل محتوياتها بكل مزامنة عبر أمر BACKUP الرسمي). */
async function getExportDb(): Promise<SQLite.SQLiteDatabase> {
  if (!exportDbPromise) {
    exportDbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(EXPORT_DB_NAME);
      await db.execAsync('DROP TABLE IF EXISTS downloads;');
      return db;
    })().catch((error) => {
      exportDbPromise = null;
      throw error;
    });
  }
  return exportDbPromise;
}

/** يأخذ لقطة متسقة من القاعدة وينسخها إلى «DownloadMax/db/downloads.db». */
async function exportNow(): Promise<boolean> {
  try {
    const root = publicRootProvider?.() ?? null;
    if (!root) return false;
    const db = await getDb();
    const exportDb = await getExportDb();
    await SQLite.backupDatabaseAsync({ sourceDatabase: db, destDatabase: exportDb });
    const dir = `${root}${DB_DIR_NAME}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.copyAsync({
      from: `${SQLite.defaultDatabaseDirectory}/${EXPORT_DB_NAME}`,
      to: `${dir}${DB_FILE_NAME}`,
    });
    return true;
  } catch (error) {
    if (__DEV__) console.warn('[historyDb] تعذر تصدير قاعدة السجل:', error);
    return false;
  }
}

/** محاولة تصدير يدوية (تُستدعى بعد منح الصلاحية مثلًا). */
export async function attemptHistoryDbExport(): Promise<boolean> {
  return exportNow();
}

/** صف سجل واحد (يُكتب من DownloadContext عند تغيّر حالة مهمة). */
export type HistoryEntry = {
  id: string;
  title: string;
  url: string;
  type: string;
  format: string;
  quality?: string | null;
  status: string;
  progress: number;
  bytesWritten?: number | null;
  totalBytes?: number | null;
  fileUri?: string | null;
  createdAt: number;
};

/** يسجّل/يحدّث عنصراً في القاعدة ثم يزامن الملف العام. */
export async function upsertHistoryEntry(entry: HistoryEntry): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO downloads (id, title, url, type, format, quality, status, progress, bytes_written, total_bytes, file_uri, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, status=excluded.status, progress=excluded.progress,
         bytes_written=excluded.bytes_written, total_bytes=excluded.total_bytes,
         file_uri=excluded.file_uri, updated_at=excluded.updated_at`,
      entry.id,
      entry.title,
      entry.url,
      entry.type,
      entry.format,
      entry.quality ?? null,
      entry.status,
      entry.progress,
      entry.bytesWritten ?? null,
      entry.totalBytes ?? null,
      entry.fileUri ?? null,
      entry.createdAt,
      Date.now(),
    );
    void exportNow();
  } catch (error) {
    if (__DEV__) console.warn('[historyDb] تعذر تسجيل العنصر:', error);
  }
}

/** يحذف عنصراً من السجل (حذف نهائي من السلة أو تفريغ السلة). */
export async function deleteHistoryEntry(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync('DELETE FROM downloads WHERE id = ?', id);
    void exportNow();
  } catch (error) {
    if (__DEV__) console.warn('[historyDb] تعذر حذف العنصر من السجل:', error);
  }
}

/** مزامنة دفعية عند فتح التطبيق: تمرير كل العناصر الحية ثم تصدير واحد. */
export async function syncHistorySnapshot(entries: HistoryEntry[]): Promise<void> {
  try {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const entry of entries) {
        await db.runAsync(
          `INSERT INTO downloads (id, title, url, type, format, quality, status, progress, bytes_written, total_bytes, file_uri, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, status=excluded.status, progress=excluded.progress,
             bytes_written=excluded.bytes_written, total_bytes=excluded.total_bytes,
             file_uri=excluded.file_uri, updated_at=excluded.updated_at`,
          entry.id,
          entry.title,
          entry.url,
          entry.type,
          entry.format,
          entry.quality ?? null,
          entry.status,
          entry.progress,
          entry.bytesWritten ?? null,
          entry.totalBytes ?? null,
          entry.fileUri ?? null,
          entry.createdAt,
          Date.now(),
        );
      }
    });
    void exportNow();
  } catch (error) {
    if (__DEV__) console.warn('[historyDb] تعذر مزامنة السجل:', error);
  }
}
