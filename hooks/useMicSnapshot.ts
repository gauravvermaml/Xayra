import { useEffect, useState } from "react";

import { getMicSnapshot, subscribeMicState, type MicSnapshot } from "../services/audio/micSession";

/** The shared microphone session's state (services/audio/micSession.ts),
 * kept current. */
export function useMicSnapshot(): MicSnapshot {
  const [snapshot, setSnapshot] = useState<MicSnapshot>(getMicSnapshot);
  useEffect(() => {
    setSnapshot(getMicSnapshot());
    return subscribeMicState(setSnapshot);
  }, []);
  return snapshot;
}
