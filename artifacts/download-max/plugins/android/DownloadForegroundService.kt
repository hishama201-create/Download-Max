package com.anonymous.downloadmax

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.ViewManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.LinkedHashMap

private const val CHANNEL_ID = "download-max-active-downloads"
private const val CHANNEL_NAME = "التنزيلات النشطة"
private const val COMPLETED_CHANNEL_ID = "download-max-completed-downloads"
private const val COMPLETED_CHANNEL_NAME = "اكتملت التنزيلات"
private const val FOREGROUND_NOTIFICATION_ID = 26026
private const val PREFS_NAME = "download_max_background"
private const val PENDING_ACTIONS_KEY = "pending_download_actions"
private const val ACTION_UPSERT = "com.anonymous.downloadmax.UPSERT"
private const val ACTION_REMOVE = "com.anonymous.downloadmax.REMOVE"
private const val ACTION_CONTROL = "com.anonymous.downloadmax.CONTROL"
private const val ACTION_COMPLETED = "com.anonymous.downloadmax.COMPLETED"
private const val EVENT_NAME = "DownloadForegroundAction"

private data class BackgroundDownload(
  val id: String,
  var title: String,
  var fileUri: String,
  var totalBytes: Long,
  var paused: Boolean,
  var bytesWritten: Long = 0L,
)

/**
 * Notification action bridge. If React Native is not available yet, the action
 * is queued in private app storage and delivered when the JS provider starts.
 */
private object DownloadForegroundBridge {
  @Volatile var reactContext: ReactApplicationContext? = null

  fun emit(context: Context, id: String, action: String) {
    val payload = Arguments.createMap().apply {
      putString("id", id)
      putString("action", action)
    }
    val activeContext = reactContext
    try {
      if (activeContext != null && activeContext.hasActiveCatalystInstance()) {
        activeContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_NAME, payload)
        return
      }
    } catch (_: Exception) {
      // Persist below if the bridge is tearing down.
    }
    val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val actions = try {
      JSONArray(preferences.getString(PENDING_ACTIONS_KEY, "[]") ?: "[]")
    } catch (_: Exception) {
      JSONArray()
    }
    actions.put(JSONObject().put("id", id).put("action", action))
    preferences.edit().putString(PENDING_ACTIONS_KEY, actions.toString()).apply()
  }

  fun consume(context: Context): WritableArray {
    val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val stored = preferences.getString(PENDING_ACTIONS_KEY, "[]") ?: "[]"
    preferences.edit().remove(PENDING_ACTIONS_KEY).apply()
    val output = Arguments.createArray()
    try {
      val actions = JSONArray(stored)
      for (index in 0 until actions.length()) {
        val action = actions.optJSONObject(index) ?: continue
        output.pushMap(Arguments.createMap().apply {
          putString("id", action.optString("id"))
          putString("action", action.optString("action"))
        })
      }
    } catch (_: Exception) {
      // Drop malformed stale actions; current queue state remains authoritative.
    }
    return output
  }
}

class DownloadForegroundServicePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(DownloadForegroundModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}

