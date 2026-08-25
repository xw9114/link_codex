package dev.local.codexlink.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.local.codexlink.data.ApprovalEntity
import dev.local.codexlink.data.ProviderUpsertInput
import dev.local.codexlink.network.ConnectionState
import dev.local.codexlink.service.CodexLinkForegroundService
import kotlinx.coroutines.flow.collectLatest

private val Ink = Color(0xFF18231F)
private val Paper = Color(0xFFF5F3EE)
private val Panel = Color(0xFFFFFEFA)
private val Lime = Color(0xFFD9FF72)
private val Muted = Color(0xFF69716D)

@Composable
fun CodexLinkApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.host?.macDeviceId) {
        if (state.host != null) CodexLinkForegroundService.start(context) else CodexLinkForegroundService.stop(context)
    }
    LaunchedEffect(Unit) { viewModel.messages.collectLatest { snackbar.showSnackbar(it) } }

    MaterialTheme(
        colorScheme = androidx.compose.material3.lightColorScheme(
            primary = Ink,
            onPrimary = Color.White,
            secondary = Lime,
            background = Paper,
            surface = Panel,
            onSurface = Ink,
        )
    ) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            if (state.host == null) {
                PairingScreen(state.busy, viewModel::pair)
            } else {
                MainShell(state, viewModel, snackbar)
            }
        }
    }
}

@Composable
private fun PairingScreen(busy: Boolean, pair: (String, () -> Unit) -> Unit) {
    val context = LocalContext.current
    var payload by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    var cameraGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraGranted = it; scanning = it }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Spacer(Modifier.height(18.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(46.dp).background(Lime, RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) { Text("C", fontWeight = FontWeight.Black, color = Ink) }
            Spacer(Modifier.width(12.dp)); Column { Text("CodexLink", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold); Text("Tailnet 远程控制", color = Muted) }
        }
        if (scanning && cameraGranted) {
            Card(Modifier.fillMaxWidth().weight(1f), shape = RoundedCornerShape(18.dp)) {
                Box { QrScanner(onResult = { value -> payload = value; scanning = false }); Text("对准电脑端二维码", Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Ink.copy(alpha = .82f)).padding(14.dp), color = Color.White) }
            }
        } else {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("连接你的电脑", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text("两端先登录同一 Tailscale Tailnet，再扫描 Windows Companion 的五分钟二维码。", color = Muted)
                Button(onClick = { if (cameraGranted) scanning = true else permission.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) { Text("扫描配对二维码") }
                Text("或粘贴二维码内容", color = Muted)
                OutlinedTextField(payload, { payload = it }, modifier = Modifier.fillMaxWidth(), minLines = 6, placeholder = { Text("{ \"v\": 2, ... }") })
                Button(onClick = { pair(payload) { payload = "" } }, enabled = payload.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth()) { if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White) else Text("安全配对") }
            }
        }
    }
}

private enum class Tab(val label: String, val glyph: String) { HOME("任务", "◫"), NEW("新任务", "+"), PROVIDERS("Provider", "◇"), SETTINGS("设置", "⚙") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainShell(state: MainUiState, viewModel: MainViewModel, snackbar: SnackbarHostState) {
    var tab by remember { mutableStateOf(Tab.HOME) }
    val selectedThread = state.selectedThreadId
    if (selectedThread != null) {
        ThreadScreen(state, selectedThread, viewModel)
        return
    }
    Scaffold(
        containerColor = Paper,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { TopAppBar(title = { Column { Text(tab.label, fontWeight = FontWeight.Bold); ConnectionLabel(state.connection) } }, colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper), actions = { if (state.busy) CircularProgressIndicator(Modifier.padding(end = 16.dp).size(18.dp), strokeWidth = 2.dp) }) },
        bottomBar = { NavigationBar(Modifier.navigationBarsPadding(), containerColor = Panel) { Tab.entries.forEach { item -> NavigationBarItem(selected = tab == item, onClick = { tab = item }, icon = { Text(item.glyph, fontWeight = FontWeight.Bold) }, label = { Text(item.label) }) } } },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.HOME -> HomeScreen(state, viewModel)
                Tab.NEW -> NewTaskScreen(state, viewModel)
                Tab.PROVIDERS -> ProvidersScreen(state, viewModel)
                Tab.SETTINGS -> SettingsScreen(state, viewModel)
            }
        }
    }
}

