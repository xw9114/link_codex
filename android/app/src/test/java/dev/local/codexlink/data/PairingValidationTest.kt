package dev.local.codexlink.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingValidationTest {
    @Test fun acceptsTailnetAddressesAndMagicDns() {
        assertTrue(isTailnetHost("100.102.132.76"))
        assertTrue(isTailnetHost("fd7a:115c:a1e0::8f35:844d"))
        assertTrue(isTailnetHost("node.tail29c791.ts.net."))
    }

    @Test fun rejectsPublicAndMalformedHosts() {
        assertFalse(isTailnetHost("192.168.1.20"))
        assertFalse(isTailnetHost("8.8.8.8"))
        assertFalse(isTailnetHost("100.128.0.1"))
        assertFalse(isTailnetHost("not-a-host"))
    }
}
