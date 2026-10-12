export const AGENT_TRANSITION_MS = 1100;
export const AGENT_GATHER_RATIO = .78;

export const AGENT_PRESENTATIONS = Object.freeze(['closed', 'mini', 'popover', 'workspace']);

export function presentationKey({ workspace = false, open = false, docked = false, popover = false } = {}) {
  if (workspace) return 'F';
  if (popover && docked && !open) return 'E';
  return docked ? (open ? 'D' : 'C') : (open ? 'B' : 'A');
}

// Toolbar position is orthogonal to the Agent container's presentation.
export const PRESENTATION_CASES = Object.freeze({
  A: 'closed', B: 'mini', C: 'closed', D: 'mini', E: 'popover', F: 'workspace',
});

export function transitionKind(from, to) {
  if (!(from in PRESENTATION_CASES) || !(to in PRESENTATION_CASES)) throw new TypeError('Unknown Agent presentation');
  if (from === to) return 'retain';
  return PRESENTATION_CASES[from] === PRESENTATION_CASES[to] ? 'layout' : 'particles';
}
