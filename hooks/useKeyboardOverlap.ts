import { useEffect, useState, type RefObject } from "react";
import { Keyboard, Platform, type KeyboardEvent, type View } from "react-native";

/**
 * How many pixels of `containerRef` the on-screen keyboard currently covers
 * (0 when hidden). Give it to a bottom-anchored container as paddingBottom
 * and its content sits just above the keyboard.
 *
 * Measured, not assumed: the keyboard's top edge is compared with the
 * container's own bottom edge in window coordinates. Where the OS already
 * resizes the window for the keyboard the overlap comes out as 0, so this
 * never double-compensates; under edge-to-edge (this app, targetSdk 36),
 * where a Modal's window is NOT resized, it is the keyboard's full height.
 */
export function useKeyboardOverlap(containerRef: RefObject<View | null>): number {
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    // Android only delivers the "did" events; iOS gets the earlier "will".
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: KeyboardEvent) => {
      const keyboardTop = e.endCoordinates.screenY;
      const node = containerRef.current;
      if (!node || typeof node.measureInWindow !== "function") {
        setOverlap(e.endCoordinates.height);
        return;
      }
      node.measureInWindow((_x, y, _width, height) => {
        if (!height) {
          setOverlap(e.endCoordinates.height);
          return;
        }
        setOverlap(Math.max(0, y + height - keyboardTop));
      });
    };
    const onHide = () => setOverlap(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [containerRef]);

  return overlap;
}
