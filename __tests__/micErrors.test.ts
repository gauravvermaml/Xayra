/** Gate B: a retried Cancel clears only its own earlier "couldn't stop" message. */
import { CANCEL_STOP_FAILED_MESSAGE, clearCancelStopError } from "../utils/micErrors";

describe("clearCancelStopError", () => {
  it("clears the failed-Cancel message", () => {
    expect(clearCancelStopError(CANCEL_STOP_FAILED_MESSAGE)).toBeNull();
  });
  it("leaves any other error (another recording's, or a genuine failure) alone", () => {
    expect(clearCancelStopError("Recording failed.")).toBe("Recording failed.");
    expect(clearCancelStopError("Couldn’t stop the microphone. Try again.")).toBe("Couldn’t stop the microphone. Try again.");
    expect(clearCancelStopError(null)).toBeNull();
  });
});
