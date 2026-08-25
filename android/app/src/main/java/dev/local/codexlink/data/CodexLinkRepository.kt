package dev.local.codexlink.data

import dev.local.codexlink.network.ConnectionManager
import dev.local.codexlink.network.ConnectionState
import dev.local.codexlink.network.RpcClient
import java.net.URI
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put

@Singleton
class CodexLinkRepository @Inject constructor(
    private val hostDao: HostDao,
    private val threadDao: ThreadDao,
    private val approvalDao: ApprovalDao,
    private val connection: ConnectionManager,
    private val rpc: RpcClient,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val mutableProjects = MutableStateFlow<List<ProjectProfile>>(emptyList())
    private val mutableProviders = MutableStateFlow<List<ProviderProfile>>(emptyList())
    private val mutableThreads = MutableStateFlow<List<ThreadSummary>>(emptyList())
    private val mutableHostPermissions = MutableStateFlow(HostPermissions())
    private val mutableTimelines = MutableStateFlow<Map<String, List<TimelineEntry>>>(emptyMap())
    val projects: StateFlow<List<ProjectProfile>> = mutableProjects
    val providers: StateFlow<List<ProviderProfile>> = mutableProviders
    val threads: StateFlow<List<ThreadSummary>> = mutableThreads
    val hostPermissions: StateFlow<HostPermissions> = mutableHostPermissions
    val timelines: StateFlow<Map<String, List<TimelineEntry>>> = mutableTimelines
    val connectionState: StateFlow<ConnectionState> = connection.state
    val events = rpc.notifications
    val approvals = approvalDao.observeAll()
    val activeHost = hostDao.observeActive()

    init {
        scope.launch {
            threadDao.observeAll().collect { cached ->
                if (mutableThreads.value.isEmpty()) {
                    mutableThreads.value = cached.mapNotNull { row ->
                        runCatching { json.decodeFromString<ThreadSummary>(row.rawJson) }.getOrNull()
                    }
                }
            }
        }
        scope.launch { rpc.notifications.collect(::handleNotification) }
        scope.launch {
            connection.readyEvents.collect {
                runCatching { refreshAll() }
            }
        }
    }

    suspend fun pair(rawPayload: String) {
        val payload = json.decodeFromString<PairingPayload>(rawPayload)
        require(payload.v == 2) { "不支持的配对协议版本" }
        require(payload.expiresAt >= System.currentTimeMillis()) { "二维码已过期，请在电脑重新生成" }
        val relay = URI(payload.relay)
        require(relay.scheme == "wss" && relay.host != null) { "配对地址必须使用 WSS" }
        require(isTailnetHost(relay.host)) { "配对地址必须是 Tailscale Tailnet 地址" }
        require(payload.tlsCertSha256.isNotBlank() && payload.tlsSpkiSha256.isNotBlank()) { "二维码缺少 TLS 指纹" }
        require(runCatching { java.util.Base64.getDecoder().decode(payload.tlsCertSha256).size == 32 }.getOrDefault(false)) {
            "二维码中的 TLS 证书指纹无效"
        }
        require(runCatching { java.util.Base64.getDecoder().decode(payload.tlsSpkiSha256).size == 32 }.getOrDefault(false)) {
            "二维码中的 TLS 公钥指纹无效"
        }
        val existing = hostDao.active()?.takeIf { it.macDeviceId == payload.macDeviceId }
        hostDao.upsert(HostEntity(
            macDeviceId = payload.macDeviceId,
            displayName = payload.displayName.ifBlank { relay.host },
            pairingJson = json.encodeToString(payload),
            phoneDeviceId = existing?.phoneDeviceId ?: java.util.UUID.randomUUID().toString(),
            pairedAt = System.currentTimeMillis(),
            // Scanning a QR is always a fresh bootstrap. This also recovers
            // cleanly after the desktop rotates trust for the same Mac identity.
            lastConnectedAt = null,
            lastAppliedBridgeOutboundSeq = existing?.lastAppliedBridgeOutboundSeq ?: 0,
            bridgeReplayEpoch = existing?.bridgeReplayEpoch ?: "",
        ))
        connection.stop()
        connection.start()
    }

    suspend fun unpair() {
        connection.stop()
        hostDao.clear()
        threadDao.clear()
        mutableProjects.value = emptyList()
        mutableProviders.value = emptyList()
        mutableThreads.value = emptyList()
        mutableTimelines.value = emptyMap()
    }

    fun connect() = connection.start()
    fun disconnect() = connection.stop()

    suspend fun refreshAll() {
        refreshHostStatus()
        refreshProjects()
        refreshProviders()
        refreshThreads()
    }

    suspend fun refreshHostStatus() {
        val result = rpc.call("host/status").jsonObject
        val permissions = result["permissions"]?.jsonObject ?: JsonObject(emptyMap())
        mutableHostPermissions.value = HostPermissions(
            allowDangerFullAccess = permissions["allowDangerFullAccess"]?.jsonPrimitive?.booleanOrNull == true,
            allowNeverApproval = permissions["allowNeverApproval"]?.jsonPrimitive?.booleanOrNull == true,
        )
    }

    suspend fun refreshProjects() {
        val rows = rpc.call("project/list").rows()
        mutableProjects.value = rows.mapNotNull { runCatching { json.decodeFromJsonElement<ProjectProfile>(it) }.getOrNull() }
    }

    suspend fun refreshProviders() {
        val rows = rpc.call("provider/list").rows()
        mutableProviders.value = rows.mapNotNull { runCatching { json.decodeFromJsonElement<ProviderProfile>(it) }.getOrNull() }
    }

    suspend fun refreshThreads() {
        val rows = rpc.call("thread/list", buildJsonObject { put("limit", 100) }).rows()
        val summaries = rows.mapNotNull(::threadSummary)
        mutableThreads.value = summaries
        threadDao.upsertAll(summaries.map { summary ->
            ThreadEntity(
                id = summary.id,
                projectId = summary.codexlinkProjectId.orEmpty(),
                title = summary.name ?: summary.preview.ifBlank { "Codex 任务" },
                preview = summary.preview,
                status = summary.status?.toString().orEmpty(),
                rawJson = json.encodeToString(summary),
                updatedAt = summary.updatedAt ?: System.currentTimeMillis(),
            )
        })
    }

    suspend fun startTask(
        projectId: String,
        providerId: String,
        prompt: String,
        model: String?,
        effort: String,
        sandbox: String,
        approvalPolicy: String,
    ): String {
        require(prompt.isNotBlank()) { "请输入任务内容" }
        val threadStart = rpc.call("thread/start", buildJsonObject {
            put("projectId", projectId)
            put("providerId", providerId)
            model?.takeIf(String::isNotBlank)?.let { put("model", it) }
            put("sandbox", sandbox)
            put("approvalPolicy", approvalPolicy)
        }).jsonObject
        val threadId = threadStart["thread"]?.jsonObject?.get("id")?.jsonPrimitive?.content
            ?: error("Companion 未返回 threadId")
        appendLocalMessage(threadId, prompt)
        rpc.call("turn/start", buildJsonObject {
            put("threadId", threadId)
            put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", prompt) }) })
            put("effort", effort)
            put("sandbox", sandbox)
            put("approvalPolicy", approvalPolicy)
        })
        refreshThreads()
        return threadId
    }

    suspend fun readThread(threadId: String) = rpc.call("thread/read", buildJsonObject {
        put("threadId", threadId)
        put("includeTurns", true)
    })

    suspend fun steer(threadId: String, text: String) {
        val cleanText = text.trim()
        require(cleanText.isNotBlank()) { "请输入追加内容" }
        rpc.call("turn/steer", buildJsonObject {
            put("threadId", threadId)
            put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", cleanText) }) })
        })
        appendLocalMessage(threadId, cleanText)
    }

    suspend fun queueTurn(threadId: String, text: String) {
        val cleanText = text.trim()
        require(cleanText.isNotBlank()) { "请输入排队内容" }
        rpc.call("turn/start", buildJsonObject {
            put("threadId", threadId)
            put("input", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", cleanText) }) })
        })
        appendLocalMessage(threadId, cleanText)
    }

    suspend fun interrupt(threadId: String, turnId: String) = rpc.call("turn/interrupt", buildJsonObject {
        put("threadId", threadId)
        put("turnId", turnId)
    })

    suspend fun interruptActive(threadId: String) {
        val read = readThread(threadId).jsonObject
        val turns = read["thread"]?.jsonObject?.get("turns")?.jsonArray.orEmpty()
        val activeTurnId = turns.lastOrNull { turn ->
            turn.jsonObject["status"]?.jsonPrimitive?.contentOrNull == "inProgress"
        }?.jsonObject?.get("id")?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("当前任务没有可取消的运行回合")
        interrupt(threadId, activeTurnId)
    }

    suspend fun archive(threadId: String) = rpc.call("thread/archive", buildJsonObject { put("threadId", threadId) })
    suspend fun fork(threadId: String): JsonElement = rpc.call("thread/fork", buildJsonObject { put("threadId", threadId) })

    suspend fun respondApproval(requestId: String, decision: String) {
        rpc.call("approval/respond", buildJsonObject { put("requestId", requestId); put("decision", decision) })
        approvalDao.delete(requestId)
    }

    suspend fun upsertProvider(input: ProviderUpsertInput): ProviderProfile {
        val result = rpc.call("provider/upsert", buildJsonObject { put("profile", json.encodeToJsonElement(input)) })
        refreshProviders()
        return json.decodeFromJsonElement(result)
    }

    suspend fun deleteProvider(id: String) {
        rpc.call("provider/delete", buildJsonObject { put("id", id) })
        refreshProviders()
    }

    suspend fun testProvider(id: String): JsonObject = rpc.call("provider/test", buildJsonObject { put("id", id) }).jsonObject

    private suspend fun handleNotification(message: JsonObject) {
        val method = message["method"]?.jsonPrimitive?.contentOrNull ?: return
        val params = message["params"]?.jsonObject ?: JsonObject(emptyMap())
        val threadId = params["threadId"]?.jsonPrimitive?.contentOrNull
            ?: params["thread_id"]?.jsonPrimitive?.contentOrNull
            ?: params["turn"]?.jsonObject?.get("threadId")?.jsonPrimitive?.contentOrNull
            ?: params["item"]?.jsonObject?.get("threadId")?.jsonPrimitive?.contentOrNull
            ?: ""
        if (message["id"] != null && method.endsWith("requestApproval")) {
            val requestId = message.getValue("id").jsonPrimitive.content
            approvalDao.upsert(ApprovalEntity(requestId, threadId, method, message.toString(), System.currentTimeMillis()))
        }
        if (threadId.isNotBlank()) {
            val timelineParams = message["error"]?.let { error ->
                buildJsonObject {
                    params.forEach { (key, value) -> put(key, value) }
                    put("error", error)
                }
            } ?: params
            appendTimeline(threadId, timelineEntry(method, threadId, timelineParams))
        }
        if (method == "thread/started" || method == "thread/status/changed" || method == "turn/completed") {
            runCatching { refreshThreads() }
        }
    }

    private fun timelineEntry(method: String, threadId: String, params: JsonObject): TimelineEntry {
        val delta = textValue(params["delta"])
            ?: textValue(params["text"])
            ?: textValue(params["message"])
            ?: params["item"]?.jsonObject?.let { item ->
                textValue(item["text"])
                    ?: textValue(item["output"])
                    ?: textValue(item["command"])
                    ?: textValue(item["diff"])
            }
            ?: textValue(params["error"])
            ?: ""
        val title = when {
            method.endsWith("requestApproval") -> "等待审批"
            method.contains("commandExecution") -> "命令"
            method.contains("fileChange") || method.contains("patch") -> "文件修改"
            method.contains("agentMessage") -> "Codex"
            method == "turn/completed" -> "任务完成"
            method == "turn/started" -> "任务开始"
            else -> method
        }
        return TimelineEntry(
            stableId = params["itemId"]?.jsonPrimitive?.contentOrNull
                ?: params["item"]?.jsonObject?.get("id")?.jsonPrimitive?.contentOrNull
                ?: "$method-${System.nanoTime()}",
            threadId = threadId,
            type = method,
            title = title,
            body = delta,
            raw = params,
        )
    }

    private fun textValue(value: JsonElement?): String? = runCatching {
        when (value) {
            null -> null
            is JsonObject -> sequenceOf("text", "output", "message", "command", "diff", "error")
                .mapNotNull { key -> textValue(value[key]) }
                .firstOrNull()
            else -> value.jsonPrimitive.contentOrNull
        }
    }.getOrNull()?.takeIf(String::isNotBlank)

    private fun appendLocalMessage(threadId: String, text: String) {
        appendTimeline(
            threadId,
            TimelineEntry(
                stableId = "local-${System.nanoTime()}",
                threadId = threadId,
                type = "local/userMessage",
                title = "你",
                body = text.trim(),
            ),
        )
    }

    private fun appendTimeline(threadId: String, entry: TimelineEntry) {
        val current = mutableTimelines.value.toMutableMap()
        val rows = current[threadId].orEmpty().toMutableList()
        val existingIndex = rows.indexOfLast { it.stableId == entry.stableId && it.type == entry.type }
        if (existingIndex >= 0 && entry.body.isNotEmpty()) {
            rows[existingIndex] = rows[existingIndex].copy(body = rows[existingIndex].body + entry.body, raw = entry.raw)
        } else {
            rows += entry
        }
        current[threadId] = rows.takeLast(1_000)
        mutableTimelines.value = current
    }

    private fun JsonElement.rows(): List<JsonElement> {
        val result = jsonObject
        return (result["data"] ?: result["items"] ?: result["threads"] ?: JsonArray(emptyList())).jsonArray
    }

    private fun threadSummary(element: JsonElement): ThreadSummary? = runCatching {
        val row = element.jsonObject
        ThreadSummary(
            id = row.getValue("id").jsonPrimitive.content,
            name = row["name"]?.jsonPrimitive?.contentOrNull,
            preview = row["preview"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            cwd = row["cwd"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            status = row["status"],
            updatedAt = row["updatedAt"]?.jsonPrimitive?.longOrNull,
            codexlinkProjectId = row["codexlinkProjectId"]?.jsonPrimitive?.contentOrNull,
        )
    }.getOrNull()
}
