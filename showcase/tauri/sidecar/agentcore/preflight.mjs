// The safety hook the live app hands the agent core: every call the router authorizes is also checked by the same
// rules the tools use themselves (safety.mjs), at both the initial route and the recheck just before execution.
// It can only refuse; returning null leaves the call to the tool's own checks. Kept here, apart from sidekick.mjs,
// so the wiring is tested (test/terminal.test.mjs).
import process from 'node:process';
import {
  SAFE,
  BLOCK,
  checkAppTarget,
  checkDiagnosticCommand,
  checkFileCreate,
  checkFileDelete,
  checkFileDest,
  checkFileRead,
  checkFileSource,
  checkLinuxInputTarget,
  checkOpen,
  checkRead,
  checkUrl,
  checkWrite,
  classifyCommand,
} from '../safety.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '/';

export function agentCorePreflight({ toolName, args }) {
  const deny = (v) => (v && v.level && v.level !== SAFE ? { ok: false, reason: `blocked by safety: ${v.reason || v.level}` } : null);

  // File management tools (Batch 4 & base file tools): must stay in user area and avoid secrets/protected paths
  if (toolName === 'read_file' && typeof args?.path === 'string') return deny(checkFileRead(args.path, HOME));
  if (toolName === 'delete_file' && typeof args?.path === 'string') return deny(checkFileDelete(args.path, HOME));
  if (toolName === 'write_file' && typeof args?.path === 'string') {
    const dest = deny(checkFileDest(args.path, HOME, { allowReplace: true }));
    if (dest) return dest;
    return deny(checkWrite(args.path, HOME));
  }
  if ((toolName === 'list_files' || toolName === 'search_files' || toolName === 'find_files') && typeof (args?.dir || args?.path) === 'string') {
    return deny(checkFileRead(args.dir || args.path, HOME));
  }
  if (toolName === 'file_info' && typeof args?.path === 'string') {
    return deny(checkFileRead(args.path, HOME));
  }
  if (toolName === 'create_directory' && typeof (args?.path || args?.dir) === 'string') {
    return deny(checkFileCreate(args.path || args.dir, HOME));
  }
  if (toolName === 'copy_file') {
    if (typeof (args?.source || args?.from) === 'string') {
      const src = deny(checkFileSource(args.source || args.from, HOME));
      if (src) return src;
    }
    if (typeof (args?.dest || args?.to) === 'string') {
      return deny(checkFileDest(args.dest || args.to, HOME, { allowReplace: true }));
    }
  }
  if (toolName === 'move_file' || toolName === 'rename_file') {
    if (typeof (args?.source || args?.from) === 'string') {
      const src = deny(checkFileSource(args.source || args.from, HOME, { forWrite: true }));
      if (src) return src;
    }
    if (typeof (args?.dest || args?.to) === 'string') {
      return deny(checkFileDest(args.dest || args.to, HOME, { allowReplace: true }));
    }
  }

  // Shell command preflight: blocked commands (fork bombs, sudo, rm -rf /, etc.) fail preflight immediately
  if (toolName === 'run_command' && typeof args?.command === 'string') {
    const v = classifyCommand(args.command, HOME);
    if (v.level === BLOCK) return { ok: false, reason: `blocked by safety: ${v.reason || 'command blocked'}` };
  }

  // App quit tool on Linux: check hands-off target
  if (toolName === 'app_quit' && process.platform === 'linux' && typeof args?.name === 'string') {
    return deny(checkLinuxInputTarget(args.name));
  }

  // The terminal's whole surface: safety.mjs's allowlist of read-only commands and their flags, nothing else.
  if (toolName === 'run_diagnostic') return deny(checkDiagnosticCommand(args?.command, args?.args));
  // An app starts only by its installed name: never a path, a file, a shell string or a system tool.
  if (toolName === 'launch_app') return deny(checkAppTarget(args?.app));
  if (toolName === 'open') {
    if (typeof args?.target === 'string') return deny(checkOpen(args.target, HOME));
    if (typeof args?.app === 'string') return deny(checkOpen(args.app, HOME));
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
