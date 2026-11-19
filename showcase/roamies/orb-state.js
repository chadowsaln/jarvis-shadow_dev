// What the entity is showing, from what the application is doing. This is a *consumer*: it reads the events the
// pages already get (the sidekick's ui messages, the agent's pose, the voice meter) and answers "what should the orb
// look like". Nothing here can make the app ready, start a turn or change a tool: the visual layer only listens.
//
// States: idle, listening, thinking, tool_execution, speaking, success, error, offline, sleeping.
// A reducer, not a spinner: `reduce(state, event, now)` is pure (same input, same output), so duplicate, late and
// malformed events are testable — they leave the state alone instead of flickering the entity.
// Classic script (window.Roamie.orbState), also readable from Node for the tests.
(() => {
  const R = (window.Roamie = window.Roamie || {});
  const STATES = ['idle', 'listening', 'thinking', 'tool_execution', 'speaking', 'success', 'error', 'offline', 'sleeping'];
  // Higher wins when several things are true at once (a turn that is speaking while a tool runs stays
  // tool_execution: the work is what matters, the voice is how it reports). Sleeping outranks idle: an entity that
  // has dozed off stays dim until something actually happens, rather than flickering back the moment nothing is.
  const RANK = { offline: 9, error: 8, tool_execution: 7, thinking: 6, speaking: 5, listening: 4, success: 3, sleeping: 2, idle: 1 };
  // How long a momentary state holds before the entity settles back (ms).
  const HOLD = { success: 1600, error: 5000 };
  const EMPTY = { name: 'idle', since: 0, until: 0, reason: null, seq: 0 };

  const isState = (v) => STATES.includes(v);

  /**
   * One event in, the next state out. Events are `{ type, ... }`:
   *   turn_start            a request went to the model (thinking)
   *   tool_start / tool_end a tool is running (tool_execution) / finished
   *   speech_start          a reply is being spoken or shown (speaking)
   *   speech_end            it finished (success, briefly)
   *   listen_start/end      the microphone opened/closed (listening)
   *   provider              the AI provider's own state: ready | unavailable (offline only while no model at all)
   *   failure               something the app reported as failed (error, briefly)
   *   sleep / wake          the pointer has been still for a while (sleeping) / it moved again (idle)
   *   clear                 back to idle (a new chat, dismiss)
   * Unknown types, missing fields and events that change nothing return the same state (no re-render, no flicker).
   */
  function reduce(state, event, now = 0) {
    const s = state && isState(state.name) ? state : { ...EMPTY };
    // A momentary state that has run out settles on its own before this event is read.
    const base = now >= (s.until || 0) && (s.name === 'success' || s.name === 'error') ? { ...s, name: 'idle', reason: null, until: 0 } : s;
    const type = event && typeof event.type === 'string' ? event.type : '';
    const seq = (base.seq || 0) + 1;
    const set = (name, extra = {}) => (name === base.name && extra.reason === base.reason
      ? base
      : { ...base, ...extra, name, seq, since: name === base.name ? base.since : now });
    const hold = (name, reason) => set(name, { reason: reason ?? null, until: now + (HOLD[name] ?? 0) });

    switch (type) {
      case 'listen_start':
        return set('listening');
      case 'listen_end':
        return base.name === 'listening' ? set('idle') : base;
      case 'turn_start':
        // A tool already running is the turn going on: `thinking` is what happens between its steps.
        return base.name === 'offline' || base.name === 'tool_execution' ? base : set('thinking');
      case 'tool_start':
        return base.name === 'offline' ? base : set('tool_execution');
      case 'tool_end':
        return base.name === 'tool_execution' ? set('thinking') : base;
      case 'speech_start':
        // Never leaves error/offline standing for a voice that was already queued when it happened, and a tool still
        // running stays the headline (the voice is how the work reports; it does not replace it).
        if (base.name === 'error' || base.name === 'offline' || base.name === 'tool_execution') return base;
        return set('speaking');
      case 'speech_end':
        return base.name === 'speaking' ? hold('success') : base;
      case 'failure':
        return hold('error', typeof event.reason === 'string' ? event.reason.slice(0, 120) : null);
      case 'sleep':
        // Nothing is happening: only a quiet entity dozes, never one that is working or listening.
        return base.name === 'idle' || base.name === 'sleeping' ? set('sleeping') : base;
      case 'wake':
        return base.name === 'sleeping' ? set('idle') : base;
      case 'provider': {
        // 'unavailable' is not the entity's problem while the app is otherwise fine (an OpenRouter 429, say): only
        // an app with no model at all reads as offline, and that comes from the sidecar's provider_status.
        if (event.status === 'unavailable' && event.offline === true) return set('offline');
        if (event.status === 'ready' && base.name === 'offline') return set('idle');
        return base;
      }
      case 'clear':
        return base.name === 'offline' ? base : set('idle');
      default:
        return base;
    }
  }

  /** The entity's state from what a frame already knows (the agent pose, the voice meter, the app's own flags). */
  function fromFrame(f, now = 0) {
    if (f?.offline) return 'offline';
    if (f?.mode === 'listen') return 'listening';
    if (f?.tooling) return 'tool_execution';
    if (f?.mode === 'think') return 'thinking';
    if (f?.mode === 'talk' || f?.speaking) return 'speaking';
    // The page already knows how long the pointer has been still (env.sleepy): dozing is that, not a timer here.
    if (f?.sleeping || f?.sleepy > 0.5) return 'sleeping';
    return 'idle';
  }

  /** The stronger of two states (a momentary one only while it holds). */
  const strongest = (a, b) => (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;

  R.orbState = { STATES, RANK, HOLD, reduce, fromFrame, strongest, isState };
})();
