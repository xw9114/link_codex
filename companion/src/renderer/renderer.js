const $ = (selector) => document.querySelector(selector);
let state = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function statusText(value) {
  const map = { connected: "已连接", connecting: "连接中", disconnected: "未连接", running: "运行中", starting: "启动中", error: "错误" };
  return map[value] || value || "—";
}

function render(nextState) {
  state = nextState;
  const status = state.status || {};
  const tailnet = status.tailnet || {};
  const bridge = status.bridge || {};
  const connected = tailnet.state === "Running" && bridge.connectionStatus === "connected";
  $("#side-status-dot").className = `dot ${connected ? "good" : bridge.state === "error" ? "bad" : ""}`;
  $("#side-status").textContent = connected ? "手机已安全连接" : `${tailnet.state || "Tailscale"} · ${statusText(bridge.connectionStatus)}`;
  $("#tailscale-state").textContent = tailnet.state === "Running" ? "运行中" : "不可用";
  $("#tailscale-address").textContent = tailnet.dnsName || tailnet.address || "请启动 Tailscale";
  $("#bridge-state").textContent = statusText(bridge.connectionStatus || bridge.state);
  $("#bridge-detail").textContent = bridge.lastError || "WSS + E2EE";
  $("#codex-state").textContent = status.login?.loggedIn ? `已登录 ${status.login.label}` : "需要登录";
  $("#codex-version").textContent = status.codex?.version ? `CLI ${status.codex.version}` : "未检测到 Codex CLI";
  $("#restart-note").classList.toggle("hidden", !status.providerRestartPending);
  $("#allow-danger").checked = status.permissions?.allowDangerFullAccess === true;
  $("#allow-never").checked = status.permissions?.allowNeverApproval === true;
  const qr = $("#pairing-qr");
  if (state.pairing?.qrDataUrl) {
    qr.src = state.pairing.qrDataUrl;
    $("#qr-empty").classList.add("hidden");
  } else {
    qr.removeAttribute("src");
    $("#qr-empty").classList.remove("hidden");
  }
  renderProjects();
  renderProviders();
  renderLogs();
}

function renderProjects() {
  const container = $("#project-list");
  if (!state.projects?.length) {
    container.innerHTML = '<div class="list-empty">尚未授权项目。先在电脑端选择一个目录。</div>';
    return;
  }
  container.innerHTML = state.projects.map((project) => `
    <article class="list-row"><div class="list-main"><strong>${escapeHtml(project.displayName)}</strong><small>${escapeHtml(project.pathHint)}</small></div>
    <div class="list-actions"><span class="status-pill available">已允许</span><button class="mini-button danger" data-remove-project="${escapeHtml(project.id)}">移除</button></div></article>
  `).join("");
}

function renderProviders() {
  const container = $("#provider-list");
  container.innerHTML = (state.providers || []).map((provider) => `
    <article class="list-row"><div class="list-main"><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(provider.kind === "chatgpt" ? "使用电脑现有 Codex 登录" : `${provider.baseUrl} · ${provider.defaultModel}`)}</small></div>
    <div class="list-actions"><span class="status-pill ${escapeHtml(provider.status)}">${escapeHtml(provider.status)}</span>
    ${provider.kind === "chatgpt" ? "" : `<button class="mini-button" data-edit-provider="${escapeHtml(provider.id)}">编辑</button><button class="mini-button" data-test-provider="${escapeHtml(provider.id)}">测试</button><button class="mini-button danger" data-delete-provider="${escapeHtml(provider.id)}">删除</button>`}</div></article>
  `).join("") || '<div class="list-empty">尚无 Provider。</div>';
}

function renderLogs() {
  const container = $("#log-list");
  container.innerHTML = (state.logs || []).slice().reverse().map((entry) => `
    <div class="log-row"><time>${escapeHtml(new Date(entry.at).toLocaleString())}</time><b class="${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</b><span>${escapeHtml(entry.message)}</span></div>
  `).join("") || '<div class="log-row"><span>暂无日志</span></div>';
}