class DownloadForegroundModule(
  private val appContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(appContext) {
  init {
    DownloadForegroundBridge.reactContext = appContext
  }

  override fun getName(): String = "DownloadForeground"

  @ReactMethod
  fun upsertDownload(id: String, title: String, fileUri: String, totalBytes: Double, paused: Boolean) {
    val intent = Intent(appContext, DownloadForegroundService::class.java).apply {
      action = ACTION_UPSERT
      putExtra("id", id)
      putExtra("title", title)
      putExtra("fileUri", fileUri)
      putExtra("totalBytes", totalBytes.toLong())
      putExtra("paused", paused)
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) appContext.startForegroundService(intent)
      else appContext.startService(intent)
    } catch (_: Exception) {
      // A failed notification must not prevent the actual file download.
    }
  }

  @ReactMethod
  fun updateDownload(id: String, title: String, fileUri: String, totalBytes: Double, paused: Boolean) {
    val intent = Intent(appContext, DownloadForegroundService::class.java).apply {
      action = ACTION_UPSERT
      putExtra("id", id)
      putExtra("title", title)
      putExtra("fileUri", fileUri)
      putExtra("totalBytes", totalBytes.toLong())
      putExtra("paused", paused)
    }
    try {
      appContext.startService(intent)
    } catch (_: Exception) {
      // The foreground service is started by upsertDownload before progress updates.
    }
  }

  @ReactMethod
  fun removeDownload(id: String) {
    val intent = Intent(appContext, DownloadForegroundService::class.java).apply {
      action = ACTION_REMOVE
      putExtra("id", id)
    }
    try {
      appContext.startService(intent)
    } catch (_: Exception) {
      // The service may already have stopped during completion.
    }
  }

  @ReactMethod
  fun showCompletedNotification(id: String, title: String) {
    val intent = Intent(appContext, DownloadForegroundService::class.java).apply {
      action = ACTION_COMPLETED
      putExtra("id", id)
      putExtra("title", title)
    }
    try {
      appContext.startService(intent)
    } catch (_: Exception) {
      // Notifications are best-effort and must not affect the completed file.
    }
  }

  @ReactMethod
  fun consumePendingActions(promise: Promise) {
    promise.resolve(DownloadForegroundBridge.consume(appContext))
  }

  @ReactMethod
  fun addListener(_eventName: String) {
    // Required by NativeEventEmitter's native-module contract.
  }

  @ReactMethod
  fun removeListeners(_count: Double) {
    // Required by NativeEventEmitter's native-module contract.
  }

  /** Share one downloaded item through Android's sharesheet. */
  @ReactMethod
  fun shareSingleFile(fileUri: String, mimeType: String, promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject("E_SHARE_NO_ACTIVITY", "لا توجد نافذة نشطة لفتح لوحة المشاركة")
      return
    }

    val uri = Uri.parse(fileUri.trim())
    if (fileUri.isBlank() || uri.scheme != "content") {
      promise.reject("E_SHARE_INVALID_URI", "رابط الملف غير صالح للمشاركة")
      return
    }

    val safeMimeType = mimeType.trim().takeIf { it.contains('/') } ?: "*/*"
    try {
      val sendIntent = Intent(Intent.ACTION_SEND).apply {
        type = safeMimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newUri(appContext.contentResolver, "Download Max", uri)
      }
      val chooser = Intent.createChooser(sendIntent, "مشاركة الملف").apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.runOnUiThread {
        try {
          activity.startActivity(chooser)
          promise.resolve(true)
        } catch (error: Exception) {
          promise.reject("E_SHARE_SINGLE_FAILED", error.message ?: "تعذّرت مشاركة الملف", error)
        }
      }
    } catch (error: Exception) {
      promise.reject("E_SHARE_SINGLE_FAILED", error.message ?: "تعذّرت مشاركة الملف", error)
    }
  }

  /** Share all selected media in one Android sharesheet intent. */
  @ReactMethod
  fun shareMultipleFiles(fileUris: ReadableArray, mimeTypes: ReadableArray, promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject("E_SHARE_NO_ACTIVITY", "لا توجد نافذة نشطة لفتح لوحة المشاركة")
      return
    }

    val uris = ArrayList<Uri>()
    for (index in 0 until fileUris.size()) {
      val rawUri = fileUris.getString(index)?.trim()
      if (!rawUri.isNullOrEmpty()) uris.add(Uri.parse(rawUri))
    }
    if (uris.isEmpty()) {
      promise.reject("E_SHARE_NO_FILES", "لا توجد ملفات صالحة للمشاركة")
      return
    }

    val types = (0 until mimeTypes.size())
      .mapNotNull { index -> mimeTypes.getString(index)?.trim()?.takeIf { it.contains('/') } }
      .distinct()
    val majorTypes = types.map { it.substringBefore('/') }.distinct()
    val intentType = if (majorTypes.size == 1) "${majorTypes.first()}/*" else "*/*"

    try {
      val shareIntent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        type = intentType
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        val sharedItems = ClipData.newUri(appContext.contentResolver, "Download Max", uris.first())
        for (index in 1 until uris.size) sharedItems.addItem(ClipData.Item(uris[index]))
        clipData = sharedItems
      }
      val chooser = Intent.createChooser(shareIntent, "مشاركة ${uris.size} ملفات").apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.runOnUiThread {
        try {
          activity.startActivity(chooser)
          promise.resolve(true)
        } catch (error: Exception) {
          promise.reject("E_SHARE_MULTIPLE_FAILED", error.message ?: "تعذّرت مشاركة الملفات", error)
        }
      }
    } catch (error: Exception) {
      promise.reject("E_SHARE_MULTIPLE_FAILED", error.message ?: "تعذّرت مشاركة الملفات", error)
    }
  }
}

