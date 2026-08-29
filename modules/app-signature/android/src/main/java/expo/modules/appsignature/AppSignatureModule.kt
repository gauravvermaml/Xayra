package expo.modules.appsignature

import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

/**
 * Diagnostics-only module. Reads the *running* APK's signing certificate
 * straight from `PackageManager` (not a keystore file on disk, which may not
 * be the one that actually signed this install) and hashes it to the same
 * SHA-1 fingerprint format Google Cloud Console's OAuth client config shows
 * (colon-separated uppercase hex), so a `DEVELOPER_ERROR` from
 * `@react-native-google-signin/google-signin` can be root-caused by
 * eyeballing this against the registered Android OAuth client.
 */
class AppSignatureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppSignature")

    Function("getSigningSha1Fingerprint") {
      getSha1Fingerprint()
    }

    Function("getPackageName") {
      appContext.reactContext?.packageName ?: ""
    }
  }

  private fun getSha1Fingerprint(): String? {
    val context = appContext.reactContext ?: return null
    val packageManager = context.packageManager
    val packageName = context.packageName

    val signatureBytes: ByteArray? = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val info = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val signingInfo = info.signingInfo ?: return null
        val signers = if (signingInfo.hasMultipleSigners()) {
          signingInfo.apkContentsSigners
        } else {
          signingInfo.signingCertificateHistory
        }
        signers?.firstOrNull()?.toByteArray()
      } else {
        @Suppress("DEPRECATION")
        val info = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
        @Suppress("DEPRECATION")
        info.signatures?.firstOrNull()?.toByteArray()
      }
    } catch (e: PackageManager.NameNotFoundException) {
      null
    } catch (e: Exception) {
      null
    }

    if (signatureBytes == null) {
      return null
    }

    val digest = MessageDigest.getInstance("SHA-1").digest(signatureBytes)
    return digest.joinToString(":") { byte -> "%02X".format(byte) }
  }
}
