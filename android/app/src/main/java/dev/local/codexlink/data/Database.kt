package dev.local.codexlink.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "hosts")
data class HostEntity(
    @PrimaryKey val macDeviceId: String,
    val displayName: String,
    val pairingJson: String,
    val phoneDeviceId: String,
    val pairedAt: Long,
    val lastConnectedAt: Long? = null,
    val lastAppliedBridgeOutboundSeq: Long = 0,
    val bridgeReplayEpoch: String = "",
)

@Entity(tableName = "threads")
data class ThreadEntity(
    @PrimaryKey val id: String,
    val projectId: String,
    val title: String,
    val preview: String,
    val status: String,
    val rawJson: String,
    val updatedAt: Long,
)

@Entity(tableName = "approvals")
data class ApprovalEntity(
    @PrimaryKey val requestId: String,
    val threadId: String,
    val method: String,
    val payloadJson: String,
    val createdAt: Long,
)

@Dao
interface HostDao {
    @Query("SELECT * FROM hosts ORDER BY pairedAt DESC LIMIT 1")
    fun observeActive(): Flow<HostEntity?>

    @Query("SELECT * FROM hosts ORDER BY pairedAt DESC LIMIT 1")
    suspend fun active(): HostEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(host: HostEntity)

    @Query("UPDATE hosts SET lastConnectedAt = :connectedAt WHERE macDeviceId = :hostId")
    suspend fun markConnected(hostId: String, connectedAt: Long)

    @Query("UPDATE hosts SET lastAppliedBridgeOutboundSeq = :sequence, bridgeReplayEpoch = :epoch WHERE macDeviceId = :hostId")
    suspend fun updateReplayCursor(hostId: String, sequence: Long, epoch: String)

    @Query("DELETE FROM hosts")
    suspend fun clear()
}

@Dao
interface ThreadDao {
    @Query("SELECT * FROM threads ORDER BY updatedAt DESC")
    fun observeAll(): Flow<List<ThreadEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(threads: List<ThreadEntity>)

    @Query("DELETE FROM threads")
    suspend fun clear()
}

@Dao
interface ApprovalDao {
    @Query("SELECT * FROM approvals ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<ApprovalEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(approval: ApprovalEntity)

    @Query("DELETE FROM approvals WHERE requestId = :requestId")
    suspend fun delete(requestId: String)
}

@Database(entities = [HostEntity::class, ThreadEntity::class, ApprovalEntity::class], version = 1, exportSchema = true)
abstract class CodexLinkDatabase : RoomDatabase() {
    abstract fun hostDao(): HostDao
    abstract fun threadDao(): ThreadDao
    abstract fun approvalDao(): ApprovalDao
}
