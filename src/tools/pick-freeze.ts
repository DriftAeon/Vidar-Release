// Pick-freeze state for hover tools: tracks the pointer until a pick, then holds the picked
// spot. The next pick moves the hold; a reset (disarm or re-arm) goes back to tracking.
export function pickFreeze() {
  let frozen = false;
  return {
    get tracking() { return !frozen; },
    pick() { frozen = true; },
    reset() { frozen = false; },
  };
}
