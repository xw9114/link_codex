package dev.local.codexlink.network

import dev.local.codexlink.crypto.ReplayCursor
import dev.local.codexlink.crypto.SecureEvent
import dev.local.codexlink.crypto.SecureTransport
import dev.local.codexlink.data.HostDao
import dev.local.codexlink.data.PairingPayload
import dev.local.codexlink.security.IdentityStore
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

sealed interface ConnectionState {
    data object Disconnected : ConnectionState
    data class Connecting(val attempt: Int) : ConnectionState
    data class Handshaking(val hostName: String) : ConnectionState
    data class Ready(val hostName: String) : ConnectionState
    data class Waiting(val reason: String, val retryInMs: Long) : ConnectionState
}

@Singleton
class ConnectionManager @Inject constructor(
    private val baseClient: OkHttpClient,
    private val hostDao: HostDao,
    private val identityStore: IdentityStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    private val mutableState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    private val mutableApplications = MutableSharedFlow<String>(extraBufferCapacity = 256)
    private val mutableReadyEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val state: StateFlow<ConnectionState> = mutableState
    val applications: SharedFlow<String> = mutableApplications
    val readyEvents: SharedFlow<Unit> = mutableReadyEvents

    private var socket: WebSocket? = null
    private var transport: SecureTransport? = null
    private var connectJob: Job? = null
    private var reconnectJob: Job? = null
    private var stopped = true
    private var attempt = 0
    // SecureTransport's outbound counter and OkHttp's send queue must advance
    // together. initialize(), refreshAll() and notification responses can be
    // launched from different coroutines immediately after a handshake.
    private val sendLock = Any()

    fun start() {
        stopped = false
        if (connectJob?.isActive == true || socket != null) return
        connectJob = scope.launch { connectOnce() }
    }

    fun stop() {
        stopped = true
        connectJob?.cancel()
        connectJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        socket?.close(1000, "CodexLink stopped")
        socket = null
        transport = null
        mutableState.value = ConnectionState.Disconnected
    }

    fun sendApplication(text: String) {
        synchronized(sendLock) {
            val activeTransport = transport ?: error("Companion is not connected")
            val activeSocket = socket ?: error("Companion is not connected")
            // Encrypting and enqueueing as one critical section prevents two
            // concurrent callers from producing duplicate/out-of-order counters.
            check(activeSocket.send(activeTransport.encryptApplication(text))) {
                "WebSocket send failed"
            }
        }
    }

    private suspend fun connectOnce() {
        try {
            val host = hostDao.active() ?: run {
                mutableState.value = ConnectionState.Disconnected
                return
            }
            val pairing = json.decodeFromString<PairingPayload>(host.pairingJson)
            attempt += 1
            mutableState.value = ConnectionState.Connecting(attempt)
            val client = baseClient.withCompanionPin(
                Base64.getDecoder().decode(pairing.tlsCertSha256),
                Base64.getDecoder().decode(pairing.tlsSpkiSha256),
            )
            val endpoint = "${pairing.relay.trimEnd('/')}/${pairing.sessionId}"
            val request = Request.Builder().url(endpoint).header("x-role", "android").build()
            socket = client.newWebSocket(request, Listener(host, pairing))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            scheduleReconnect(error.message ?: "配对信息无效")
        }
    }

    private fun scheduleReconnect(reason: String) {
        if (stopped) return
        if (reconnectJob?.isActive == true) return
        val oldSocket = socket
        socket = null
        transport = null
        oldSocket?.close(4000, "Reconnect")
        val exponent = min((attempt - 1).coerceAtLeast(0), 6)
        val delayMs = min(60_000L, 1_000L shl exponent)
        mutableState.value = ConnectionState.Waiting(reason, delayMs)
        connectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs + (0..750).random())
            reconnectJob = null
            if (!stopped && socket == null) connectOnce()
        }
    }

    private inner class Listener(
        private val host: dev.local.codexlink.data.HostEntity,
        private val pairing: PairingPayload,
    ) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            mutableState.value = ConnectionState.Handshaking(pairing.displayName)
            val secureTransport = SecureTransport(identityStore.load())
            transport = secureTransport
            val hello = secureTransport.begin(
                pairing,
                trustedReconnect = host.lastConnectedAt != null,
                cursor = ReplayCursor(host.lastAppliedBridgeOutboundSeq, host.bridgeReplayEpoch),
            )
            webSocket.send(hello)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (socket !== webSocket) return
            val active = transport ?: return
            active.handleWire(text).forEach { event ->
                when (event) {
                    is SecureEvent.SendWire -> webSocket.send(event.text)
                    is SecureEvent.Ready -> {
                        attempt = 0
                        mutableState.value = ConnectionState.Ready(pairing.displayName)
                        scope.launch { hostDao.markConnected(host.macDeviceId, System.currentTimeMillis()) }
                        mutableReadyEvents.tryEmit(Unit)
                    }
                    is SecureEvent.Application -> {
                        val sequence = event.bridgeOutboundSeq
                        if (sequence != null && sequence <= host.lastAppliedBridgeOutboundSeq) return@forEach
                        if (mutableApplications.tryEmit(event.text) && sequence != null) {
                            scope.launch { hostDao.updateReplayCursor(host.macDeviceId, sequence, event.bridgeReplayEpoch) }
                        }
                    }
                    is SecureEvent.Error -> {
                        scheduleReconnect("${event.code}: ${event.message}")
                    }
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!stopped && socket === webSocket) scheduleReconnect(reason.ifBlank { "连接已关闭" })
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!stopped && socket === webSocket) scheduleReconnect(t.message ?: "网络不可用")
        }
    }
}
