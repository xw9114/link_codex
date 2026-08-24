package dev.local.codexlink.service

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
import dagger.hilt.android.AndroidEntryPoint
import dev.local.codexlink.MainActivity
import dev.local.codexlink.R
import dev.local.codexlink.data.CodexLinkRepository
import dev.local.codexlink.network.ConnectionState
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

@AndroidEntryPoint
class CodexLinkForegroundService : Service() {
    @Inject lateinit var repository: CodexLinkRepository
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var stateJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForegroundNotification("正在连接电脑")
        repository.connect()
        stateJob = scope.launch {
            repository.connectionState.collectLatest { state ->
                startForegroundNotification(when (state) {
                    ConnectionState.Disconnected -> "未连接"
                    is ConnectionState.Connecting -> "正在连接 · 第 ${state.attempt} 次"
                    is ConnectionState.Handshaking -> "正在验证 ${state.hostName}"
                    is ConnectionState.Ready -> "已安全连接 ${state.hostName}"
                    is ConnectionState.Waiting -> "${state.reason} · 等待重连"
                })
            }
        }
        scope.launch {
            repository.events.collect { message ->
                val method = message["method"]?.toString()?.trim('"').orEmpty()
                val params = message["params"]
                val threadId = params?.let { raw ->
                    Regex("\"threadId\"\\s*:\\s*\"([^\"]+)\"").find(raw.toString())?.groupValues?.get(1)
                }.orEmpty()
                when {
                    method.endsWith("requestApproval") -> postEvent("Codex 等待审批", "点按查看命令或文件修改", threadId, 2001)
                    method == "turn/completed" && message.toString().contains("failed") -> postEvent("Codex 任务失败", "点按查看错误", threadId, 2002)
                    method == "turn/completed" -> postEvent("Codex 任务完成", "点按查看结果与 diff", threadId, 2003)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        repository.connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stateJob?.cancel()
        repository.disconnect()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundNotification(text: String) {
        val notification = NotificationCompat.Builder(this, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_codexlink)
            .setContentTitle("CodexLink")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(mainPendingIntent(""))
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_CONNECTION,
            notification,
            when {
                Build.VERSION.SDK_INT >= 34 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                Build.VERSION.SDK_INT >= 29 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                else -> 0
            },
        )
    }

    private fun postEvent(title: String, text: String, threadId: String, baseId: Int) {
        val notification = NotificationCompat.Builder(this, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_codexlink)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(mainPendingIntent(threadId))
            .build()
        getSystemService(NotificationManager::class.java).notify(baseId xor threadId.hashCode(), notification)
    }

    private fun mainPendingIntent(threadId: String): PendingIntent = PendingIntent.getActivity(
        this,
        threadId.hashCode(),
        Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_THREAD_ID, threadId)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_CONNECTION, "CodexLink 连接", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_EVENTS, "任务与审批", NotificationManager.IMPORTANCE_HIGH))
    }

    companion object {
        private const val CHANNEL_CONNECTION = "codexlink_connection"
        private const val CHANNEL_EVENTS = "codexlink_events"
        private const val NOTIFICATION_CONNECTION = 1001
        fun start(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, CodexLinkForegroundService::class.java))
        }
        fun stop(context: Context) { context.stopService(Intent(context, CodexLinkForegroundService::class.java)) }
    }
}
