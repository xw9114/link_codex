package dev.local.codexlink.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.dataStore by preferencesDataStore("codexlink_settings")

@Singleton
class SettingsStore @Inject constructor(@ApplicationContext private val context: Context) {
    private val keepConnected = booleanPreferencesKey("keep_connected")
    val keepConnectedFlow: Flow<Boolean> = context.dataStore.data.map { it[keepConnected] ?: true }
    suspend fun setKeepConnected(value: Boolean) { context.dataStore.edit { it[keepConnected] = value } }
}
