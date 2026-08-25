package dev.local.codexlink.ui

import android.annotation.SuppressLint
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@SuppressLint("UnsafeOptInUsageError")
@Composable
fun QrScanner(onResult: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient() }
    val delivered = remember { AtomicBoolean(false) }
    val disposed = remember { AtomicBoolean(false) }
    val providerRef = remember { AtomicReference<ProcessCameraProvider?>(null) }

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { viewContext ->
            PreviewView(viewContext).also { previewView ->
                val providerFuture = ProcessCameraProvider.getInstance(viewContext)
                providerFuture.addListener({
                    if (disposed.get()) return@addListener
                    val provider = runCatching { providerFuture.get() }.getOrNull() ?: return@addListener
                    providerRef.set(provider)
                    val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(executor) { imageProxy ->
                        val mediaImage = imageProxy.image
                        if (mediaImage == null || delivered.get() || disposed.get()) {
                            imageProxy.close()
                            return@setAnalyzer
                        }
                        runCatching { scanner.process(InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)) }
                            .getOrNull()
                            ?.also { task ->
                                task.addOnSuccessListener { barcodes ->
                                    val value = barcodes.firstOrNull { it.valueType == Barcode.TYPE_TEXT || it.rawValue?.startsWith("{") == true }?.rawValue
                                    if (!disposed.get() && !value.isNullOrBlank() && delivered.compareAndSet(false, true)) onResult(value)
                                }.addOnCompleteListener { imageProxy.close() }
                            } ?: imageProxy.close()
                    }
                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    }.onFailure { analysis.clearAnalyzer() }
                }, ContextCompat.getMainExecutor(viewContext))
            }
        },
    )

    DisposableEffect(Unit) {
        onDispose {
            disposed.set(true)
            providerRef.getAndSet(null)?.unbindAll()
            scanner.close()
            executor.shutdown()
        }
    }
}