class DownloadForegroundService : Service() {
  private val downloads = LinkedHashMap<String, BackgroundDownload>()
  private val handler = Handler(Looper.getMainLooper())
  private var foregroundStarted = false

  private val progressTick = object : Runnable {
    override fun run() {
      refreshFileSizes()
      if (downloads.isNotEmpty()) {
        updateNotifications()
        handler.postDelayed(this, 1000L)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_UPSERT -> {
        val id = intent.getStringExtra("id") ?: return START_NOT_STICKY
        val item = downloads[id] ?: BackgroundDownload(id, "", "", 0L, false)
        item.title = intent.getStringExtra("title") ?: item.title
        val fileUri = intent.getStringExtra("fileUri")
        if (!fileUri.isNullOrBlank()) item.fileUri = fileUri
        val totalBytes = intent.getLongExtra("totalBytes", item.totalBytes)
        if (totalBytes > 0 || item.totalBytes == 0L) item.totalBytes = totalBytes
        item.paused = intent.getBooleanExtra("paused", item.paused)
        downloads[id] = item
      }
      ACTION_REMOVE -> {
        intent.getStringExtra("id")?.let { downloads.remove(it) }
      }
      ACTION_CONTROL -> handleNotificationAction(intent)
      ACTION_COMPLETED -> {
        val id = intent.getStringExtra("id") ?: return START_NOT_STICKY
        showCompletedNotification(id, intent.getStringExtra("title").orEmpty())
      }
    }

    if (downloads.isEmpty()) {
      handler.removeCallbacks(progressTick)
      if (foregroundStarted) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
      }
      stopSelf(startId)
      return START_NOT_STICKY
    }

    refreshFileSizes()
    updateNotifications()
    handler.removeCallbacks(progressTick)
    handler.postDelayed(progressTick, 1000L)
    return START_NOT_STICKY
  }

  private fun handleNotificationAction(intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    val command = intent.getStringExtra("command") ?: return
    val item = downloads[id]
    when (command) {
      "pause" -> {
        if (item != null) item.paused = true
        DownloadForegroundBridge.emit(this, id, "pause")
      }
      "resume" -> {
        if (item != null) item.paused = false
        DownloadForegroundBridge.emit(this, id, "resume")
      }
      "cancel" -> {
        downloads.remove(id)
        DownloadForegroundBridge.emit(this, id, "cancel")
      }
    }
  }

  private fun refreshFileSizes() {
    for (item in downloads.values) {
      val path = try {
        Uri.parse(item.fileUri).path
      } catch (_: Exception) {
        null
      }
      if (!path.isNullOrBlank()) {
        val file = File(path)
        if (file.exists()) item.bytesWritten = file.length()
      }
    }
  }

  private fun currentItem(): BackgroundDownload? =
    downloads.values.firstOrNull { !it.paused } ?: downloads.values.firstOrNull()

  private fun formatBytes(bytes: Long): String {
    val safeBytes = bytes.coerceAtLeast(0L)
    return when {
      safeBytes < 1024L -> safeBytes.toString() + " B"
      safeBytes < 1024L * 1024L -> (safeBytes / 1024L).toString() + " KB"
      else -> String.format(java.util.Locale.US, "%.1f MB", safeBytes / (1024.0 * 1024.0))
    }
  }

