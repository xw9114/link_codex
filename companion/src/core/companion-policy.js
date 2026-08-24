const THREAD_BOUND_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/fork",
  "thread/turns/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const SAFE_PASSTHROUGH_METHODS = new Set([
  "initialize",
  "initialized",
  "model/list",
  "account/status/read",
  "account/rateLimits/read",
]);

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

function rpcResult(id, result) {
  return JSON.stringify({ id, result });
}

function rpcError(id, error) {
  return JSON.stringify({
    id,
    error: {
      code: error.code || "codexlink_error",
      message: error.message || "CodexLink request failed.",
    },
  });
}

function readThreadId(parsed) {
  return parsed?.params?.threadId
    || parsed?.params?.thread_id
    || parsed?.params?.thread?.id
    || parsed?.params?.turn?.threadId
    || "";
}

function readResponseThread(result) {
  return result?.thread || result?.data?.thread || null;
}

function threadIdOf(thread) {
  return thread?.id || thread?.threadId || thread?.thread_id || "";
}

function listRows(result) {
  for (const key of ["data", "threads", "items"]) {
    if (Array.isArray(result?.[key])) return { key, rows: result[key] };
  }
  return null;
}

function responseFromAsync(id, sendResponse, operation) {
  void Promise.resolve(operation)
    .then((result) => sendResponse(rpcResult(id, result)))
    .catch((error) => sendResponse(rpcError(id, error)));
}

