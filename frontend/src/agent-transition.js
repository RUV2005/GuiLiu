import { deferCanvasMotion, resumeCanvasMotion } from './agent-motion.js';
import { transitionAgentSurface, visibleAgentSurface, agentAnchor } from './agent-presentation.js';

let active, committing = false;
export function cancelWorkspaceTransition() { if (!committing) active?.finish(); }

export function transitionAgentWorkspace(render, { toToolbar = false } = {}) {
  const source = visibleAgentSurface();
  return active = transitionAgentSurface({ source, bridgePage: true, reveal: !toToolbar,
    update() {
      committing = true;
      deferCanvasMotion();
      document.documentElement.classList.add('agent-route-transition');
      try { render(); } finally { committing = false; }
    },
    target: () => toToolbar ? agentAnchor()
      : document.querySelector('.app-shell .agent-chat-column, .app-shell.agent-open #agent-panel') || agentAnchor(),
    complete() {
      document.documentElement.classList.remove('agent-route-transition');
      resumeCanvasMotion({ revealScrollbar: true });
    },
  });
}
