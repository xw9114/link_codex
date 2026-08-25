package dev.local.codexlink.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class PairingPayload(
    val v: Int,
    val relay: String,
    val sessionId: String,
    val macDeviceId: String,
    val macIdentityPublicKey: String,
    val expiresAt: Long,
    val displayName: String = "",
    val tlsCertSha256: String,
    val tlsSpkiSha256: String,
    val relayAlternates: List<String> = emptyList(),
    val client: String? = null,
)

@Serializable
data class ProjectProfile(
    val id: String,
    val displayName: String,
    val pathHint: String,
)

@Serializable
data class ProviderProfile(
    val id: String,
    val kind: String,
    val displayName: String,
    val baseUrl: String? = null,
    val defaultModel: String? = null,
    val status: String = "untested",
    val lastTestAt: String? = null,
    val hasCredential: Boolean = false,
)

data class HostPermissions(
    val allowDangerFullAccess: Boolean = false,
    val allowNeverApproval: Boolean = false,
)

@Serializable
data class ThreadSummary(
    val id: String,
    val name: String? = null,
    val preview: String = "",
    val cwd: String = "",
    val status: JsonElement? = null,
    val updatedAt: Long? = null,
    val codexlinkProjectId: String? = null,
)

@Serializable
data class RpcRequest(
    val id: Long,
    val method: String,
    val params: JsonElement,
)

@Serializable
data class RpcNotification(
    val method: String,
    val params: JsonElement? = null,
)

@Serializable
data class TimelineEntry(
    val stableId: String,
    val threadId: String,
    val type: String,
    val title: String,
    val body: String,
    val timestamp: Long = System.currentTimeMillis(),
    val raw: JsonElement? = null,
)

@Serializable
data class ProviderUpsertInput(
    val id: String? = null,
    val kind: String,
    val displayName: String,
    val baseUrl: String,
    val defaultModel: String,
    @SerialName("apiKey") val apiKey: String? = null,
    val headers: Map<String, String> = emptyMap(),
)