@Composable
private fun ConnectionLabel(state: ConnectionState) {
    Text(when (state) {
        ConnectionState.Disconnected -> "未连接"
        is ConnectionState.Connecting -> "正在连接"
        is ConnectionState.Handshaking -> "正在验证主机"
        is ConnectionState.Ready -> "已安全连接 · ${state.hostName}"
        is ConnectionState.Waiting -> "等待重连 · ${state.reason}"
    }, color = Muted, style = MaterialTheme.typography.labelSmall)
}

@Composable
private fun HomeScreen(state: MainUiState, viewModel: MainViewModel) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { StatusCard(state) { viewModel.refresh() } }
        if (state.approvals.isNotEmpty()) item { Text("等待审批 · ${state.approvals.size}", color = Color(0xFF9B4C2F), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp)) }
        item { Text("最近任务", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp)) }
        if (state.threads.isEmpty()) item { EmptyCard("白名单项目的任务会显示在这里。") }
        items(state.threads, key = { it.id }) { thread ->
            Card(Modifier.fillMaxWidth().clickable { viewModel.openThread(thread.id) }, colors = CardDefaults.cardColors(containerColor = Panel)) {
                Column(Modifier.padding(16.dp)) {
                    Text(thread.name ?: thread.preview.ifBlank { "Codex 任务" }, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(thread.preview.ifBlank { thread.id }, color = Muted, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 5.dp))
                    Text(thread.codexlinkProjectId ?: "白名单项目", style = MaterialTheme.typography.labelSmall, color = Muted, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun StatusCard(state: MainUiState, refresh: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Ink), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(17.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(state.host?.displayName ?: "Windows", color = Color.White, fontWeight = FontWeight.Bold); ConnectionLabelOnDark(state.connection); Text("${state.projects.size} 个项目 · ${state.providers.size} 个 Provider", color = Color(0xFFB8C4BE), style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 5.dp)) }
            OutlinedButton(onClick = refresh) { Text("刷新", color = Lime) }
        }
    }
}

