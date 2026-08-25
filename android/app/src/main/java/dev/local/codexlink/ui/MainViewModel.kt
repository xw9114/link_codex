package dev.local.codexlink.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.local.codexlink.data.ApprovalEntity
import dev.local.codexlink.data.CodexLinkRepository
import dev.local.codexlink.data.HostEntity
import dev.local.codexlink.data.HostPermissions
import dev.local.codexlink.data.ProjectProfile
import dev.local.codexlink.data.ProviderProfile
import dev.local.codexlink.data.ProviderUpsertInput
import dev.local.codexlink.data.ThreadSummary
import dev.local.codexlink.data.TimelineEntry
import dev.local.codexlink.network.ConnectionState
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

data class MainUiState(
    val host: HostEntity? = null,
    val connection: ConnectionState = ConnectionState.Disconnected,
    val rpcReady: Boolean = false,
    val projects: List<ProjectProfile> = emptyList(),
    val providers: List<ProviderProfile> = emptyList(),
    val hostPermissions: HostPermissions = HostPermissions(),
    val threads: List<ThreadSummary> = emptyList(),
    val approvals: List<ApprovalEntity> = emptyList(),
    val timelines: Map<String, List<TimelineEntry>> = emptyMap(),
    val selectedThreadId: String? = null,
    val busy: Boolean = false,
)

@HiltViewModel
class MainViewModel @Inject constructor(private val repository: CodexLinkRepository) : ViewModel() {
    private val selectedThreadId = MutableStateFlow<String?>(null)
    private val busy = MutableStateFlow(false)
    private var busyOperationCount = 0
    val messages = MutableSharedFlow<String>(extraBufferCapacity = 8)

    val state: StateFlow<MainUiState> = combine(
        repository.activeHost,
        repository.connectionState,
        repository.rpcInitialized,
        repository.projects,
        repository.providers,
        repository.hostPermissions,
        repository.threads,
        repository.approvals,
        repository.timelines,
        selectedThreadId,
        busy,
    ) { values ->
        @Suppress("UNCHECKED_CAST")
        MainUiState(
            host = values[0] as HostEntity?,
            connection = values[1] as ConnectionState,
            rpcReady = values[2] as Boolean,
            projects = values[3] as List<ProjectProfile>,
            providers = values[4] as List<ProviderProfile>,
            hostPermissions = values[5] as HostPermissions,
            threads = values[6] as List<ThreadSummary>,
            approvals = values[7] as List<ApprovalEntity>,
            timelines = values[8] as Map<String, List<TimelineEntry>>,
            selectedThreadId = values[9] as String?,
            busy = values[10] as Boolean,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), MainUiState())

    fun pair(payload: String, onSuccess: () -> Unit = {}) = launch("配对失败") {
        repository.pair(payload.trim())
        onSuccess()
    }

    fun unpair() = launch("解除配对失败") { repository.unpair() }
    fun connect() = repository.connect()
    fun disconnect() = repository.disconnect()
    fun refresh() = launch("刷新失败") { repository.refreshAll() }
    fun openThread(threadId: String?) {
        val selected = threadId?.takeIf(String::isNotBlank)
        selectedThreadId.value = selected
        if (selected != null) launch("读取任务失败") { repository.hydrateThread(selected) }
    }

    fun startTask(
        projectId: String,
        providerId: String,
        prompt: String,
        model: String?,
        effort: String,
        sandbox: String,
        approvalPolicy: String,
    ) = launch("启动任务失败") {
        selectedThreadId.value = repository.startTask(projectId, providerId, prompt, model, effort, sandbox, approvalPolicy)
    }

    fun steer(threadId: String, text: String, onSuccess: () -> Unit = {}) = launch("追加指令失败") {
        repository.steer(threadId, text)
        onSuccess()
    }
    fun queue(threadId: String, text: String, onSuccess: () -> Unit = {}) = launch("排队失败") {
        repository.queueTurn(threadId, text)
        onSuccess()
    }
    fun interrupt(threadId: String) = launch("取消任务失败") { repository.interruptActive(threadId) }
    fun archive(threadId: String) = launch("归档失败") { repository.archive(threadId); selectedThreadId.value = null; repository.refreshThreads() }
    fun fork(threadId: String) = launch("Fork 失败") {
        val result = repository.fork(threadId)
        val root = result as? JsonObject
        val thread = root?.get("thread") as? JsonObject
        val forkedId = listOf(thread?.get("id"), root?.get("id"))
            .firstNotNullOfOrNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: throw IllegalStateException("Companion 未返回 Fork 任务 ID")
        selectedThreadId.value = forkedId
        repository.hydrateThread(forkedId)
    }
    fun approve(requestId: String, decision: String) = launch("审批失败") { repository.respondApproval(requestId, decision) }
    fun saveProvider(input: ProviderUpsertInput) = launch("保存 Provider 失败") { repository.upsertProvider(input) }
    fun deleteProvider(id: String) = launch("删除 Provider 失败") { repository.deleteProvider(id) }
    fun testProvider(id: String) = launch("测试 Provider 失败") {
        val result = repository.testProvider(id)
        messages.emit(result["message"]?.toString()?.trim('"') ?: "测试完成")
    }

    private fun launch(errorPrefix: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            busyOperationCount += 1
            busy.value = true
            try {
                runCatching { block() }.onFailure { messages.emit("$errorPrefix：${it.message ?: "未知错误"}") }
            } finally {
                busyOperationCount = (busyOperationCount - 1).coerceAtLeast(0)
                busy.value = busyOperationCount > 0
            }
        }
    }
}
