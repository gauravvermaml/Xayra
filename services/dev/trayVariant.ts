/**
 * STAGE 2 SPIKE ONLY — which tray/dock architecture the home screen uses in a
 * development package (Xayra Dev / Xayra Test). Production always gets
 * "control" (today's 1.0.43 behaviour) and never reads the file.
 *
 *   control — today's tray and floating controls, untouched
 *   A       — '20%'/'50%' snap points kept; a placeholder dock in a reserved
 *             area below the sheet (gorhom `bottomInset`)
 *   A2      — as A, but the reserved area is released while composing
 *   B       — content-sized rest snap point; the dock is the sheet's footer
 *
 * Set with the dev route `/dev-tray?v=A`, then restart the app.
 */
import { useEffect, useState } from "react";
import * as FileSystem from "expo-file-system/legacy";

import { isDevelopmentBuild } from "../ai/perf";

export type TrayVariant = "control" | "A" | "A2" | "B";
const VARIANTS: readonly TrayVariant[] = ["control", "A", "A2", "B"];

function variantPath(): string | null {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}dev-tray-variant.json` : null;
}

export function isTrayVariant(value: unknown): value is TrayVariant {
  return typeof value === "string" && (VARIANTS as readonly string[]).includes(value);
}

export async function readTrayVariant(): Promise<TrayVariant> {
  const path = variantPath();
  if (!isDevelopmentBuild() || !path) return "control";
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return "control";
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(path));
    const v = (parsed as { variant?: unknown })?.variant;
    return isTrayVariant(v) ? v : "control";
  } catch {
    return "control";
  }
}

export async function writeTrayVariant(variant: TrayVariant): Promise<void> {
  const path = variantPath();
  if (!isDevelopmentBuild() || !path) return;
  await FileSystem.writeAsStringAsync(path, JSON.stringify({ variant }));
}

/** "control" until the file has been read (production: always "control"). */
export function useTrayVariant(): TrayVariant {
  const [variant, setVariant] = useState<TrayVariant>("control");
  useEffect(() => {
    let alive = true;
    void readTrayVariant().then((v) => {
      if (alive) setVariant(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return variant;
}
