// The safety hook the live app hands the agent core: every call the router authorizes is also checked by the same
// rules the tools use themselves (safety.mjs), at both the initial route and the recheck just before execution.
// It can only refuse; returning null leaves the call to the tool's own checks. Kept here, apart from sidekick.mjs,
// so the wiring is tested (test/terminal.test.mjs).
import process from 'node:process';
import { SAFE, checkAppTarget, checkDiagnosticCommand, checkOpen, checkRead, checkUrl, checkWrite } from '../safety.mjs';

export function agentCorePreflight({ toolName, args }) {
  const deny = (v) => (v && v.level && v.level !== SAFE ? { ok: false, reason: `blocked by safety: ${v.reason || v.level}` } : null);
  if (toolName === 'read_file' && typeof args?.path === 'string') return deny(checkRead(args.path));
  if (toolName === 'write_file' && typeof args?.path === 'string') return deny(checkWrite(args.path));
  // The terminal's whole surface: safety.mjs's allowlist of read-only commands and their flags, nothing else.
  if (toolName === 'run_diagnostic') return deny(checkDiagnosticCommand(args?.command, args?.args));
  // An app starts only by its installed name: never a path, a file, a shell string or a system tool.
  if (toolName === 'launch_app') return deny(checkAppTarget(args?.app));
  if (toolName === 'open') {
    if (typeof args?.target === 'string') return deny(checkOpen(args.target));
    if (typeof args?.app === 'string') return deny(checkOpen(args.app));
  }
  // Browser tools (observe): URLs must pass the same fetch/open safety checks (no private/blocked targets).
  // Use synchronous URL checks at preflight (scheme/host/private ranges). web_fetch also re-checks resolved
  // addresses per request/redirect hop at execution time.
  if ((toolName === 'browser_open' || toolName === 'browser_read_page') && typeof args?.url === 'string') return deny(checkUrl(args.url));
  if (toolName === 'browser_navigate' && typeof args?.url === 'string') return deny(checkUrl(args.url));
  // Authenticated Respan bridge reads are Respan-only and must not target other origins (even if otherwise safe).
  if (toolName === 'browser_read_respan_authenticated' && typeof args?.url === 'string') {
    const d = deny(checkUrl(args.url));
    if (d) return d;
    try {
      const u = new URL(String(args.url));
      if (!(u.protocol === 'https:' && u.hostname.toLowerCase() === 'platform.respan.ai')) {
        return { ok: false, reason: 'Authenticated browser reading is only supported for https://platform.respan.ai/ URLs.' };
      }
    } catch { return { ok: false, reason: 'Invalid URL for authenticated Respan reading.' }; }
    return null;
  }
  // Web tools (observe): enforce fetch safety at the router boundary too.
  if (toolName === 'web_fetch' && typeof args?.url === 'string') return deny(checkUrl(args.url));
  // Screen intelligence: capture only via the desktop's XDG portal (user consent each time), Linux only.
  if (toolName === 'screen_capture' || toolName === 'screen_ocr') {
    if (process.platform !== 'linux') {
      return { ok: false, reason: 'Screen capture is available on Linux only (via the XDG Desktop Portal).' };
    }
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) {
      return { ok: false, reason: 'No desktop session bus found, so the screenshot portal cannot be used.' };
    }
  }
  return null;
}