function createCompanionPolicy({
  projectStore,
  providerStore,
  getHostStatus = () => ({}),
  allowDangerFullAccess = false,
  allowNeverApproval = false,
} = {}) {
  const authorizedThreads = new Map();
  const pendingRequests = new Map();
  const pendingApprovals = new Map();
  let activeTurnCount = 0;

  function isAuthorizedThread(threadId) {
    return Boolean(threadId && authorizedThreads.has(threadId));
  }

  function authorizeThread(thread, fallback = null) {
    const threadId = threadIdOf(thread);
    if (!threadId) return null;
    const project = fallback?.project || projectStore.findByCwd(thread?.cwd);
    if (!project) return null;
    const record = {
      threadId,
      projectId: project.id,
      projectPath: project.path,
      providerId: fallback?.providerId || thread?.codexlinkProviderId || null,
    };
    authorizedThreads.set(threadId, record);
    return record;
  }

  function enforceExecutionSettings(params, projectPath) {
    const next = { ...params, cwd: projectPath };
    const sandbox = SANDBOXES.has(params.sandbox) ? params.sandbox : "workspace-write";
    if (sandbox === "danger-full-access" && !allowDangerFullAccess) {
      throw Object.assign(new Error("电脑端未允许 danger-full-access。"), {
        code: "sandbox_exceeds_host_limit",
      });
    }
    const approvalPolicy = APPROVAL_POLICIES.has(params.approvalPolicy)
      ? params.approvalPolicy
      : "on-request";
    if (approvalPolicy === "never" && !allowNeverApproval) {
      throw Object.assign(new Error("电脑端未允许 never 审批策略。"), {
        code: "approval_exceeds_host_limit",
      });
    }
    next.sandbox = sandbox;
    next.approvalPolicy = approvalPolicy;
    delete next.projectId;
    delete next.providerId;
    delete next.modelProvider;
    return next;
  }

  function handleThreadStart(parsed, sendResponse, forward) {
    let project;
    let provider;
    let params;
    try {
      project = projectStore.resolve(parsed.params?.projectId);
      provider = providerStore.resolveForThread(parsed.params?.providerId || "chatgpt");
      params = enforceExecutionSettings(parsed.params || {}, project.path);
      if (provider.modelProvider) params.modelProvider = provider.modelProvider;
      if (!params.model && provider.defaultModel) params.model = provider.defaultModel;
    } catch (error) {
      sendResponse(rpcError(parsed.id, error));
      return;
    }
    pendingRequests.set(String(parsed.id), {
      method: parsed.method,
      project,
      providerId: provider.providerId,
    });
    forward(JSON.stringify({ ...parsed, params }));
  }

  function handleThreadBound(parsed, sendResponse, forward) {
    const threadId = readThreadId(parsed);
    const authorized = authorizedThreads.get(threadId);
    if (!authorized) {
      sendResponse(rpcError(parsed.id, Object.assign(
        new Error("该任务不属于电脑端白名单项目；请先刷新任务列表。"),
        { code: "thread_not_allowed" }
      )));
      return;
    }
    let params = { ...(parsed.params || {}) };
    if (parsed.method === "turn/start") {
      try {
        params = enforceExecutionSettings(params, authorized.projectPath);
      } catch (error) {
        sendResponse(rpcError(parsed.id, error));
        return;
      }
      delete params.modelProvider;
      activeTurnCount += 1;
    }
    if (parsed.method === "thread/fork") {
      params.cwd = authorized.projectPath;
      delete params.modelProvider;
      delete params.providerId;
    }
    if (parsed.method === "thread/resume") {
      // Resuming a thread must stay inside the desktop allowlist and retain
      // the provider selected when the thread was created.  The app-server
      // accepts cwd/provider-shaped fields on resume, so do not trust values
      // supplied by the phone here.
      params.cwd = authorized.projectPath;
      delete params.modelProvider;
      delete params.providerId;
    }
    let project;
    try {
      // The desktop allowlist may have changed after this thread was cached.
      // Re-resolve it before every thread-bound operation instead of allowing
      // a stale authorization record to survive project removal or relocation.
      project = projectStore.resolve(authorized.projectId);
    } catch (error) {
      sendResponse(rpcError(parsed.id, error));
      return;
    }
    pendingRequests.set(String(parsed.id), {
      method: parsed.method,
      project,
      providerId: authorized.providerId,
      threadId,
    });
    forward(JSON.stringify({ ...parsed, params }));
  }

  function handleApprovalResponse(parsed, sendResponse, forward) {
    const requestId = String(parsed.params?.requestId || "");
    const decision = String(parsed.params?.decision || "");
    const pending = pendingApprovals.get(requestId);
    if (!pending || !APPROVAL_DECISIONS.has(decision)) {
      sendResponse(rpcError(parsed.id, Object.assign(new Error("审批请求已失效或决策无效。"), {
        code: "approval_not_pending",
      })));
      return;
    }
    pendingApprovals.delete(requestId);
    forward(JSON.stringify({ id: pending.requestId, result: { decision } }));
    sendResponse(rpcResult(parsed.id, { accepted: true }));
  }

  function handleInbound(rawMessage, { sendResponse, forward }) {
    let parsed;
    try { parsed = JSON.parse(rawMessage); } catch { return false; }
    const method = typeof parsed.method === "string" ? parsed.method : "";

    if (!method && parsed.id != null) {
      sendResponse(rpcError(parsed.id, Object.assign(new Error("请通过 approval/respond 回应审批。"), {
        code: "raw_server_response_blocked",
      })));
      return true;
    }

    switch (method) {
    case "host/status":
      sendResponse(rpcResult(parsed.id, {
        ...getHostStatus(),
        activeTurnCount,
        authorizedThreadCount: authorizedThreads.size,
      }));
      return true;
    case "project/list":
      sendResponse(rpcResult(parsed.id, { data: projectStore.list() }));
      return true;
    case "provider/list":
      sendResponse(rpcResult(parsed.id, { data: providerStore.list() }));
      return true;
    case "provider/upsert":
      responseFromAsync(parsed.id, sendResponse, providerStore.upsert(parsed.params?.profile || parsed.params || {}));
      return true;
    case "provider/delete":
      responseFromAsync(parsed.id, sendResponse, providerStore.delete(parsed.params?.id));
      return true;
    case "provider/test":
      responseFromAsync(parsed.id, sendResponse, providerStore.test(parsed.params?.id));
      return true;
    case "approval/respond":
      handleApprovalResponse(parsed, sendResponse, forward);
      return true;
    case "thread/start":
      handleThreadStart(parsed, sendResponse, forward);
      return true;
    case "thread/list":
      pendingRequests.set(String(parsed.id), { method });
      forward(rawMessage);
      return true;
    default:
      if (THREAD_BOUND_METHODS.has(method)) {
        handleThreadBound(parsed, sendResponse, forward);
        return true;
      }
      if (SAFE_PASSTHROUGH_METHODS.has(method)) {
        forward(rawMessage);
        return true;
      }
      if (method.startsWith("workspace/") || method.startsWith("project/")
          || method.startsWith("fs/") || method.startsWith("process/")
          || method === "command/exec") {
        sendResponse(rpcError(parsed.id, Object.assign(new Error("手机端未开放该本地接口。"), {
          code: "method_not_allowed",
        })));
        return true;
      }
      sendResponse(rpcError(parsed.id, Object.assign(new Error("手机端未开放该接口。"), {
        code: "method_not_allowed",
      })));
      return true;
    }
  }

  function filterOutbound(rawMessage, preParsed = null) {
    let parsed = preParsed;
    try { parsed = parsed || JSON.parse(rawMessage); } catch { return rawMessage; }

    if (parsed.id != null && typeof parsed.method === "string" && parsed.method.endsWith("requestApproval")) {
      const threadId = readThreadId(parsed);
      if (!isAuthorizedThread(threadId)) return null;
      pendingApprovals.set(String(parsed.id), { requestId: parsed.id, threadId, method: parsed.method });
      return rawMessage;
    }

    if (parsed.id != null && (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "error"))) {
      const pending = pendingRequests.get(String(parsed.id));
      if (!pending) return rawMessage;
      pendingRequests.delete(String(parsed.id));
      if (parsed.error) {
        if (pending.method === "turn/start") activeTurnCount = Math.max(0, activeTurnCount - 1);
        return rawMessage;
      }
      if (pending.method === "thread/list") {
        const list = listRows(parsed.result);
        if (!list) return rawMessage;
        const allowed = [];
        for (const thread of list.rows) {
          const record = authorizeThread(thread);
          if (record) allowed.push({ ...thread, codexlinkProjectId: record.projectId });
        }
        return JSON.stringify({
          ...parsed,
          result: { ...parsed.result, [list.key]: allowed },
        });
      }
      if (new Set(["thread/start", "thread/read", "thread/resume", "thread/fork"]).has(pending.method)) {
        const thread = readResponseThread(parsed.result);
        const record = authorizeThread(thread, pending);
        if (!record) {
          return rpcError(parsed.id, Object.assign(new Error("Codex 返回了白名单外任务。"), {
            code: "thread_not_allowed",
          }));
        }
        if (thread && parsed.result?.thread) {
          parsed.result.thread = { ...thread, codexlinkProjectId: record.projectId };
        }
        return JSON.stringify(parsed);
      }
      return rawMessage;
    }

    const method = typeof parsed.method === "string" ? parsed.method : "";
    if (method === "thread/started") {
      const thread = parsed.params?.thread;
      const record = authorizeThread(thread);
      return record ? rawMessage : null;
    }
    if (method === "turn/completed") {
      const threadId = readThreadId(parsed);
      if (!isAuthorizedThread(threadId)) return null;
      activeTurnCount = Math.max(0, activeTurnCount - 1);
      return rawMessage;
    }
    const threadId = readThreadId(parsed);
    if (threadId && !isAuthorizedThread(threadId)) return null;
    return rawMessage;
  }

  return {
    filterOutbound,
    handleInbound,
    isAuthorizedThread,
    snapshot() {
      return {
        activeTurnCount,
        authorizedThreads: [...authorizedThreads.values()].map(({ projectPath, ...rest }) => rest),
        pendingApprovalCount: pendingApprovals.size,
      };
    },
  };
}

module.exports = {
  APPROVAL_DECISIONS,
  APPROVAL_POLICIES,
  SANDBOXES,
  createCompanionPolicy,
  listRows,
  readThreadId,
  rpcError,
  rpcResult,
};