  private fun updateNotifications() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val item = currentItem() ?: return
    val activeCount = downloads.values.count { !it.paused }
    val totalKnown = item.totalBytes > 0
    val progress = if (totalKnown) {
      ((item.bytesWritten.toDouble() / item.totalBytes.toDouble()) * 100.0).toInt().coerceIn(0, 99)
    } else 0
    val stateText = if (item.paused) "متوقف مؤقتاً" else "جارٍ التنزيل"
    val title = if (downloads.size > 1) "Download Max · ${downloads.size} تنزيلات" else item.title
    val progressDetail = if (totalKnown) {
      progress.toString() + "% · " + formatBytes(item.bytesWritten) + " / " + formatBytes(item.totalBytes)
    } else if (item.bytesWritten > 0L) {
      formatBytes(item.bytesWritten)
    } else null
    val text = if (progressDetail != null) stateText + " · " + progressDetail else stateText
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(
        launchIntent?.let { PendingIntent.getActivity(this, 26026, it, pendingIntentFlags()) },
      )
      .setProgress(100, progress, !totalKnown && !item.paused)

    if (activeCount > 0) {
      builder.addAction(
        android.R.drawable.ic_media_pause,
        "إيقاف مؤقت",
        controlIntent(item.id, "pause"),
      )
    } else {
      builder.addAction(
        android.R.drawable.ic_media_play,
        "استئناف",
        controlIntent(item.id, "resume"),
      )
    }
    builder.addAction(
      android.R.drawable.ic_menu_close_clear_cancel,
      "إلغاء",
      controlIntent(item.id, "cancel"),
    )
    val notification = builder.build()
    if (!foregroundStarted) {
      startForeground(FOREGROUND_NOTIFICATION_ID, notification)
      foregroundStarted = true
    } else {
      manager.notify(FOREGROUND_NOTIFICATION_ID, notification)
    }
  }

  private fun showCompletedNotification(id: String, title: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      data = Uri.parse("download-max:///?openDownload=${Uri.encode(id)}")
    }
    val requestCode = 50_000 + (id.hashCode() and 0x3fff)
    val openPendingIntent = launchIntent?.let {
      PendingIntent.getActivity(this, requestCode, it, pendingIntentFlags())
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, COMPLETED_CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(title.ifBlank { "اكتمل التنزيل" })
      .setContentText("اكتمل التنزيل — انقر للتشغيل")
      .setCategory(Notification.CATEGORY_STATUS)
      .setAutoCancel(true)
      .setOngoing(false)
      .setOnlyAlertOnce(true)

    if (openPendingIntent != null) {
      builder.setContentIntent(openPendingIntent)
      builder.addAction(android.R.drawable.ic_media_play, "انقر للتشغيل", openPendingIntent)
    }
    manager.notify(50_000 + (id.hashCode() and 0x3fff), builder.build())
  }

  private fun controlIntent(id: String, command: String): PendingIntent {
    val intent = Intent(this, DownloadForegroundService::class.java).apply {
      action = ACTION_CONTROL
      data = Uri.parse("downloadmax://$id/$command")
      putExtra("id", id)
      putExtra("command", command)
    }
    return PendingIntent.getService(
      this,
      "$id:$command".hashCode(),
      intent,
      pendingIntentFlags(),
    )
  }

  private fun pendingIntentFlags(): Int =
    PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
      description = "إشعار مستمر لمتابعة التنزيلات والتحكم بها"
      setShowBadge(false)
    }
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(channel)
    val completedChannel = NotificationChannel(
      COMPLETED_CHANNEL_ID,
      COMPLETED_CHANNEL_NAME,
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "إشعار باسم الملف المكتمل وزر لفتحه"
      setShowBadge(true)
    }
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(completedChannel)
  }

  override fun onDestroy() {
    handler.removeCallbacks(progressTick)
    super.onDestroy()
  }
}