function switchPage(page) {
  const titles = { overview: "连接概览", projects: "项目白名单", providers: "API Provider", logs: "运行日志" };
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  document.querySelectorAll(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${page}`));
  $("#page-title").textContent = titles[page];
}

async function run(action, successMessage = "操作完成") {
  try {
    const result = await action();
    showToast(successMessage);
    return result;
  } catch (error) {
    showToast(error.message || "操作失败");
    throw error;
  }
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest(".nav-item");
  if (nav) switchPage(nav.dataset.page);
  const removeProject = event.target.closest("[data-remove-project]");
  if (removeProject && confirm("从手机项目白名单移除？已有任务将不再对手机可见。")) {
    await run(() => window.codexlink.removeProject(removeProject.dataset.removeProject), "项目已移除");
  }
  const testProvider = event.target.closest("[data-test-provider]");
  if (testProvider) {
    const result = await run(() => window.codexlink.testProvider(testProvider.dataset.testProvider), "连接测试完成");
    showToast(result.message);
  }
  const editProvider = event.target.closest("[data-edit-provider]");
  if (editProvider) {
    const provider = state.providers.find((item) => item.id === editProvider.dataset.editProvider);
    if (provider) {
      $("#provider-form").reset();
      $("#provider-id").value = provider.id;
      $("#provider-kind").value = provider.kind;
      $("#provider-name").value = provider.displayName;
      $("#provider-url").value = provider.baseUrl || "";
      $("#provider-model").value = provider.defaultModel || "";
      $("#provider-key").value = "";
      $("#provider-headers").value = "";
      $("#form-error").textContent = "";
      dialog.showModal();
    }
  }
  const deleteProvider = event.target.closest("[data-delete-provider]");
  if (deleteProvider && confirm("删除此 Provider 及其 Windows Credential？")) {
    await run(() => window.codexlink.deleteProvider(deleteProvider.dataset.deleteProvider), "Provider 已删除");
  }
});

$("#refresh").addEventListener("click", () => run(() => window.codexlink.refreshNetwork(), "状态已刷新"));
$("#add-project").addEventListener("click", () => run(() => window.codexlink.addProject(), "项目已加入白名单"));
$("#reset-pairing").addEventListener("click", async () => {
  if (confirm("这会断开当前手机并要求重新扫码。继续？")) await run(() => window.codexlink.resetPairing(), "可信手机已重置");
});
$("#save-security").addEventListener("click", async () => {
  const enablesUnsafe = $("#allow-danger").checked || $("#allow-never").checked;
  if (enablesUnsafe && !confirm("这些选项会放宽手机可选择的执行权限。确认由本机启用？")) return;
  await run(() => window.codexlink.updateSecurity({
    allowDangerFullAccess: $("#allow-danger").checked,
    allowNeverApproval: $("#allow-never").checked,
  }), "电脑端权限上限已保存");
});

const dialog = $("#provider-dialog");
$("#add-provider").addEventListener("click", () => {
  $("#provider-form").reset();
  $("#provider-id").value = "";
  $("#provider-url").value = "https://api.openai.com/v1";
  $("#form-error").textContent = "";
  dialog.showModal();
});
$("#close-dialog").addEventListener("click", () => dialog.close());
$("#cancel-dialog").addEventListener("click", () => dialog.close());
$("#provider-kind").addEventListener("change", (event) => {
  if (event.target.value === "openai_responses" && !$("#provider-url").value) $("#provider-url").value = "https://api.openai.com/v1";
});
$("#provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  try {
    const headers = Object.fromEntries($("#provider-headers").value.split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf(":");
        if (separator <= 0) throw new Error(`请求头格式无效：${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }));
    await window.codexlink.upsertProvider({
      id: $("#provider-id").value || undefined,
      kind: $("#provider-kind").value,
      displayName: $("#provider-name").value,
      baseUrl: $("#provider-url").value,
      defaultModel: $("#provider-model").value,
      apiKey: $("#provider-key").value,
      headers,
    });
    dialog.close();
    showToast("Provider 已安全保存");
  } catch (error) {
    $("#form-error").textContent = error.message || "保存失败";
  }
});

window.codexlink.onState(render);
window.codexlink.snapshot().then(render).catch((error) => showToast(error.message));
