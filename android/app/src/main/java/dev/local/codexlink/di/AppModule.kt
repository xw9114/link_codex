package dev.local.codexlink.di

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.local.codexlink.data.ApprovalDao
import dev.local.codexlink.data.CodexLinkDatabase
import dev.local.codexlink.data.HostDao
import dev.local.codexlink.data.ThreadDao
import dev.local.codexlink.security.WrappedSecretStore
import javax.inject.Singleton
import net.sqlcipher.database.SupportFactory
import okhttp3.OkHttpClient

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton
    fun database(@ApplicationContext context: Context, secrets: WrappedSecretStore): CodexLinkDatabase {
        val passphrase = secrets.getOrCreate("database.passphrase", 32)
        return Room.databaseBuilder(context, CodexLinkDatabase::class.java, "codexlink.db")
            .openHelperFactory(SupportFactory(passphrase))
            .fallbackToDestructiveMigration()
            .build()
    }

    @Provides fun hostDao(database: CodexLinkDatabase): HostDao = database.hostDao()
    @Provides fun threadDao(database: CodexLinkDatabase): ThreadDao = database.threadDao()
    @Provides fun approvalDao(database: CodexLinkDatabase): ApprovalDao = database.approvalDao()
    @Provides @Singleton fun okHttp(): OkHttpClient = OkHttpClient.Builder().retryOnConnectionFailure(true).build()
}
