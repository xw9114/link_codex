package dev.local.codexlink.data

/** Accept only Tailnet IPv4/IPv6 addresses or Tailscale MagicDNS names. */
internal fun isTailnetHost(host: String): Boolean {
    val normalized = host.trimEnd('.').lowercase()
    if (normalized.endsWith(".ts.net")) return true
    if (normalized.startsWith("fd7a:115c:a1e0:")) return true
    val octets = normalized.split('.')
    if (octets.size != 4 || octets.any { it.toIntOrNull() !in 0..255 }) return false
    return octets[0] == "100" && octets[1].toInt() in 64..127
}
