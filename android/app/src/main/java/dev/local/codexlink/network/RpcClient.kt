package dev.local.codexlink.network

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class RpcException(val rpcCode: String, message: String) : RuntimeException(message)

@Singleton
class RpcClient @Inject constructor(private val connection: ConnectionManager) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    private val mutableNotifications = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512)
    val notifications: SharedFlow<JsonObject> = mutableNotifications

    init {
        scope.launch { connection.applications.collect(::handleApplication) }
        scope.launch { connection.readyEvents.collect { initialize() } }
        scope.launch {
            connection.state.collect { state ->
                if (state is ConnectionState.Waiting || state is ConnectionState.Disconnected) {
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

    private fun handleApplication(raw: String) {
        val message = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val id = message["id"]?.jsonPrimitive?.content?.toLongOrNull()
        if (id != null && message["method"] == null) {
            val waiter = pending.remove(id) ?: return
            val error = message["error"]?.jsonObject
            if (error != null) {
                waiter.completeExceptionally(RpcException(
                    error["code"]?.jsonPrimitive?.content ?: "rpc_error",
                    error["message"]?.jsonPrimitive?.content ?: "RPC request failed",
                ))
            } else {
                waiter.complete(message["result"] ?: JsonNull)
            }
            return
        }
        mutableNotifications.tryEmit(message)
        if (message["method"]?.jsonPrimitive?.content == "codexlink/connection/reinitialize") {
            scope.launch { initialize() }
        }
    }

    private suspend fun initialize() {
        runCatching {
            call("initialize", buildJsonObject {
                put("clientInfo", buildJsonObject {
                    put("name", "codexlink_android")
                    put("title", "CodexLink Android")
                    put("version", "0.1.0")
                })
                put("capabilities", buildJsonObject { put("experimentalApi", true) })
            })
            connection.sendApplication(buildJsonObject { put("method", "initialized") }.toString())
        }
    }
}
