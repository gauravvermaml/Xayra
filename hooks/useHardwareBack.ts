import { useCallback, useRef } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";

/**
 * Android Back for one screen, only while that screen is focused: a single
 * listener per focus, removed on blur and unmount — never one per render —
 * so pushed screens (Archive, Settings) keep their own Back and listeners
 * can't pile up. It always calls the latest `handler` (read through a ref,
 * so no stale state). Return true when the press was handled; false lets
 * Android's own Back run.
 */
export function useHardwareBack(handler: () => boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => handlerRef.current());
      return () => subscription.remove();
    }, [])
  );
}
