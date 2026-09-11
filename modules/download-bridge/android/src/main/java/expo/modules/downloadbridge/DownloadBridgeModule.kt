package expo.modules.downloadbridge

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * Hands a large model download to Android's own system DownloadManager
 * service rather than running it inside this app's React Native process
 * (the previous approach — see services/ai/modelDownloadManager.ts's
 * expo-file-system DownloadResumable — dies the moment the OS freezes or
 * kills a backgrounded app mid-transfer, which a multi-hour first-run
 * download during Xayra's "One Door, Opens Once" onboarding screen
 * explicitly invites the user to do). DownloadManager is a real OS service:
 * once enqueued, the transfer survives this app's process being frozen,
 * killed, or even a device reboot, and JS just polls `query()` for status.
 *
 * DownloadManager can only write into a *public or app-private external*
 * storage location, never the app's internal `filesDir` that
 * `FileSystem.documentDirectory` resolves to — so every download lands in
 * `getExternalFilesDir(null)/<destFilename>` first, and the caller
 * (modelDownloadManager.ts) moves the finished file into
 * `FileSystem.documentDirectory` itself once `query()` reports "successful".
 *
 * `query()` returns a JSON string rather than a Kotlin Map/Record — the
 * simplest return type this bridge could use that's unambiguous to convert,
 * matching the existing modules/device-cpu pattern of keeping the native
 * side to plain, easily-verified primitives.
 */
class DownloadBridgeModule : Module() {
  private val downloadManager: DownloadManager
    get() {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      return context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    }

  override fun definition() = ModuleDefinition {
    Name("DownloadBridge")

    // Returns the DownloadManager-assigned download ID (as a Double — JS
    // numbers safely represent it exactly; download IDs are small
    // monotonically increasing longs, nowhere near float64's 2^53 limit).
    Function("enqueue") { url: String, destFilename: String, title: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        // HIDDEN, not VISIBLE: Xayra already shows its own onboarding
        // progress UI and its own silent notification mirror (see
        // downloadNotification.ts) - a second, separate system-owned
        // DownloadManager notification for the same transfer would be
        // redundant UI noise and undercut the "One Door, Opens Once"
        // onboarding screen's own progress presentation.
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_HIDDEN)
        .setDestinationInExternalFilesDir(context, null, destFilename)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)
      downloadManager.enqueue(request).toDouble()
    }

    // JSON: { status: "pending"|"running"|"paused"|"successful"|"failed"|"not_found",
    //         bytesDownloaded: number, bytesTotal: number, localUri: string|null, reason: number }
    Function("query") { downloadId: Double ->
      val query = DownloadManager.Query().setFilterById(downloadId.toLong())
      downloadManager.query(query).use { cursor ->
        val result = JSONObject()
        if (!cursor.moveToFirst()) {
          result.put("status", "not_found")
          result.put("bytesDownloaded", 0)
          result.put("bytesTotal", 0)
          result.put("localUri", JSONObject.NULL)
          result.put("reason", 0)
          return@Function result.toString()
        }

        val status = when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
          DownloadManager.STATUS_SUCCESSFUL -> "successful"
          DownloadManager.STATUS_FAILED -> "failed"
          DownloadManager.STATUS_RUNNING -> "running"
          DownloadManager.STATUS_PAUSED -> "paused"
          DownloadManager.STATUS_PENDING -> "pending"
          else -> "unknown"
        }
        val localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))

        result.put("status", status)
        result.put(
          "bytesDownloaded",
          cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        )
        result.put(
          "bytesTotal",
          cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        )
        result.put("localUri", localUri ?: JSONObject.NULL)
        result.put("reason", cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
        result.toString()
      }
    }

    Function("cancel") { downloadId: Double ->
      downloadManager.remove(downloadId.toLong())
      Unit
    }
  }
}
