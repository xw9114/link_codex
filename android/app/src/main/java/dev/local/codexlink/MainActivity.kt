package dev.local.codexlink

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import dagger.hilt.android.AndroidEntryPoint
import dev.local.codexlink.ui.CodexLinkApp
import dev.local.codexlink.ui.MainViewModel

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        openIntentThread(intent)
        setContent { CodexLinkApp(viewModel) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openIntentThread(intent)
    }

    private fun openIntentThread(intent: Intent?) {
        intent?.getStringExtra(EXTRA_THREAD_ID)?.takeIf(String::isNotBlank)?.let(viewModel::openThread)
    }

    companion object { const val EXTRA_THREAD_ID = "threadId" }
}
