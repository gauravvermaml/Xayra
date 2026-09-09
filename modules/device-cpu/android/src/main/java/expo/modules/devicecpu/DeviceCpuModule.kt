package expo.modules.devicecpu

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Exposes the device's real CPU core count so JS-side inference code
 * (services/ai/localLlama.ts) can size its thread pool to actual hardware
 * instead of a number hardcoded for one test device — see this module's
 * index.ts for the on-device freeze this was written to fix.
 */
class DeviceCpuModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceCpu")

    Function("getCoreCount") {
      Runtime.getRuntime().availableProcessors()
    }
  }
}
