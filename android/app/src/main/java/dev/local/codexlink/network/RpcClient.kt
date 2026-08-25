package dev.local.codexlink.network

import dev.local.codexlink.BuildConfig
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

class RpcException(val rpcCode: String, message: String) : RuntimeException(message)

@Singleton
class RpcClient @Inject constructor(private val connection: ConnectionManager) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    private val mutableNotifications = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512)
    private val mutableInitialized = MutableStateFlow(false)
    private val initializeMutex = Mutex()
    val notifications: SharedFlow<JsonObject> = mutableNotifications
    val initialized: StateFlow<Boolean> = mutableInitialized

    init {
        scope.launch { connection.applications.collect(::handleApplication) }
        // StateFlow replays the current Ready state to late collectors. A
        // one-shot SharedFlow event could be lost if the E2EE handshake
        // finished before this singleton's collector started.
        scope.launch { connection.state.filterIsInstance<ConnectionState.Ready>().collect { initializeAndNotify() } }
        scope.launch {
            connection.state.collect { state ->
                if (state is ConnectionState.Waiting || state is ConnectionState.Disconnected) {
                    mutableInitialized.value = false
                    val error = RpcException("connection_lost", "Companion connection was interrupted")
                    pending.values.forEach { it.completeExceptionally(error) }
                    pending.clear()
                }
            }
        }
    }

    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap())): JsonElement {
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pending[id] = deferred
        val request = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        try {
            connection.sendApplication(request.toString())
        } catch (error: Throwable) {
            pending.remove(id)
            throw error
        }
        return try {
            withTimeout(60_000) { deferred.await() }
        } finally {
            pending.remove(id, deferred)
        }
    }

    fun respondToServerRequest(requestId: JsonElement, result: JsonElement) {
        connection.sendApplication(buildJsonObject {
            put("id", requestId)
            put("result", result)
        }.toString())
    }

    private suspend fun handleApplication(raw: String) {
        val message = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val id = (message["id"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
        if (id != null && message["method"] == null) {
            val waiter = pending.remove(id) ?: return
            val error = message["error"] as? JsonObject
            if (error != null) {
                waiter.completeExceptionally(RpcException(
                    error["code"]?.jsonPrimitive?.contentOrNull ?: "rpc_error",
                    error["message"]?.jsonPrimitive?.contentOrNull ?: "RPC request failed",
                ))
            } else if (message["error"] != null) {
                waiter.completeExceptionally(RpcException("rpc_error", "RPC request failed"))
            } else {
                waiter.complete(message["result"] ?: JsonNull)
            }
            return
        }
        // Backpressure notification handling instead of silently dropping
        // approvals or final messages when Codex emits a fast event burst.
        mutableNotifications.emit(message)
        if ((message["method"] as? JsonPrimitive)?.contentOrNull == "codexlink/connection/reinitialize") {
            scope.launch { initializeAndNotify() }
        }
    }

    private suspend fun initializeAndNotify() = initializeMutex.withLock {
        mutableInitialized.value = false
        repeat(3) { retry ->
            if (connection.state.value !is ConnectionState.Ready) return@withLock
            val initialized = runCatching {
                call("initialize", buildJsonObject {
                    put("clientInfo", buildJsonObject {
                        put("name", "codexlink_android")
                        put("title", "CodexLink Android")
                        put("version", BuildConfig.VERSION_NAME)
                    })
                    put("capabilities", buildJsonObject { put("experimentalApi", true) })
                })
                connection.sendApplication(buildJsonObject { put("method", "initialized") }.toString())
            }.isSuccess
            if (initialized) {
                mutableInitialized.value = true
                return@withLock
            }
            if (retry < 2 && connection.state.value is ConnectionState.Ready) {
                delay(500L shl retry)
            }
        }
    }
}