@Composable
private fun ConnectionLabelOnDark(state: ConnectionState) {
    val label = when (state) {
        is ConnectionState.Ready -> "E2EE 在线"
        is ConnectionState.Waiting -> "重连中 · ${state.reason}"
        is ConnectionState.Handshaking -> "正在验证主机"
        is ConnectionState.Connecting -> "正在连接 · 第 ${state.attempt} 次"
        ConnectionState.Disconnected -> "未连接"
    }
    Text(
        label,
        color = if (state is ConnectionState.Ready) Lime else Color(0xFFFFD675),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}
@Composable private fun EmptyCard(text: String) { Card(colors = CardDefaults.cardColors(containerColor = Panel), modifier = Modifier.fillMaxWidth()) { Text(text, Modifier.padding(24.dp), color = Muted) } }

@Composable
private fun NewTaskScreen(state: MainUiState, viewModel: MainViewModel) {
    var projectId by remember(state.projects) { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var providerId by remember(state.providers) { mutableStateOf(state.providers.firstOrNull()?.id ?: "chatgpt") }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var effort by remember { mutableStateOf("high") }
    var sandbox by remember { mutableStateOf("workspace-write") }
    var approval by remember { mutableStateOf("on-request") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
        Text("让电脑上的 Codex 开始工作", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        ChoiceField("项目", projectId, state.projects.map { it.id to it.displayName }) { projectId = it }
        ChoiceField("Provider", providerId, state.providers.map { it.id to it.displayName }) { providerId = it; model = state.providers.firstOrNull { p -> p.id == it }?.defaultModel.orEmpty() }
        OutlinedTextField(model, { model = it }, label = { Text("模型（可选）") }, modifier = Modifier.fillMaxWidth())
        ChoiceField("推理强度", effort, listOf("medium" to "Medium", "high" to "High", "xhigh" to "XHigh")) { effort = it }
        ChoiceField("沙箱", sandbox, buildList {
            add("read-only" to "只读")
            add("workspace-write" to "工作区可写")
            if (state.hostPermissions.allowDangerFullAccess) add("danger-full-access" to "完全访问（电脑已允许）")
        }) { sandbox = it }
        ChoiceField("审批", approval, buildList {
            add("untrusted" to "不可信命令审批")
            add("on-request" to "按需审批")
            if (state.hostPermissions.allowNeverApproval) add("never" to "从不审批（电脑已允许）")
        }) { approval = it }
        OutlinedTextField(prompt, { prompt = it }, label = { Text("任务说明") }, minLines = 7, modifier = Modifier.fillMaxWidth())
        Button(onClick = { viewModel.startTask(projectId, providerId, prompt, model.ifBlank { null }, effort, sandbox, approval) }, enabled = projectId.isNotBlank() && prompt.isNotBlank() && state.connection is ConnectionState.Ready && !state.busy, modifier = Modifier.fillMaxWidth()) { Text("启动任务") }
        Text("danger-full-access 与 never 只能先在电脑端显式放开；手机无法提升权限上限。", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ChoiceField(label: String, value: String, choices: List<Pair<String, String>>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column { Text(label, style = MaterialTheme.typography.labelMedium, color = Muted); Box { OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text(choices.firstOrNull { it.first == value }?.second ?: "请选择", modifier = Modifier.weight(1f)); Text("⌄") }; DropdownMenu(expanded, { expanded = false }, modifier = Modifier.fillMaxWidth(.9f)) { choices.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { onChange(id); expanded = false }) } } } }
}

@Composable
private fun ProvidersScreen(state: MainUiState, viewModel: MainViewModel) {
    var editing by remember { mutableStateOf(false) }
    var editingId by remember { mutableStateOf<String?>(null) }
    var kind by remember { mutableStateOf("openai_responses") }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("https://api.openai.com/v1") }
    var model by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var headersText by remember { mutableStateOf("") }
    val headersValid = headersText.lineSequence().filter(String::isNotBlank).all { ':' in it }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) { Text("Responses Provider", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f)); Button(onClick = { editing = !editing; editingId = null; kind = "openai_responses"; name = ""; url = "https://api.openai.com/v1"; model = ""; key = ""; headersText = "" }) { Text(if (editing) "收起" else "新增") } } }
        if (editing) item {
            Card(colors = CardDefaults.cardColors(containerColor = Panel)) { Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (editingId == null) "新增 Provider" else "修改 Provider", fontWeight = FontWeight.Bold)
                ChoiceField("类型", kind, listOf("openai_responses" to "OpenAI Responses", "custom_responses" to "自定义 Responses")) { kind = it }
                OutlinedTextField(name, { name = it }, label = { Text("名称") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(url, { url = it }, label = { Text("Base URL") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(model, { model = it }, label = { Text("默认模型") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(key, { key = it }, label = { Text(if (editingId == null) "API Key（不落手机磁盘）" else "新 API Key（留空则保留电脑密钥）") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(headersText, { headersText = it }, label = { Text("可选请求头，每行 Header: value") }, supportingText = { if (!headersValid) Text("每个非空行都必须包含冒号") }, minLines = 2, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    viewModel.saveProvider(ProviderUpsertInput(
                        id = editingId,
                        kind = kind,
                        displayName = name,
                        baseUrl = url,
                        defaultModel = model,
                        apiKey = key.ifBlank { null },
                        headers = parseProviderHeaders(headersText),
                    ))
                    key = ""
                    headersText = ""
                    editing = false
                    editingId = null
                }, enabled = name.isNotBlank() && model.isNotBlank() && headersValid && (editingId != null || key.isNotBlank())) { Text("通过 E2EE 保存到电脑") }
            } }
        }
        items(state.providers, key = { it.id }) { provider ->
            Card(colors = CardDefaults.cardColors(containerColor = Panel), modifier = Modifier.fillMaxWidth()) { Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text(provider.displayName, fontWeight = FontWeight.Bold); Text(provider.defaultModel ?: "电脑现有登录", color = Muted); Text(provider.status, color = if (provider.status == "online" || provider.status == "available") Color(0xFF5F7818) else Muted, style = MaterialTheme.typography.labelSmall) }; if (provider.kind != "chatgpt") { TextButton(onClick = { editing = true; editingId = provider.id; kind = provider.kind; name = provider.displayName; url = provider.baseUrl.orEmpty(); model = provider.defaultModel.orEmpty(); key = ""; headersText = "" }) { Text("编辑") }; TextButton(onClick = { viewModel.testProvider(provider.id) }) { Text("测试") }; TextButton(onClick = { viewModel.deleteProvider(provider.id) }) { Text("删除", color = Color(0xFFB3473D)) } } } }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

private fun parseProviderHeaders(value: String): Map<String, String> = value.lineSequence()
    .map(String::trim)
    .filter(String::isNotBlank)
    .associate { line -> line.substringBefore(':').trim() to line.substringAfter(':').trim() }

@Composable
private fun SettingsScreen(state: MainUiState, viewModel: MainViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("连接与安全", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Card(colors = CardDefaults.cardColors(containerColor = Panel)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) { Text(state.host?.displayName ?: "Windows", fontWeight = FontWeight.Bold); Text("主机身份 ${state.host?.macDeviceId?.take(12)}…", color = Muted, fontFamily = FontFamily.Monospace); ConnectionLabel(state.connection) } }
        OutlinedButton(onClick = viewModel::connect, modifier = Modifier.fillMaxWidth()) { Text("立即重连") }
        OutlinedButton(onClick = viewModel::disconnect, modifier = Modifier.fillMaxWidth()) { Text("暂时断开") }
        OutlinedButton(onClick = viewModel::unpair, modifier = Modifier.fillMaxWidth()) { Text("解除配对并清除本机缓存", color = Color(0xFFB3473D)) }
        Text("API Key 从不保存到手机；已配对主机、任务缓存和未完成审批保存在 SQLCipher 数据库，数据库密钥由 Android Keystore 保护。", color = Muted)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThreadScreen(state: MainUiState, threadId: String, viewModel: MainViewModel) {
    val thread = state.threads.firstOrNull { it.id == threadId }
    var steer by remember { mutableStateOf("") }
    var approval by remember { mutableStateOf<ApprovalEntity?>(null) }
    val timeline = state.timelines[threadId].orEmpty()
    val conversation = timeline.filter(::isConversationEntry)
    Scaffold(
        containerColor = Paper,
        topBar = { TopAppBar(title = { Column { Text(thread?.name ?: "任务", maxLines = 1, overflow = TextOverflow.Ellipsis); Text(threadId.take(12), color = Muted, style = MaterialTheme.typography.labelSmall) } }, navigationIcon = { TextButton(onClick = { viewModel.openThread(null) }) { Text("‹ 返回") } }, actions = { TextButton(onClick = { viewModel.interrupt(threadId) }) { Text("停止") } }) },
        bottomBar = { Row(Modifier.navigationBarsPadding().background(Panel).padding(10.dp), verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(steer, { steer = it }, placeholder = { Text("追加、steer 或排队指令") }, modifier = Modifier.weight(1f), maxLines = 3); Spacer(Modifier.width(8.dp)); Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { Button(onClick = { viewModel.steer(threadId, steer); steer = "" }, enabled = steer.isNotBlank()) { Text("Steer") }; OutlinedButton(onClick = { viewModel.queue(threadId, steer); steer = "" }, enabled = steer.isNotBlank()) { Text("排队") } } } },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            state.approvals.filter { it.threadId == threadId }.forEach { pending -> item(key = "approval-${pending.requestId}") { Card(Modifier.fillMaxWidth().clickable { approval = pending }, colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF3C9))) { Column(Modifier.padding(14.dp)) { Text("等待你的审批", fontWeight = FontWeight.Bold); Text(pending.method, color = Muted); Text("点按查看详情", color = Color(0xFF705B16)) } } } }
            if (conversation.isEmpty()) item { EmptyCard("Codex 正在处理；完成后这里只显示对话结果。") }
            // Include the event type in the key: Codex can emit a delta and a
            // completion for the same item within one millisecond. Using only
            // itemId+timestamp would make Compose see duplicate LazyColumn keys
            // and terminate the activity while the response is streaming.
            items(conversation, key = { "${it.type}-${it.stableId}-${it.timestamp}" }) { entry -> ConversationBubble(entry) }
            item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { TextButton(onClick = { viewModel.fork(threadId) }) { Text("Fork") }; TextButton(onClick = { viewModel.archive(threadId) }) { Text("归档") } }; Spacer(Modifier.height(10.dp)) }
        }
    }
    approval?.let { pending -> ApprovalDialog(pending, onDismiss = { approval = null }) { decision -> viewModel.approve(pending.requestId, decision); approval = null } }
}

private fun isConversationEntry(entry: dev.local.codexlink.data.TimelineEntry): Boolean {
    val body = entry.body.trim()
    if (body.isBlank()) return false
    val type = entry.type.lowercase()
    return when {
        type == "local/usermessage" -> true
        type.contains("agentmessage") -> true
        type == "error" -> true
        type == "warning" && !body.contains("falling back from websockets", ignoreCase = true) -> true
        else -> false
    }
}

@Composable
private fun ConversationBubble(entry: dev.local.codexlink.data.TimelineEntry) {
    val isUser = entry.type == "local/userMessage"
    val isError = entry.type.equals("error", ignoreCase = true)
    val isWarning = entry.type.equals("warning", ignoreCase = true)
    val bubbleColor = when {
        isUser -> Lime
        isError -> Color(0xFFFFE2DF)
        isWarning -> Color(0xFFFFF3C9)
        else -> Panel
    }
    val label = when {
        isUser -> "你"
        isError -> "错误"
        isWarning -> "提示"
        else -> "Codex"
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(0.88f),
            shape = RoundedCornerShape(18.dp),
            colors = CardDefaults.cardColors(containerColor = bubbleColor),
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(label, fontWeight = FontWeight.Bold, color = if (isError) Color(0xFF9C342B) else Ink)
                Text(
                    entry.body.trim(),
                    modifier = Modifier.padding(top = 6.dp),
                    color = Ink,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
    }
}

@Composable
private fun ApprovalDialog(approval: ApprovalEntity, onDismiss: () -> Unit, decide: (String) -> Unit) {
    val detail = remember(approval.payloadJson) {
        Regex("\"command\"\\s*:\\s*\"([^\"]+)\"").find(approval.payloadJson)?.groupValues?.get(1)
            ?: Regex("\"diff\"\\s*:\\s*\"([^\"]+)\"").find(approval.payloadJson)?.groupValues?.get(1)
            ?: approval.payloadJson.take(1800)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (approval.method.contains("file", true)) "审查文件修改" else "审查命令") },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(approval.method, color = Muted); Text(detail.replace("\\n", "\n"), fontFamily = FontFamily.Monospace, modifier = Modifier.padding(top = 10.dp)) } },
        confirmButton = { Row { TextButton(onClick = { decide("acceptForSession") }) { Text("本会话允许") }; Button(onClick = { decide("accept") }) { Text("允许") } } },
        dismissButton = { Row { TextButton(onClick = { decide("cancel") }) { Text("取消任务") }; TextButton(onClick = { decide("decline") }) { Text("拒绝", color = Color(0xFFB3473D)) } } },
    )
}
