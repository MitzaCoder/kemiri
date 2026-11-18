package io.github.mitzacoder.kemiri.notifications

import android.content.Context
import android.content.ContextWrapper
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.FirebaseAuthException
import io.github.mitzacoder.kemiri.features.notifications.relay.FirebaseRelayAccount
import io.github.mitzacoder.kemiri.features.notifications.relay.RelaySignInProblem
import io.github.mitzacoder.kemiri.features.notifications.relay.isCustomRelayHostingHost
import io.github.mitzacoder.kemiri.features.notifications.relay.relayFirebaseSignInProblem
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class FirebaseRelayAccountTest {
    @Test fun `only a custom Hosting host is passed to setLinkDomain`() {
        assertFalse(isCustomRelayHostingHost("example-project.web.app"))
        assertFalse(isCustomRelayHostingHost("example-project.firebaseapp.com"))
        assertFalse(isCustomRelayHostingHost("example-project.FirebaseApp.COM"))
        assertFalse(isCustomRelayHostingHost(""))
        assertTrue(isCustomRelayHostingHost("links.example.com"))
    }

    @Test fun `configuration and unknown Firebase Auth errors are not network errors`() {
        for (code in listOf("ERROR_INVALID_HOSTING_LINK_DOMAIN", "ERROR_MISSING_CONTINUE_URI",
            "INTERNAL_ERROR", "ERROR_FUTURE_AUTH_CODE")) {
            assertEquals(code, RelaySignInProblem.Misconfigured,
                relayFirebaseSignInProblem(FirebaseAuthException(code, "SDK details stay private")))
        }
        assertEquals(RelaySignInProblem.Misconfigured, relayFirebaseSignInProblem(IllegalArgumentException()))
    }

    @Test fun `transport failures still show the network problem`() {
        assertEquals(RelaySignInProblem.Network, relayFirebaseSignInProblem(FirebaseNetworkException("offline")))
        assertEquals(RelaySignInProblem.Network, relayFirebaseSignInProblem(IOException("offline")))
    }

    @Test fun `expired links and rate limits retain their specific problems`() {
        assertEquals(RelaySignInProblem.LinkExpired,
            relayFirebaseSignInProblem(FirebaseAuthException("ERROR_EXPIRED_ACTION_CODE", "expired")))
        assertEquals(RelaySignInProblem.EmailUnavailable,
            relayFirebaseSignInProblem(FirebaseTooManyRequestsException("rate limited")))
    }

    @Test fun `off creates no Firebase Auth object even when queried during normal use`() = runTest {
        var created = 0
        val context = object : ContextWrapper(null) {
            override fun getApplicationContext(): Context = this
        }
        val account = FirebaseRelayAccount(context) {
            created++
            error("Auth must never be created with the relay switch off")
        }
        assertNull(account.identity())
        assertNull(account.idToken())
        assertEquals("", account.pendingEmail())
        assertFalse(account.recentlyAuthenticated())
        account.signOut()
        assertEquals(0, created)
    }
}
