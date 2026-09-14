package expo.modules.devicecpu

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
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
 *
 * Build 40: also exposes a one-shot memory check (`getMemoryInfo`) and a
 * live low-memory warning stream (`onMemoryPressure`) — see
 * services/ai/memoryGuard.ts for why onboarding needs both. Confirmed
 * on-device: Android's own low-memory killer reaped this app's process
 * mid-onboarding on a Pixel 9 with several ordinary background apps open
 * (Facebook, Messenger, Instagram, LinkedIn) — a realistic, not edge-case,
 * condition. Neither signal can PREVENT that kill (no app-level API grants
 * immunity from LMKD), but both let the app react before/around it instead
 * of a user just watching a screen that quietly stops responding.
 */
class DeviceCpuModule : Module() {
  private var memoryCallbacks: ComponentCallbacks2? = null

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

    // One-shot snapshot of system-wide (not just this app's) memory state —
    // ActivityManager.MemoryInfo.lowMemory is the exact same signal Android
    // itself uses to decide whether it's willing to start killing background
    // processes for room. `-1`/`false` sentinel values on failure, same
    // "unknown is not the same as safe" contract as getThermalStatus above.
    Function("getMemoryInfo") {
      val context = appContext.reactContext
        ?: return@Function mapOf("availMB" to -1.0, "totalMB" to -1.0, "thresholdMB" to -1.0, "lowMemory" to false)
      val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        ?: return@Function mapOf("availMB" to -1.0, "totalMB" to -1.0, "thresholdMB" to -1.0, "lowMemory" to false)
      val info = ActivityManager.MemoryInfo()
      activityManager.getMemoryInfo(info)
      mapOf(
        "availMB" to info.availMem / 1024.0 / 1024.0,
        "totalMB" to info.totalMem / 1024.0 / 1024.0,
        "thresholdMB" to info.threshold / 1024.0 / 1024.0,
        "lowMemory" to info.lowMemory
      )
    }

    Events("onMemoryPressure")

    // Only registers Android's live memory-pressure callback while JS
    // actually has a listener attached (OnStartObserving/OnStopObserving
    // fire exactly once each, on the first subscriber and last unsubscribe —
    // not once per listener) — no always-on native callback sitting idle
    // for the entire app lifetime when nothing's using it.
    OnStartObserving {
      if (memoryCallbacks != null) return@OnStartObserving
      val context = appContext.reactContext ?: return@OnStartObserving
      val callbacks = object : ComponentCallbacks2 {
        override fun onConfigurationChanged(newConfig: Configuration) {}
        override fun onLowMemory() {
          sendEvent("onMemoryPressure", mapOf("level" to ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
        }
        // TRIM_MEMORY_RUNNING_LOW/_CRITICAL fire while this app is still in
        // the foreground and the SYSTEM overall is getting tight — exactly
        // the early-warning window between "fine" and "already killed" that
        // a one-shot check at the start of onboarding can't see coming.
        override fun onTrimMemory(level: Int) {
          if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            sendEvent("onMemoryPressure", mapOf("level" to level))
          }
        }
      }
      context.applicationContext.registerComponentCallbacks(callbacks)
      memoryCallbacks = callbacks
    }

    OnStopObserving {
      val context = appContext.reactContext ?: return@OnStopObserving
      memoryCallbacks?.let { context.applicationContext.unregisterComponentCallbacks(it) }
      memoryCallbacks = null
    }
  }
}
