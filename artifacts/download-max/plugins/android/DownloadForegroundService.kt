package com.anonymous.downloadmax

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

data class DownloadEntry(
    val id: String,
    var title: String,
    var fileUri: String,
    var totalBytes: Long,
    var paused: Boolean
)

object DownloadState {
    private val entries = LinkedHashMap<String, DownloadEntry>()
    private val pending = ArrayList<Pair<String, String>>()

    @Synchronized
    fun put(id: String, title: String, fileUri: String, totalBytes: Long, paused: Boolean) {
        val existing = entries[id]
        if (existing == null) {
            entries[id] = DownloadEntry(id, title, fileUri, totalBytes, paused)
        } else {
            existing.title = title
            if (fileUri.isNotEmpty()) existing.fileUri = fileUri
            existing.totalBytes = totalBytes
            existing.paused = paused
        }
    }

    @Synchronized
    fun setPaused(id: String, paused: Boolean) {
        entries[id]?.paused = paused
    }

    @Synchronized
    fun remove(id: String) {
        entries.remove(id)
    }

    @Synchronized
    fun snapshot(): List<DownloadEntry> = entries.values.map { it.copy() }

    @Synchronized
    fun isEmpty(): Boolean = entries.isEmpty()

    @Synchronized
    fun queue(id: String, action: String) {
        pending.add(Pair(id, action))
    }

    @Synchronized
    fun drain(): List<Pair<String, String>> {
        val copy = ArrayList(pending)
        pending.clear()
        return copy
    }
}

class DownloadForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "download_max_foreground"
        const val NOTIFICATION_ID = 7101
        const val ACTION_SYNC = "com.anonymous.downloadmax.action.SYNC"
        const val ACTION_PAUSE = "com.anonymous.downloadmax.action.PAUSE"
        const val ACTION_RESUME = "com.anonymous.downloadmax.action.RESUME"
        const val ACTION_CANCEL = "com.anonymous.downloadmax.action.CANCEL"
        const val EXTRA_ID = "download_id"

        @Volatile
        var running = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(EXTRA_ID)
        when (intent?.action) {
            ACTION_PAUSE -> if (id != null) {
                DownloadState.setPaused(id, true)
                DownloadState.queue(id, "pause")
            }
            ACTION_RESUME -> if (id != null) {
                DownloadState.setPaused(id, false)
                DownloadState.queue(id, "resume")
            }
            ACTION_CANCEL -> if (id != null) {
                DownloadState.queue(id, "cancel")
                DownloadState.remove(id)
            }
        }

        ensureChannel()

        if (DownloadState.isEmpty()) {
            // يجب استدعاء startForeground أولاً إن بدأت الخدمة عبر startForegroundService.
            try {
                startForegroundCompat(placeholderNotification())
            } catch (_: Exception) {
            }
            running = false
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            startForegroundCompat(buildNotification())
            running = true
        } catch (_: Exception) {
            // قد يمنع النظام بدء خدمة أمامية من الخلفية؛ لا نوقف التنزيل بسبب ذلك.
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "التنزيلات",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }
    }

    private fun immutableFlag(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    private fun contentIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
        )
    }

    private fun actionIntent(action: String, id: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, DownloadForegroundService::class.java)
            .setAction(action)
            .putExtra(EXTRA_ID, id)
        return PendingIntent.getService(
            this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
        )
    }

    private fun placeholderNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Download Max")
            .setOngoing(true)
            .build()

    private fun buildNotification(): Notification {
        val entries = DownloadState.snapshot()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(contentIntent())

        if (entries.size == 1) {
            val entry = entries[0]
            builder.setContentTitle(entry.title)
            if (entry.paused) {
                builder.setContentText("متوقف مؤقتاً")
                builder.setProgress(0, 0, false)
                builder.addAction(
                    android.R.drawable.ic_media_play, "استئناف",
                    actionIntent(ACTION_RESUME, entry.id, 1)
                )
            } else {
                builder.setContentText("جارٍ التنزيل...")
                builder.setProgress(0, 0, true)
                builder.addAction(
                    android.R.drawable.ic_media_pause, "إيقاف مؤقت",
                    actionIntent(ACTION_PAUSE, entry.id, 2)
                )
            }
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel, "إلغاء",
                actionIntent(ACTION_CANCEL, entry.id, 3)
            )
        } else {
            val active = entries.count { !it.paused }
            builder.setContentTitle("Download Max")
            builder.setContentText("${entries.size} تنزيلات (النشطة: $active)")
            builder.setProgress(0, 0, active > 0)
        }
        return builder.build()
    }
}

class DownloadForegroundModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "DownloadForeground"

    private fun sync(onlyIfRunning: Boolean) {
        val ctx = reactContext.applicationContext
        val intent = Intent(ctx, DownloadForegroundService::class.java)
            .setAction(DownloadForegroundService.ACTION_SYNC)
        try {
            if (DownloadForegroundService.running) {
                ctx.startService(intent)
            } else if (!onlyIfRunning) {
                ContextCompat.startForegroundService(ctx, intent)
            }
        } catch (_: Exception) {
        }
    }

    @ReactMethod
    fun upsertDownload(id: String, title: String, fileUri: String, totalBytes: Double, paused: Boolean) {
        DownloadState.put(id, title, fileUri, totalBytes.toLong(), paused)
        sync(false)
    }

    @ReactMethod
    fun updateDownload(id: String, title: String, fileUri: String, totalBytes: Double, paused: Boolean) {
        DownloadState.put(id, title, fileUri, totalBytes.toLong(), paused)
        sync(false)
    }

    @ReactMethod
    fun removeDownload(id: String) {
        DownloadState.remove(id)
        sync(true)
    }

    @ReactMethod
    fun consumePendingActions(promise: Promise) {
        val result = Arguments.createArray()
        for ((id, action) in DownloadState.drain()) {
            val map = Arguments.createMap()
            map.putString("id", id)
            map.putString("action", action)
            result.pushMap(map)
        }
        promise.resolve(result)
    }

    @ReactMethod
    fun addListener(eventName: String) {
    }

    @ReactMethod
    fun removeListeners(count: Double) {
    }
}

class DownloadForegroundServicePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(DownloadForegroundModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
