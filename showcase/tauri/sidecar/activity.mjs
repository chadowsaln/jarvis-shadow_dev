// What the Roamie is doing and has done, in plain words, for the panel: "Reading notes.md" while a tool runs,
// then "Read notes.md" in the recent list. Only names a file, app or site,
// never a path, a command or what was typed.
// Either slash, whatever the OS: a Windows path must never show in full on a Mac, or the other way round.
const base = (p) => String(p ?? '').split(/[\\/]+/).filter(Boolean).at(-1) || 'a folder';
const host = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };
const short = (s, n = 28) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const appOf = (t) => { t = String(t ?? '').trim(); return !t || t === 'screen' || t === 'front' || t.startsWith('window:') ? '' : short(t, 20); };

// [while it runs, once it's done] for a tool call; null for the ones that aren't worth a line.
export function describe(name, args = {}) {
  switch (name) {
    case 'take_screenshot': { const a = appOf(args.target); return a ? [`Looking at ${a}`, `Looked at ${a}`] : ['Looking at your screen', 'Looked at your screen']; }
    case 'list_windows': return ['Checking your windows', 'Checked your windows'];
    case 'read_window': { const a = appOf(args.target); return a ? [`Reading ${a}`, `Read ${a}`] : ['Reading a window', 'Read a window']; }
    case 'act_in_app': { const a = appOf(args.target); return a ? [`Working in ${a}`, `Worked in ${a}`] : ['Working in an app', 'Worked in an app']; }
    case 'draw': return (args.beats ?? []).length ? ['Drawing on your screen', 'Drew on your screen'] : ['Changing the drawing', 'Changed the drawing'];
    case 'see_photo': return args.url ? [`Looking at a picture on ${host(args.url)}`, `Looked at a picture on ${host(args.url)}`] : ['Looking at a picture', 'Looked at a picture'];
    case 'read_file': return [`Reading ${short(base(args.path))}`, `Read ${short(base(args.path))}`];
    case 'list_files': return [`Looking in ${short(base(args.dir))}`, `Looked in ${short(base(args.dir))}`];
    case 'search_files': return ['Searching your files', 'Searched your files'];
    case 'file_info': return [`Checking ${short(base(args.path))}`, `Checked ${short(base(args.path))}`];
    case 'find_files': return [`Searching for files in ${short(base(args.dir))}`, `Searched for files in ${short(base(args.dir))}`];
    case 'create_directory': return [`Creating folder ${short(base(args.path))}`, `Created folder ${short(base(args.path))}`];
    case 'copy_file': return [`Copying ${short(base(args.from))}`, `Copied ${short(base(args.from))}`];
    case 'move_file': return [`Moving ${short(base(args.from))}`, `Moved ${short(base(args.from))}`];
    case 'rename_file': return [`Renaming ${short(base(args.path))}`, `Renamed ${short(base(args.path))}`];
    case 'write_file': return [`Saving ${short(base(args.path))}`, `Saved ${short(base(args.path))}`];
    case 'run_command': return ['Running a command', 'Ran a command'];
    // The terminal only ever runs safety.mjs's fixed list, so its name and flags are safe to show (never a path).
    case 'run_diagnostic': { const c = short([args.command, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' '), 24); return [`Checking ${c}`, `Checked ${c}`]; }
    // Apps: installed, searched, running, and started by the name the menus show.
    case 'list_apps': return ['Looking at the installed apps', 'Looked at the installed apps'];
    case 'find_app': return [`Looking for the app ${short(args.name, 18)}`, `Looked for the app ${short(args.name, 18)}`];
    case 'running_apps': return ['Checking what apps are open', 'Checked what apps are open'];
    case 'launch_app': return [`Opening ${short(args.app, 18)}`, `Opened ${short(args.app, 18)}`];
    case 'web_fetch': return [`Reading ${host(args.url)}`, `Read ${host(args.url)}`];
    case 'web_search': return args.query ? [`Searching the web: ${short(args.query, 24)}`, `Searched the web`] : ['Searching the web', 'Searched the web'];
    case 'browser_discover': return ['Checking browsers', 'Checked browsers'];
    case 'browser_open': return [`Opening ${host(args.url)}`, `Opened ${host(args.url)}`];
    case 'browser_read_page': return [`Reading ${host(args.url)}`, `Read ${host(args.url)}`];
    case 'browser_respan_bridge_status': return ['Checking Respan browser bridge', 'Checked browser bridge'];
    case 'browser_read_respan_authenticated': return [`Reading Respan (${host(args?.url) || 'page'})`, `Read Respan`];
    case 'browser_navigate': {
      const a = short(args.action || 'navigate', 12);
      return args.url ? [`Navigating: ${a} ${host(args.url)}`, `Navigated: ${a}`] : [`Navigating: ${a}`, `Navigated: ${a}`];
    }
    case 'exa_search_status': return ['Checking Exa search', 'Checked Exa search'];
    case 'exa_search': return args.query ? [`Searching Exa: ${short(args.query, 24)}`, 'Searched Exa'] : ['Searching with Exa', 'Searched with Exa'];
    case 'exa_get_contents': return ['Reading pages with Exa', 'Read pages with Exa'];
    case 'exa_find_similar': return [`Finding similar pages${args.url ? ` to ${host(args.url)}` : ''}`, 'Found similar pages'];
    case 'browser_open_url': return [`Opening ${host(args.url || args.target)}`, `Opened ${host(args.url || args.target)}`];
    case 'browser_search_web': return ['Searching the web', 'Searched the web'];
    case 'remember_commitment': return ['Adding a reminder', 'Added a reminder'];
    case 'update_commitment': return ['Updating a reminder', 'Updated a reminder'];
    case 'forget_fact': return ['Forgetting it', 'Forgot it'];
    case 'memory_save': return ['Saving to memory', 'Saved to memory'];
    case 'memory_search': return ['Searching memory', 'Searched memory'];
    case 'memory_list': return ['Checking memory', 'Checked memory'];
    case 'memory_update': return ['Updating memory', 'Updated memory'];
    case 'memory_delete': return ['Deleting memory', 'Deleted memory'];
    case 'open': {
      const t = String(args.target ?? '');
      const what = /^https?:\/\//i.test(t) ? host(t) : short(base(t));
      return [`Opening ${what}`, `Opened ${what}`];
    }
    default: return null;
  }
}

// The recent list: newest first, at most `max` lines. A failed tool says so.
export function createActivity({ max = 12, now = () => Date.now() } = {}) {
  const recent = [];
  const running = new Map();
  const add = (kind, text) => { recent.unshift({ at: now(), kind, text }); recent.length = Math.min(recent.length, max); };
  return {
    recent,
    asked(text) { add('ask', short(text, 80)); },
    // A drawing handed part of the work on: said in the list like anything else it did.
    handoff(task) { add('did', `Handed off: ${short(task, 60)}`); },
    // Every tool is tracked, even ones with no line, so stopped() can say which never finished.
    start(id, name, args) { const d = describe(name, args); running.set(id, d); return d?.[0] ?? null; },
    end(id, isError) { const d = running.get(id); running.delete(id); if (d) add(isError ? 'bad' : 'did', isError ? `Couldn't finish: ${d[1].charAt(0).toLowerCase()}${d[1].slice(1)}` : d[1]); },
    // What it's doing right now (the newest tool still running), or null.
    doing() { return [...running.values()].filter(Boolean).at(-1)?.[0] ?? null; },
    // The request ended: the ids of tools that never reported back (it was cancelled mid-call).
    stopped() { const left = [...running.keys()]; running.clear(); return left; },
  };
}
