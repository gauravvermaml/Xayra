package expo.modules.devicecpu

import android.content.Context
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Exposes the device's real CPU core count so JS-side inference code
 * (services/ai/localLlama.ts) can size its thread pool to actual hardware
 * instead of a number hardcoded for one test device — see this module's
 * index.ts for the on-device freeze this was written to fix.
 *
 * Also exposes Android's own thermal-status signal (PowerManager, API 29+)
 * so background AI work (services/ai/transformationEngine.ts's to-do
 * extraction) can defer itself when the device is already running hot,
 * rather than piling more sustained heavy CPU load onto a chipset that's
 * already throttling — general device hygiene for any device class, not a
 * fix tuned to one test phone's thermal curve.
 */
class DeviceCpuModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceCpu")

    Function("getCoreCount") {
      Runtime.getRuntime().availableProcessors()
    }

    // Returns one of PowerManager.THERMAL_STATUS_* (0 NONE .. 6 SHUTDOWN),
    // or -1 when the API isn't available (pre-Android-10) or the system
    // service can't be resolved — callers must treat -1 as "unknown," never
    // as "definitely cool."
    Function("getThermalStatus") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        return@Function -1
      }
      val context = appContext.reactContext ?: return@Function -1
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      powerManager?.currentThermalStatus ?: -1
    }
  }
}
