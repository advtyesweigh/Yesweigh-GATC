/**
 * Operator-assisted automation entrypoint (scaffold).
 * Real eMaap portal flows are intentionally not implemented yet.
 */
export function automationStatus() {
  return {
    ready: false,
    mode: 'operator-assisted',
    note: 'Infrastructure scaffold only — no portal submission automation.',
  };
}
