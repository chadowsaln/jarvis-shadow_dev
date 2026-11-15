# JARVIS V2 — Technical Specification

**Status**: Design Phase — Implementation in progress (WIP, partial)  
**Version**: 0.1.0-draft  
**Base**: Little Boy v0.0.4 (commit 82c472b)  
**Date**: 2026-11-15

## Implementation status (as of 2026-11-15)

- **Rebranding/config (partial):** Tauri app identity updated to `JARVIS V2` / `0.1.0` / `ai.jarvis.v2` (`tauri.conf.json`, `Cargo.toml` `jarvis_v2`, sidecar `jarvis-v2-sidekick`, tray/autostart naming adjusted in places). Legacy `Roamies`/`Little Boy`/`ROAMIES_*` names remain across many UI strings, paths, env vars, and docs.
- **V2.1 Linux Computer Control (partial/WIP):** scaffolding exists in `showcase/tauri/sidecar/computer-control/` and Linux tools were added in `showcase/tauri/sidecar/tools.mjs` (`linux_*`), but end-to-end integration and acceptance criteria (AT-SPI2 runtime, input simulation setup, Portal/OCR flow, verification integration, permissions/approval behavior in live sessions) are **not fully verified**.
- **V2.2–V2.6:** not implemented.
- **Packaging/build:** Linux `.deb`/`.rpm` builds succeeded in this environment (with AppImage packaging failing via `linuxdeploy` in attempts); bundled Node runtime was removed from app external bins to avoid `/usr/bin/node` conflicts (system Node.js >=22 required). Updater artifact signing requires `TAURI_SIGNING_PRIVATE_KEY`. This document remains the target architecture/spec; sections below should be read against the actual implementation state.

---

## 1. Executive Summary

JARVIS V2 evolves the existing Little Boy architecture into an **API-powered autonomous computer-use assistant** whose identity is:

> **AI Agent + Computer Control + Perception + Memory + Skills + Security**

The existing **Agent Core** (`sidecar/agentcore/`) is the foundation. This specification evolves it rather than replacing it. No second agent runtime, no multi-agent orchestration, no local LLMs, no Docker, no mandatory external databases.

**Success Criterion**: JARVIS executes a command like:
> "افتح المتصفح، ابحث عن أفضل مكتبات Python لمعالجة الصور، قارن بينها، أنشئ ملفاً يحتوي على النتائج، واحفظه في مجلد Documents."

And verifies the file exists with correct content.

---

## 2. Current State — Verified Existing Functionality

### 2.1 Agent Core (Batch 1 + 2) — `sidecar/agentcore/`

| Module | Status | Key Capabilities |
|--------|--------|------------------|
| `index.mjs` | ✅ Production | Factory, feature flag (`ROAMIES_AGENT_CORE`), component wiring |
| `intent.mjs` | ✅ Production | Heuristic + pluggable LLM classification (kind, category, risk, confidence) |
| `planner.mjs` | ✅ Production | Plan/step state machine, dependencies, refresh, validation |
| `router.mjs` | ✅ Production | Deny-by-default, metadata-required, permission levels, safety preflight, arg validation |
| `executor.mjs` | ✅ Production | Approval binding, dual safety gate (initial + pre_execute), fingerprint verification, single-use consumption |
| `permissions.mjs` | ✅ Production | 5-level model, fingerprint (SHA-256), approval store (TTL, revocation, expiry) |
| `approval-channel.mjs` | ✅ Production | Panel transport, sanitized args, risk presentation, canonical dedup, expiry, resend |
| `context.mjs` | ✅ Production | Token estimation, budgeting, relevance selection, provider adaptation |
| `runtime.mjs` | ✅ Production | Tool wrapping (`Symbol('rawTool')`), level from env, ask-list, strict metadata |
| `preflight.mjs` | ✅ Production | Safety hook: read/write/terminal/browser/screen checks, Linux-only screen |

### 2.2 Tool Layer — `sidecar/tools.mjs`

| Tool Category | Tools | Permission Level | Platform |
|---------------|-------|------------------|----------|
| Files | `read_file`, `write_file`, `list_files`, `glob_files` | observe / trusted | All |
| Terminal | `run_diagnostic` (allowlisted cmds) | assist | All |
| Apps | `launch_app` | trusted | All |
| Browser | `browser_open`, `browser_read_page`, `browser_navigate`, `browser_read_respan_authenticated` | observe | All |
| Web | `web_fetch` | observe | All |
| Screen | `screen_capture`, `screen_ocr` | observe | Linux only |
| Hands | `hands_act`, `hands_locate`, `hands_windows` | sensitive | macOS/Win |
| Memory | `memory_save`, `memory_list`, `memory_update`, `memory_delete` | trusted | All |

### 2.3 Native Helpers

| Helper | Platform | Protocol | Capabilities |
|--------|----------|----------|--------------|
| `voice-win` | Linux/Win | CLI JSON | Parakeet STT (`--transcribe`, `--test-audio`) |
| `hands-win` | Win | CLI JSON | UIA, Win32, OCR — `act`, `locate`, `windows`, `select` |
| `hands/main.swift` | macOS | CLI JSON | Accessibility, UI Automation, OCR — same commands |

### 2.4 Platform Abstraction — `sidecar/platform.mjs`

- `hasHands`, `hasVoice`, `hasHotkeys`, `seesPointer`, `linuxSession`, `canCircle`, `canSnap`
- Wayland detection → `POINTER_OK=false`, `HOTKEYS_OK=false`

### 2.5 Memory — `sidecar/store.mjs`

- Sessions, folds, facts, commitments, reminders
- `fitContext`, `selectRelevantContext`, `forProvider`
- File-based JSON (`~/.gg/sidekick.json`, sessions in `~/.gg/sessions/`)

### 2.6 Safety — `sidecar/safety.mjs`

- Path allowlist (`checkRead`, `checkWrite`)
- URL validation (`checkUrl`, `checkOpen`)
- Command allowlist (`checkDiagnosticCommand`)
- App target validation (`checkAppTarget`)
- Levels: `SAFE`, `ASK`, `BLOCK`

---

## 3. Architectural Decisions (ADRs)

### ADR-001: Preserve Agent Core as Single Execution Pipeline

**Decision**: The Agent Core (Intent → Plan → Route → Approve → Execute) remains the **only** execution path. No legacy bypass, no second runtime.

**Alternatives Considered**:
- Dual path (legacy + core) — Rejected: increases surface, duplicates logic
- Multi-agent — Rejected: premature, single agent with strong tools is sufficient

**Consequences**:
- `ROAMIES_AGENT_CORE=1` becomes default in V2.1
- All tools must declare permission metadata
- `guardTools()` wrapping is mandatory

### ADR-002: No Local Vision Models

**Decision**: Vision-language grounding uses **remote APIs** (OpenRouter: GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro). No local LLaVA/Phi-3-Vision.

**Rationale**: Fedora Workstation i7-7500U, limited RAM. User explicitly rejects local models.

**Consequences**:
- Screenshot → Base64 → OpenRouter → Structured action plan
- Latency budget: <3s per perception round-trip
- Cost tracking per skill execution

### ADR-003: SQLite as Primary Storage

**Decision**: SQLite (via `better-sqlite3` or `sql.js`) for structured memory, FTS5 for full-text, optional `sqlite-vec` for vectors. No mandatory external DB.

**Rationale**: Zero-config, embedded, portable, supports FTS and vectors via extensions.

### ADR-004: Playwright for Browser Intelligence

**Decision**: Playwright (Chromium) as the browser engine. Managed by sidecar, headless by default, headed optional for authenticated sessions.

**Rationale**: Best-in-class automation, CDP access, cross-platform, supports existing auth via user data dir.

### ADR-005: AT-SPI2 + D-Bus for Linux Computer Control

**Decision**: Unified Linux adapter using AT-SPI2 (accessibility), D-Bus (desktop integration), XDG Desktop Portal (screen capture), `ydotool`/`uinput` (input simulation).

**Rationale**: Wayland-native, no X11 dependency, standard Linux accessibility stack.

### ADR-006: Skill Registry (Internal, Not Marketplace)

**Decision**: Internal `SkillRegistry` with JSON manifests. No external marketplace, no signing infrastructure yet.

**Rationale**: Build the abstraction first. Marketplace is V2.6+.

---

## 4. Module Boundaries — Revised Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           JARVIS V2 ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────────────────────┐  │
│  │  Tauri Shell │◄──►│                    SIDECAR                        │  │
│  │  (Rust)      │    │  ┌────────────────────────────────────────────┐  │  │
│  │  - Windows   │    │  │           JARVIS BRAIN                      │  │  │
│  │  - Tray      │    │  │  ┌──────────────────────────────────────┐  │  │  │
│  │  - Updater   │    │  │  │         AGENT CORE (preserved)        │  │  │  │
│  │  - Native    │    │  │  │  Intent │ Planner │ Router │Executor │  │  │  │
│  │    Helpers   │    │  │  │  Permissions │ Approval │ Context    │  │  │  │
│  └──────────────┘    │  │  └──────────────────────────────────────┘  │  │  │
│         ▲            │  │                    ▲                       │  │  │
│         │ stdio      │  │                    │                       │  │  │
│         │ JSON lines │  │  ┌─────────────────┼─────────────────────┐  │  │  │
│         ▼            │  │  │                  ▼                     │  │  │  │
│  ┌──────────────┐    │  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐  │  │  │
│  │   Overlay    │    │  │  │  │ Computer│ │ Browser │ │Perception│  │  │  │
│  │  (Web/Canvas)│    │  │  │  │ Control │ │(Playwright)         │  │  │
│  └──────────────┘    │  │  │  │(AT-SPI2)│ │         │ │(Screenshot│  │  │  │
│                      │  │  │  └─────────┘ └─────────┘ │  /OCR)   │  │  │  │
│                      │  │  │       ▲        ▲        └─────────┘  │  │  │  │
│                      │  │  │       │        │                  │  │  │  │
│                      │  │  │  ┌────┴────┐ ┌──┴─────┐ ┌────────┴┐  │  │  │
│                      │  │  │  │ Memory  │ │ Skills │ │ Security  │  │  │  │
│                      │  │  │  │(SQLite) │ │Registry│ │Boundaries │  │  │  │
│                      │  │  │  └─────────┘ └────────┘ └──────────┘  │  │  │
│                      │  │  └──────────────────────────────────────┘  │  │  │
│                      │  └────────────────────────────────────────────┘  │  │
│                      └──────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 New Modules (V2.1–V2.4)

| Module | Path | Responsibility |
|--------|------|----------------|
| `computer-control` | `sidecar/computer-control/` | Linux AT-SPI2 adapter, input simulation, app introspection |
| `browser-intelligence` | `sidecar/browser-intelligence/` | Playwright lifecycle, DOM/AX inspection, auth sessions |
| `perception` | `sidecar/perception/` | Screenshot capture, OCR, remote VL analysis |
| `verification` | `sidecar/verification/` | Execute→Observe→Verify→Recover loop, audit log |
| `skills` | `sidecar/skills/` | SkillRegistry, manifest schema, recording, replay |
| `memory/sqlite` | `sidecar/memory/sqlite/` | Structured memory, FTS5, optional vectors, consolidation |

### 4.2 Preserved Modules (No Breaking Changes)

| Module | Path | V2 Changes |
|--------|------|------------|
| Agent Core | `sidecar/agentcore/` | Default enabled, metadata mandatory |
| Tools | `sidecar/tools.mjs` | Refactored to use new adapters |
| Safety | `sidecar/safety.mjs` | Extended for browser/desktop boundaries |
| Memory (file) | `sidecar/store.mjs` | Deprecated → SQLite migration |
| Platform | `sidecar/platform.mjs` | Extended with `hasComputerControl` |

---

## 5. Detailed Technical Designs

### 5.1 A. Linux Computer Control — `sidecar/computer-control/`

#### 5.1.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    LINUX COMPUTER CONTROL                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ AT-SPI2     │    │ D-Bus       │    │ XDG Desktop Portal  │  │
│  │ Adapter     │    │ Integration │    │ (Screenshot)        │  │
│  │             │    │             │    │                     │  │
│  │ - Tree walk │    │ - App list  │    │ - User consent      │  │
│  │ - Role/state│    │ - Window mgmt│   │ - Wayland native    │  │
│  │ - Actions   │    │ - Notifications│  │ - PipeWire          │  │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘  │
│         │                  │                       │             │
│         └──────────────────┼───────────────────────┘             │
│                            ▼                                     │
│                   ┌─────────────────┐                            │
│                   │ ComputerControl │                            │
│                   │ Service         │                            │
│                   │                 │                            │
│                   │ - getTree()     │                            │
│                   │ - findElement() │                            │
│                   │ - doAction()    │                            │
│                   │ - getWindows()  │                            │
│                   └────────┬────────┘                            │
│                            │                                     │
│              ┌─────────────┼─────────────┐                       │
│              ▼             ▼             ▼                       │
│       ┌────────────┐ ┌────────────┐ ┌────────────┐               │
│       │ Input Sim  │ │ OCR        │ │ Verification│              │
│       │ (ydotool)  │ │ (Tesseract)│ │ (Visual)    │              │
│       └────────────┘ └────────────┘ └────────────┘               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.1.2 AT-SPI2 Adapter (`atspi-adapter.ts`)

```typescript
interface AccessibleNode {
  path: string;           // Object path on D-Bus
  role: string;           // ROLE_BUTTON, ROLE_TEXT, etc.
  name: string;           // Accessible name
  description: string;    // Description
  states: string[];       // STATE_VISIBLE, STATE_ENABLED, etc.
  attributes: Record<string, string>;
  children: AccessibleNode[];
  coordinates: { x: number; y: number; width: number; height: number } | null;
  actions: string[];      // "click", "focus", "select", etc.
}

interface ATSPIDriver {
  // Tree operations
  getDesktopTree(): Promise<AccessibleNode>;
  getTreeForApp(appName: string): Promise<AccessibleNode>;
  findElement(criteria: ElementCriteria): Promise<AccessibleNode | null>;
  findElements(criteria: ElementCriteria): Promise<AccessibleNode[]>;

  // Actions
  doAction(nodePath: string, action: string, args?: any): Promise<void>;
  setFocus(nodePath: string): Promise<void>;

  // Introspection
  getApplicationList(): Promise<ApplicationInfo[]>;
  getWindowList(): Promise<WindowInfo[]>;
}

interface ElementCriteria {
  role?: string;
  name?: string;           // Exact or regex
  description?: string;
  states?: string[];
  attributes?: Record<string, string>;
  ancestor?: ElementCriteria;
  index?: number;          // nth match
}
```

**D-Bus Integration** (`dbus-integration.ts`):
- `org.a11y.Bus` — Registry of accessible applications
- `org.a11y.atspi.Accessible` — Core interface
- `org.a11y.atspi.Action` — Perform actions
- `org.a11y.atspi.Component` — Coordinates, extents
- `org.a11y.atspi.Text` — Text content, caret, selection
- `org.freedesktop.portal.Desktop` — Screencast, screenshot

#### 5.1.3 Input Simulation (`input-simulation.ts`)

```typescript
interface InputSimulator {
  // Mouse
  move(x: number, y: number, durationMs?: number): Promise<void>;
  click(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number, durationMs?: number): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;

  // Keyboard
  type(text: string, delayMs?: number): Promise<void>;
  press(key: string): Promise<void>;        // "Enter", "Tab", "Escape", "Control+a"
  hotkey(modifiers: string[], key: string): Promise<void>;  // ["Control", "Alt"], "t"

  // Verification
  waitForIdle(timeoutMs?: number): Promise<void>;
}

// Implementation: ydotool (requires uinput, works on Wayland)
// Fallback: xdotool (X11 only), xte (X11 only)
```

**Permission Model**:
- `ydotool` requires `uinput` kernel module and user in `input` group
- Alternative: `libei` (Emulated Input) — Wayland protocol, no root, compositors: GNOME (mutter), KDE (kwin), wlroots
- **Decision**: `libei` preferred where available; `ydotool` fallback. Document setup in README.

#### 5.1.4 Wayland Restrictions & Mitigations

| Capability | Wayland Status | Mitigation |
|------------|----------------|------------|
| Global hotkeys | ❌ Blocked | GNOME Settings → Keyboard Shortcuts → `littleboy --summon\|--talk\|--ask\|--list\|--panel` |
| Pointer tracking over other apps | ❌ Blocked | AT-SPI2 tree walk (app must support accessibility) |
| Window management (move/resize/minimize) | ⚠️ Limited | XDG Foreign Toplevel (partial), D-Bus `org.gnome.Shell` |
| Screen capture | ✅ Via Portal | XDG Desktop Portal `org.freedesktop.portal.ScreenCast` |
| Input simulation | ✅ Via libei/ydotool | Requires compositor support / uinput |
| OCR | ✅ | Tesseract on captured screenshot |

---

### 5.2 B. Browser Intelligence — `sidecar/browser-intelligence/`

#### 5.2.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER INTELLIGENCE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Playwright Manager                       │   │
│  │  - Browser lifecycle (launch/close/contexts/pages)       │   │
│  │  - User data dir for authenticated sessions              │   │
│  │  - CDP session for advanced inspection                   │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│         ┌─────────────────┼─────────────────┐                  │
│         ▼                 ▼                 ▼                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │ Navigation  │  │ Inspection  │  │ Interaction │            │
│  │ - goto      │  │ - DOM query │  │ - click     │            │
│  │ - wait      │  │ - AX tree   │  │ - type      │            │
│  │ - history   │  │ - screenshots│ │ - select    │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│         │                 │                 │                  │
│         └─────────────────┼─────────────────┘                  │
│                           ▼                                     │
│                  ┌─────────────────┐                            │
│                  │ Form Handling   │                            │
│                  │ - fill          │                            │
│                  │ - submit        │                            │
│                  │ - validate      │                            │
│                  └─────────────────┘                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 5.2.2 Playwright Adapter (`playwright-adapter.ts`)

```typescript
interface BrowserSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  pages: Map<string, Page>;
  userDataDir: string;           // Persistent profile for auth
  authenticatedOrigins: string[]; // Origins where cookies exist
}

interface BrowserIntelligence {
  // Lifecycle
  launch(options?: LaunchOptions): Promise<BrowserSession>;
  close(sessionId: string): Promise<void>;
  getSession(sessionId: string): BrowserSession | null;

  // Navigation
  navigate(sessionId: string, url: string, options?: NavigateOptions): Promise<NavigationResult>;
  goBack(sessionId: string): Promise<void>;
  goForward(sessionId: string): Promise<void>;
  reload(sessionId: string): Promise<void>;

  // Inspection (DOM + Accessibility)
  getDOMSnapshot(sessionId: string, selector?: string): Promise<DOMSnapshot>;
  getAccessibilityTree(sessionId: string, rootSelector?: string): Promise<AXNode[]>;
  findElements(sessionId: string, criteria: ElementCriteria): Promise<ElementHandle[]>;
  getElementBounds(sessionId: string, selector: string): Promise<Bounds | null>;

  // Interaction
  click(sessionId: string, selector: string, options?: ClickOptions): Promise<void>;
  type(sessionId: string, selector: string, text: string, options?: TypeOptions): Promise<void>;
  selectOption(sessionId: string, selector: string, values: string[]): Promise<void>;
  hover(sessionId: string, selector: string): Promise<void>;
  scroll(sessionId: string, selector: string, deltaX: number, deltaY: number): Promise<void>;

  // Forms
  fillForm(sessionId: string, formSelector: string, data: Record<string, string>): Promise<void>;
  submitForm(sessionId: string, formSelector: string): Promise<void>;
  getFormData(sessionId: string, formSelector: string): Promise<Record<string, string>>;

  // Screenshots
  screenshot(sessionId: string, options?: ScreenshotOptions): Promise<Buffer>;
  screenshotElement(sessionId: string, selector: string): Promise<Buffer>;

  // Verification
  waitForSelector(sessionId: string, selector: string, options?: WaitOptions): Promise<ElementHandle>;
  waitForNavigation(sessionId: string, options?: WaitOptions): Promise<void>;
  assertText(sessionId: string, selector: string, expected: string): Promise<void>;
  assertVisible(sessionId: string, selector: string): Promise<void>;
}

interface ElementCriteria {
  selector?: string;           // CSS selector
  text?: string;               // Visible text (exact or regex)
  role?: string;               // ARIA role
  label?: string;              // Accessible label
  testId?: string;             // data-testid
  index?: number;
}
```

#### 5.2.3 Authenticated Sessions

- **User Data Dir**: `~/.local/share/littleboy/browser-profiles/<profile>/`
- **Profile Isolation**: Per-task or persistent "default" profile
- **Cookie/Storage Persistence**: Automatic via Playwright context
- **Security**: `checkUrl` preflight applies; no file://, no private IPs, no localhost unless explicitly allowed

#### 5.2.4 Browser Use Evaluation

**Decision**: **Optional planning layer**, not mandatory second runtime.

- If task is "browse and extract" → direct Playwright
- If task is "complex multi-step web research" → Browser Use as planner, Playwright as executor
- **Integration**: `browserUsePlan()` tool that returns step sequence for `browser-*` tools

---

### 5.3 C. Verification and Recovery Loop — `sidecar/verification/`

#### 5.3.1 Standard Execution Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    EXECUTE → OBSERVE → VERIFY → RECOVER                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PLAN                                                                       │
│    │                                                                        │
│    ▼                                                                        │
│  PREFLIGHT  ──(deny)──► FAIL (audit)                                        │
│    │                                                                        │
│    ▼ (allow)                                                                │
│  APPROVE? ──(yes/wait)──► [User Decision] ──(deny)──► FAIL (audit)         │
│    │ (no)                                                                   │
│    ▼                                                                        │
│  EXECUTE                                                                    │
│    │                                                                        │
│    ▼                                                                        │
│  OBSERVE  ──(capture state)──► Screenshot / DOM / AX Tree / Output          │
│    │                                                                        │
│    ▼                                                                        │
│  VERIFY  ──(success)──► COMPLETE (audit)                                    │
│    │                                                                        │
│    └─(failure)──► RECOVER                                                   │
│                     │                                                       │
│                     ├─► RETRY (max N, exponential backoff)                  │
│                     ├─► ALTERNATE_STRATEGY (different tool/approach)        │
│                     ├─► ESCALATE (ask user)                                 │
│                     └─► ABORT (mark failed, audit)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 5.3.2 Verification Service (`verification-service.ts`)

```typescript
interface VerificationCondition {
  type: 'file_exists' | 'file_contains' | 'element_visible' | 'text_present' 
       | 'url_matches' | 'command_succeeds' | 'custom';
  target: string;              // Path, selector, URL, command
  expected?: string | RegExp;  // For content checks
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
}

interface VerificationResult {
  success: boolean;
  condition: VerificationCondition;
  actualValue?: any;
  error?: string;
  attempts: number;
  durationMs: number;
  evidence: VerificationEvidence[];
}

interface VerificationEvidence {
  type: 'screenshot' | 'dom' | 'ax_tree' | 'file_content' | 'command_output';
  data: any;
  timestamp: number;
}

interface RecoveryStrategy {
  type: 'retry' | 'alternate_tool' | 'alternate_approach' | 'escalate' | 'abort';
  maxRetries?: number;
  backoffMs?: number;
  alternateTool?: string;
  alternateApproach?: string;  // Natural language description for planner
  escalationMessage?: string;
}

interface VerificationService {
  // Execute with built-in verification
  executeWithVerification(
    toolName: string,
    args: any,
    conditions: VerificationCondition[],
    recovery: RecoveryStrategy
  ): Promise<ExecutionResult>;

  // Standalone verification
  verify(conditions: VerificationCondition[]): Promise<VerificationResult[]>;

  // Recovery
  recover(
    failedExecution: ExecutionResult,
    strategy: RecoveryStrategy,
    context: ExecutionContext
  ): Promise<ExecutionResult>;
}

interface ExecutionResult {
  status: 'completed' | 'failed' | 'recovered' | 'aborted';
  toolName: string;
  args: any;
  result?: any;
  error?: string;
  verifications: VerificationResult[];
  recoveryAttempts: number;
  auditLog: AuditEntry[];
}

interface AuditEntry {
  timestamp: number;
  phase: 'preflight' | 'approval' | 'execute' | 'observe' | 'verify' | 'recover';
  action: string;
  details: any;
  outcome: 'success' | 'failure' | 'skipped';
}
```

#### 5.3.3 Success Conditions & Failure Detection

| Condition Type | Detection Method | Example |
|----------------|------------------|---------|
| `file_exists` | `fs.stat()` | Download completed |
| `file_contains` | Read + regex/string match | Config written correctly |
| `element_visible` | Playwright `isVisible()` | Button appeared |
| `text_present` | DOM/AX text search | Confirmation message |
| `url_matches` | `page.url()` | Navigation succeeded |
| `command_succeeds` | Exit code 0 | Build passed |
| `custom` | User-provided async function | Complex business logic |

#### 5.3.4 Retry Policies

```typescript
const DEFAULT_RETRY_POLICY: RecoveryStrategy = {
  type: 'retry',
  maxRetries: 3,
  backoffMs: 1000,  // Exponential: 1s, 2s, 4s
};

const ALTERNATE_TOOL_POLICY: RecoveryStrategy = {
  type: 'alternate_tool',
  maxRetries: 1,
  alternateTool: 'browser_read_page',  // If browser_open failed
};

const ESCALATION_POLICY: RecoveryStrategy = {
  type: 'escalate',
  escalationMessage: 'Automated verification failed. Manual intervention needed.',
};
```

#### 5.3.5 Idempotency

- Tools **must** declare `idempotent: boolean` in metadata
- Verification uses idempotency keys for deduplication
- Retry only allowed for idempotent tools or with explicit `allowRetry: true`

#### 5.3.6 Cancellation

- `AbortSignal` propagated through all phases
- On cancel: `verification.abort()` → cleanup → audit `cancelled`
- Partial results preserved for inspection

#### 5.3.7 Audit Logging

- Structured JSONL: `~/.local/share/littleboy/audit/<sessionId>.jsonl`
- Fields: `timestamp`, `sessionId`, `planId`, `stepId`, `phase`, `action`, `details`, `outcome`, `durationMs`
- Retention: 30 days default, configurable
- Export: `jarvis audit export --format json|csv --since 2026-11-01`

---

### 5.4 D. Skills and Workflow Learning — `sidecar/skills/`

#### 5.4.1 Skill Manifest Schema (`skill-manifest.ts`)

```typescript
interface SkillManifest {
  // Identity
  name: string;                    // kebab-case, unique: "web-research"
  version: string;                 // SemVer: "1.0.0"
  description: string;             // Human-readable
  author: string;                  // "littleboy" or user ID
  license: string;                 // "MIT", "Apache-2.0", etc.

  // Interface
  inputSchema: JSONSchema;         // Required inputs
  outputSchema: JSONSchema;        // Expected outputs
  requiredTools: string[];         // ["browser_open", "web_fetch", "write_file"]
  requiredPermissions: PermissionLevel[];  // ["observe", "trusted"]

  // Execution
  steps: SkillStep[];
  verificationConditions: VerificationCondition[];
  recoveryStrategy: RecoveryStrategy;

  // Metadata
  tags: string[];                  // ["web", "research", "automation"]
  category: SkillCategory;         // "web" | "files" | "code" | "system" | "custom"
  estimatedDurationMs: number;     // For UI progress
  idempotent: boolean;             // Can re-run safely

  // Provenance
  createdAt: string;               // ISO 8601
  updatedAt: string;
  source: 'builtin' | 'user-recorded' | 'imported';
  sourceUrl?: string;              // If imported
  recordingSessionId?: string;     // If user-recorded
}

interface SkillStep {
  id: string;
  tool: string;
  args: Record<string, any> | ArgTemplate;  // Template with {{input.x}} placeholders
  description: string;
  condition?: string;            // Optional: skip if condition false
  verification?: VerificationCondition;
  onFailure?: 'continue' | 'retry' | 'abort' | 'alternate';
}

type ArgTemplate = Record<string, any>;  // Values can be "{{input.query}}" strings

type SkillCategory = 'web' | 'files' | 'code' | 'system' | 'communication' | 'custom';

type PermissionLevel = 'observe' | 'assist' | 'trusted' | 'sensitive' | 'administrative';
```

#### 5.4.2 Skill Registry (`skill-registry.ts`)

```typescript
interface SkillRegistry {
  // Registration
  register(manifest: SkillManifest, implementation?: SkillImplementation): Promise<void>;
  unregister(name: string): Promise<void>;
  get(name: string): SkillManifest | null;
  list(filter?: SkillFilter): SkillManifest[];

  // Execution
  execute(name: string, input: any, context: ExecutionContext): Promise<SkillExecutionResult>;

  // Recording (from OpenAdapt concepts)
  startRecording(sessionId: string, metadata: RecordingMetadata): Promise<RecordingHandle>;
  stopRecording(handle: RecordingHandle): Promise<SkillManifest>;
  replayRecording(recordingId: string, input: any): Promise<SkillExecutionResult>;

  // Versioning
  getVersions(name: string): SkillManifest[];
  setActiveVersion(name: string, version: string): Promise<void>;
}

interface SkillFilter {
  category?: SkillCategory;
  tags?: string[];
  requiredTools?: string[];
  permissionLevel?: PermissionLevel;
}

interface RecordingMetadata {
  name: string;
  description: string;
  category: SkillCategory;
  tags: string[];
  goal: string;  // Natural language goal for intent classification
}

interface RecordingHandle {
  id: string;
  sessionId: string;
  steps: RecordedStep[];
  startTime: number;
}

interface RecordedStep {
  timestamp: number;
  tool: string;
  args: any;
  result: any;
  screenshot?: Buffer;
  domSnapshot?: any;
  userAction?: UserAction;  // Click, type, scroll from overlay
}

interface UserAction {
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'select';
  target: ElementCriteria;
  value?: string;
}
```

#### 5.4.3 OpenAdapt Concepts — Adopted Selectively

| OpenAdapt Concept | Adoption | Adaptation |
|-------------------|----------|------------|
| Task recording (screen + actions) | ✅ Yes | Integrated with overlay `inkEvents.userClick` |
| Step segmentation | ✅ Yes | Align with Agent Core steps |
| Skill generalization | ⚠️ Partial | Template args `{{input.x}}` only, no ML generalization |
| Skill repository | ❌ No | Local registry only; remote later |
| Replay with verification | ✅ Yes | Uses Verification Service |

**Recording Flow**:
1. User starts recording via panel: "Record skill: web research"
2. Overlay captures user actions (clicks, types, scrolls) + tool calls
3. Agent Core executes tools in parallel (user drives, agent assists)
4. On stop: `SkillRegistry.stopRecording()` → generates manifest with templates
5. Manifest saved to `~/.local/share/littleboy/skills/<name>/manifest.json`

#### 5.4.4 Skill as Tool

- Each registered skill becomes a tool: `skill_<name>`
- Permission level = max of required permissions
- Verification = skill's `verificationConditions`
- Recovery = skill's `recoveryStrategy`

---

### 5.5 E. Semantic Memory — `sidecar/memory/sqlite/`

#### 5.5.1 Schema (`schema.sql`)

```sql
-- Core memory tables
CREATE TABLE memories (
  id TEXT PRIMARY KEY,           -- UUID
  type TEXT NOT NULL,            -- 'fact' | 'episode' | 'procedure' | 'preference' | 'commitment'
  content TEXT NOT NULL,         -- Full text
  summary TEXT,                  -- LLM-generated summary
  embedding BLOB,                -- Optional: sqlite-vec vector (768 dims)
  metadata JSON,                 -- Flexible: source, confidence, tags, etc.
  created_at INTEGER NOT NULL,   -- Unix ms
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER,           -- Last retrieval
  access_count INTEGER DEFAULT 0,
  expires_at INTEGER,            -- Optional TTL
  session_id TEXT,               -- Origin session
  plan_id TEXT,                  -- Origin plan
  skill_id TEXT                  -- Origin skill
);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  summary,
  metadata,
  content='memories',
  content_rowid='rowid'
);

-- Triggers for FTS sync
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, metadata) 
  VALUES (new.rowid, new.content, new.summary, new.metadata);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, metadata) 
  VALUES ('delete', old.rowid, old.content, old.summary, old.metadata);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, metadata) 
  VALUES ('delete', old.rowid, old.content, old.summary, old.metadata);
  INSERT INTO memories_fts(rowid, content, summary, metadata) 
  VALUES (new.rowid, new.content, new.summary, new.metadata);
END;

-- Vector search (optional, requires sqlite-vec extension)
-- CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[768]);

-- Relationships
CREATE TABLE memory_links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,        -- 'references' | 'contradicts' | 'supports' | 'continues'
  strength REAL DEFAULT 1.0,     -- 0.0 to 1.0
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation),
  FOREIGN KEY (source_id) REFERENCES memories(id),
  FOREIGN KEY (target_id) REFERENCES memories(id)
);

-- Consolidation tracking
CREATE TABLE consolidation_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  memories_processed INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,
  memories_merged INTEGER DEFAULT 0,
  status TEXT NOT NULL           -- 'running' | 'completed' | 'failed'
);
```

#### 5.5.2 Memory Service (`memory-service.ts`)

```typescript
interface MemoryService {
  // Core CRUD
  save(memory: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, patch: Partial<Memory>): Promise<Memory>;
  delete(id: string): Promise<void>;

  // Retrieval
  search(query: SearchQuery): Promise<SearchResult[]>;
  getByType(type: MemoryType, limit?: number): Promise<Memory[]>;
  getRecent(since: number, limit?: number): Promise<Memory[]>;
  getBySession(sessionId: string): Promise<Memory[]>;
  getByPlan(planId: string): Promise<Memory[]>;
  getBySkill(skillId: string): Promise<Memory[]>;

  // Semantic search (vector)
  vectorSearch(embedding: Float32Array, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  // Consolidation
  consolidate(options?: ConsolidationOptions): Promise<ConsolidationResult>;
  scheduleConsolidation(cron: string): void;  // e.g., "0 3 * * *" daily 3 AM

  // Maintenance
  prune(expiredBefore: number): Promise<number>;  // Returns deleted count
  vacuum(): Promise<void>;
  export(format: 'json' | 'csv', outputPath: string): Promise<void>;
}

interface SearchQuery {
  text?: string;                    // FTS5 query
  types?: MemoryType[];
  tags?: string[];
  since?: number;                   // created_at >
  until?: number;                   // created_at <
  sessionId?: string;
  planId?: string;
  skillId?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'relevance' | 'recency' | 'access_count';
}

interface SearchResult {
  memory: Memory;
  score: number;                    // FTS5 rank or vector similarity
  highlights: string[];             // Matched snippets
}

interface VectorSearchOptions {
  limit?: number;
  threshold?: number;               // Cosine similarity 0-1
  filter?: SearchQuery;
}

interface VectorSearchResult {
  memory: Memory;
  similarity: number;               // 0-1
}

interface ConsolidationOptions {
  maxAge?: number;                  // Only consolidate memories older than this
  similarityThreshold?: number;     // Merge if vector similarity > this
  useLLM?: boolean;                 // Use LLM for semantic merging
  dryRun?: boolean;
}

interface ConsolidationResult {
  processed: number;
  merged: number;
  created: number;
  errors: string[];
}
```

#### 5.5.3 Memory Types & Consolidation

| Type | Description | Consolidation Strategy |
|------|-------------|------------------------|
| `fact` | Discrete knowledge: "Python 3.12 released 2023-10-02" | Deduplicate by content hash; merge conflicting with LLM |
| `episode` | Event: "User asked for image libs at 2026-11-15 10:30" | Keep raw; summarize into facts |
| `procedure` | How-to: "To install pkg: `pip install x`" | Version; deprecate old |
| `preference` | User pref: "Prefers dark mode, Fish Audio TTS" | Latest wins; history kept |
| `commitment` | Promise: "Will send report by Friday" | Track fulfillment; auto-expire |

**Consolidation Pipeline** (runs daily):
1. Fetch memories older than `maxAge` (default 7 days)
2. Group by semantic similarity (vector + FTS)
3. For each cluster:
   - `fact` + `fact` → merge if same entity, LLM resolves conflicts
   - `episode` cluster → extract facts via LLM
   - `procedure` versions → keep latest, archive old
4. Write consolidated memories, link originals via `memory_links`

#### 5.5.4 Embeddings (Optional, No Local Model Mandate)

- **Default**: No vectors (FTS5 only)
- **Opt-in**: `sqlite-vec` extension + remote embedding API (OpenRouter: `text-embedding-3-small`)
- **Budget**: 768 dims × 4 bytes × 10k memories = ~30 MB
- **Generation**: Async, batched, on-save or background job

---

### 5.6 F. Security Boundaries

#### 5.6.1 Extended Permission Model

```typescript
// Additional permission levels for new capabilities
const EXTENDED_PERMISSION_LEVEL = {
  ...PERMISSION_LEVEL,
  browser_control: 'browser_control',      // Playwright automation
  desktop_control: 'desktop_control',      // AT-SPI2, input simulation
  skill_execution: 'skill_execution',      // Run recorded skills
  workflow_replay: 'workflow_replay',      // Replay with verification
} as const;
```

#### 5.6.2 Security Boundaries by Capability

| Capability | Boundary | Enforcement |
|------------|----------|-------------|
| **Browser** | Origin allowlist, no file://, no private IPs, cookie isolation per profile | `safety.mjs` → `checkUrl`, Playwright context isolation |
| **Desktop** | App allowlist (AT-SPI2), input simulation rate limit, no sudo | `computer-control` allowlist, `ydotool`/`libei` permissions |
| **Skills** | Manifest declares required tools/permissions, sandboxed execution | `SkillRegistry` validates against Agent Core router |
| **Workflow Replay** | Verification conditions mandatory, audit log immutable | `VerificationService` + audit JSONL |
| **Memory** | No PII in vector store (local only), encryption at rest optional | SQLite + optional SQLCipher |

#### 5.6.3 Audit Trail Requirements

- Every tool call: `audit.log()` with phase, action, outcome
- Every approval: request + response + fingerprint
- Every verification: condition + evidence + result
- Every recovery: strategy + attempt + outcome
- Export: `jarvis audit export --session <id> --format sarif` for compliance

---

## 6. Interfaces and Data Contracts

### 6.1 Agent Core ↔ New Adapters

```typescript
// Tool metadata extension for new capabilities
interface ExtendedToolPermission {
  level: PermissionLevel;
  requiresApproval: boolean;
  approvalScopes?: string[];
  description: string;
  // New fields
  idempotent?: boolean;
  verificationConditions?: VerificationCondition[];
  recoveryStrategy?: RecoveryStrategy;
  securityBoundary?: 'browser' | 'desktop' | 'memory' | 'skill' | 'none';
  allowlist?: string[];           // Origins, apps, paths
  rateLimit?: { max: number; windowMs: number };
}

// Example: browser_open
const browserOpenPermission: ExtendedToolPermission = {
  level: 'observe',
  requiresApproval: false,
  description: 'Navigate to a URL in the managed browser',
  idempotent: false,
  verificationConditions: [
    { type: 'url_matches', target: '{{args.url}}', timeoutMs: 10000 }
  ],
  securityBoundary: 'browser',
  allowlist: ['https://*', 'http://localhost:*'],  // Configured via safety
  rateLimit: { max: 10, windowMs: 60000 },
};
```

### 6.2 Skill Execution Contract

```typescript
interface SkillExecutionRequest {
  skillName: string;
  version?: string;           // Default: active version
  input: any;                 // Validated against inputSchema
  context: ExecutionContext;
  verificationOverride?: VerificationCondition[];  // Optional stricter checks
  recoveryOverride?: RecoveryStrategy;             // Optional custom recovery
  idempotencyKey?: string;    // For deduplication
}

interface SkillExecutionResult {
  status: 'completed' | 'failed' | 'recovered' | 'aborted';
  output: any;                // Validated against outputSchema
  steps: StepExecutionResult[];
  verifications: VerificationResult[];
  auditLog: AuditEntry[];
  durationMs: number;
}
```

### 6.3 Memory Retrieval for Agent Core

```typescript
// Context preparation uses MemoryService
interface MemoryContextAdapter {
  // For prepareContext in agentcore/context.mjs
  selectRelevantMemories(query: string, intent: IntentClassification, budgetTokens: number): Promise<Memory[]>;
  
  // For fact injection in prompts
  getRelevantFacts(topic: string, limit: number): Promise<Memory[]>;
  
  // For commitment tracking
  getActiveCommitments(): Promise<Memory[]>;
}
```

---

## 7. Dependency Graph

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           DEPENDENCY GRAPH                                  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  @kenkaiiii/gg-agent           ◄──────────────────────────────────────┐   │
│       │                                                                    │   │
│       ▼                                                                    │   │
│  sidecar/agentcore/                                                        │   │
│  ├── index.mjs                                                             │   │
│  ├── intent.mjs                                                            │   │
│  ├── planner.mjs                                                           │   │
│  ├── router.mjs                                                            │   │
│  ├── executor.mjs                                                          │   │
│  ├── permissions.mjs                                                       │   │
│  ├── approval-channel.mjs                                                  │   │
│  ├── context.mjs                                                           │   │
│  ├── runtime.mjs                                                           │   │
│  └── preflight.mjs                                                         │   │
│       │                                                                    │   │
│       ▼                                                                    │   │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    NEW MODULES (V2.1-V2.4)                          │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │                                                                     │  │
│  │  sidecar/computer-control/          sidecar/browser-intelligence/  │  │
│  │  ├── atspi-adapter.ts               ├── playwright-adapter.ts      │  │
│  │  ├── dbus-integration.ts            ├── browser-session.ts         │  │
│  │  ├── input-simulation.ts            ├── form-handler.ts            │  │
│  │  ├── ocr-adapter.ts                 ├── verification.ts            │  │
│  │  ├── verification.ts                └── browser-use-planner.ts     │  │
│  │  └── index.ts                                                      │  │
│  │                                                                     │  │
│  │  sidecar/perception/                sidecar/verification/         │  │
│  │  ├── screenshot-capture.ts          ├── verification-service.ts    │  │
│  │  ├── ocr-engine.ts                  ├── recovery-engine.ts         │  │
│  │  ├── vl-analysis.ts                 ├── audit-logger.ts            │  │
│  │  └── index.ts                       └── index.ts                   │  │
│  │                                                                     │  │
│  │  sidecar/skills/                    sidecar/memory/sqlite/        │  │
│  │  ├── skill-registry.ts              ├── schema.sql                 │  │
│  │  ├── skill-manifest.ts              ├── memory-service.ts          │  │
│  │  ├── recording-engine.ts            ├── consolidation.ts           │  │
│  │  ├── replay-engine.ts               ├── vector-search.ts           │  │
│  │  ├── verification.ts                └── index.ts                   │  │
│  │  └── index.ts                                                      │  │
│  │                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│       │                                                                    │   │
│       ▼                                                                    │   │
│  sidecar/tools.mjs  ◄─── Refactored to use new adapters                   │   │
│       │                                                                    │   │
│       ▼                                                                    │   │
│  sidecar/sidekick.mjs  ◄─── Integration point                             │   │
│       │                                                                    │   │
│       ▼                                                                    │   │
│  Tauri Shell (Rust)  ◄─── stdio JSON lines                                │   │
│                                                                            │   │
│  EXTERNAL DEPENDENCIES                                                     │   │
│  ├── playwright (Chromium)                                                 │   │
│  ├── @dbus/atspi (or node-dbus + atspi2)                                   │   │
│  ├── ydotool / libei (input simulation)                                    │   │
│  ├── tesseract.js / tesseract (OCR)                                        │   │
│  ├── better-sqlite3 / sql.js (SQLite)                                      │   │
│  ├── sqlite-vec (optional, vector search)                                  │   │
│  ├── zod (schemas)                                                         │   │
│  └── pino (structured logging)                                             │   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Phased Implementation Roadmap

### V2.1 — Linux Computer Control (Critical)
**Target**: 3-4 weeks

| Task | Description | Acceptance |
|------|-------------|------------|
| 2.1.1 | AT-SPI2 adapter: tree walk, element find, actions | Can list apps, find button by name/role, click it |
| 2.1.2 | D-Bus integration: app list, window list | `hands_locate` equivalent for Linux |
| 2.1.3 | Input simulation: ydotool/libei mouse/keyboard | Type in gedit, click button in Firefox |
| 2.1.4 | XDG Portal screenshot capture | Capture screen via Portal, returns PNG |
| 2.1.5 | OCR integration (Tesseract) | Extract text from screenshot |
| 2.1.6 | Verification for desktop actions | Click → verify element state changed |
| 2.1.7 | Tool registration: `linux_act`, `linux_locate`, `linux_windows`, `linux_capture`, `linux_ocr` | Tools appear in Agent Core, respect permissions |

**Dependencies**: `ydotool`/`libei`, `tesseract`, `@dbus/atspi`, `better-sqlite3`

### V2.2 — Browser Intelligence (Critical)
**Target**: 3-4 weeks (parallel with V2.1 after 2.1.1)

| Task | Description | Acceptance |
|------|-------------|------------|
| 2.2.1 | Playwright manager: launch, contexts, user data dir | Persistent profile, cookies survive restart |
| 2.2.2 | Navigation + inspection: goto, DOM, AX tree | Get button bounds, click it, verify navigation |
| 2.2.3 | Interaction: click, type, select, scroll | Fill login form, submit, verify success |
| 2.2.4 | Form handling: fill, submit, validate | Complete multi-step checkout flow |
| 2.2.5 | Screenshots: full page, element | Visual verification evidence |
| 2.2.6 | Authenticated sessions: cookie isolation | Separate profiles for different tasks |
| 2.2.7 | Tool registration: `browser_*` replacement | Drop-in replacement for existing browser tools |
| 2.2.8 | Browser Use planner (optional) | Complex research → step plan → execute |

**Dependencies**: `playwright`, `zod`

### V2.3 — Verification & Recovery Loop (Critical)
**Target**: 2-3 weeks (parallel with V2.1/V2.2)

| Task | Description | Acceptance |
|------|-------------|------------|
| 2.3.1 | VerificationService core | Execute tool → observe → verify → recover |
| 2.3.2 | Condition types: file, element, text, URL, command | All 7 condition types work |
| 2.3.3 | Recovery strategies: retry, alternate, escalate, abort | Configurable per tool/skill |
| 2.3.4 | Audit logger (JSONL) | Complete trace for any execution |
| 2.3.5 | Integration with Agent Core executor | `executeStep` → `executeWithVerification` |
| 2.3.6 | Idempotency keys + deduplication | Re-run same skill = no duplicate effects |
| 2.3.7 | Cancellation + partial results | Ctrl+C mid-execution → clean audit |

**Dependencies**: `pino`, `better-sqlite3` (for audit)

### V2.4 — Skills & Workflow Learning (High)
**Target**: 3-4 weeks (after V2.1-V2.3 stable)

| Task | Description | Acceptance |
|------|-------------|------------|
| 2.4.1 | SkillRegistry: register, list, execute | Built-in skill runs via `skill_<name>` |
| 2.4.2 | Manifest schema + validation (Zod) | Invalid manifest rejected at register |
| 2.4.3 | Recording engine: capture user actions + tools | Record → stop → generates valid manifest |
| 2.4.4 | Template args: `{{input.x}}` substitution | Recorded skill works with different inputs |
| 2.4.5 | Replay engine with verification | Replay → verifies each step |
| 2.4.6 | Versioning + active version | Multiple versions, switch active |
| 2.4.7 | Built-in skills: web_research, file_organize, code_review | 3+ skills demonstrable |

**Dependencies**: V2.1, V2.2, V2.3, `zod`

### V2.5 — Semantic Memory (High)
**Target**: 2-3 weeks (parallel with V2.4)

| Task | Description | Acceptance |
|------|-------------|------------|
| 2.5.1 | SQLite schema + migrations | `memories`, `memories_fts`, `memory_links` |
| 2.5.2 | MemoryService CRUD + search | Save fact → search by text → retrieve |
| 2.5.3 | Consolidation pipeline (daily) | Episodes → facts, dedup facts |
| 2.5.4 | Vector search (optional, opt-in) | `sqlite-vec` + remote embeddings |
| 2.5.5 | Context adapter for Agent Core | `prepareContext` uses semantic memory |
| 2.5.6 | Migration from file-based store | Existing sessions → SQLite |

**Dependencies**: `better-sqlite3`, `sqlite-vec` (optional)

### V2.6 — Proactive Assistance (Later)
**Target**: Post-V2.5

- Background monitoring → suggestions
- Scheduled skills (cron-like)
- Cross-session pattern learning
- Notification integration

---

## 9. Acceptance Criteria & Test Strategy

### 9.1 Unit Tests (Per Module)

| Module | Target Coverage | Key Tests |
|--------|-----------------|-----------|
| `computer-control` | 80% | Tree walk finds element, click executes, input sim types |
| `browser-intelligence` | 80% | Navigation, form fill, screenshot, auth persistence |
| `verification` | 90% | All conditions, retry/backoff, recovery strategies, audit |
| `skills` | 80% | Register/validate, record→manifest, replay→verify |
| `memory/sqlite` | 85% | CRUD, FTS5, consolidation, vector (if enabled) |
| `agentcore` | 95% | Existing + new tool metadata, verification integration |

### 9.2 Integration Tests

| Scenario | Description | Success Criteria |
|----------|-------------|------------------|
| **Web Research** | "Search for best Python image libs, compare, save to Documents" | File created with comparison table |
| **File Organization** | "Organize ~/Downloads by type" | Files moved to correct subdirs |
| **Code Review** | "Review PR #123, post comments" | Comments posted on GitHub |
| **Skill Recording** | User records "daily standup notes" skill | Manifest generated, replays correctly |
| **Verification** | Tool fails → retry → alternate → success | Audit log shows full chain |
| **Memory Consolidation** | 100 episodes → 20 facts | Facts extracted, linked, searchable |

### 9.3 End-to-End Tests (Manual → Automated)

| Test | Command | Verification |
|------|---------|--------------|
| Smoke | `littleboy --summon` | Panel opens |
| Voice | `littleboy --talk` | STT → intent → response |
| Desktop | `littleboy --ask "click the Firefox refresh button"` | Button clicked, page reloaded |
| Browser | `littleboy --ask "search GitHub for littleboy repo"` | Results displayed |
| Skill | `littleboy --ask "run web_research for Python async libs"` | File with results in Documents |

### 9.4 Performance Budgets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Sidecar startup | < 2s | `time node sidekick.mjs --version` |
| Tool routing (Agent Core) | < 50ms | `router.route()` benchmark |
| Verification (observe) | < 500ms | Screenshot + OCR |
| Browser launch (cold) | < 3s | Playwright `launch()` |
| Browser launch (warm) | < 500ms | Reuse context |
| AT-SPI2 tree walk | < 200ms | `getDesktopTree()` |
| Memory search (FTS5) | < 50ms | 10k memories |
| Memory search (vector) | < 100ms | 10k memories |
| RAM (idle) | < 300 MB | `ps` sidecar + helpers |
| RAM (active browser) | < 800 MB | With 5 tabs |
| Disk (memory DB) | < 100 MB | 50k memories |

---

## 10. Migration Strategy

### 10.1 Preserving Existing Functionality

| Existing Feature | Migration Approach |
|------------------|--------------------|
| `browser_open`, `browser_read_page`, etc. | Replace implementation with Playwright adapter; same tool names, same args |
| `screen_capture`, `screen_ocr` | Replace with XDG Portal + Tesseract; same tool names |
| `hands_act`, `hands_locate` (macOS/Win) | Unchanged; Linux adds `linux_*` equivalents |
| File tools (`read_file`, `write_file`) | Unchanged |
| Terminal (`run_diagnostic`) | Unchanged |
| Memory (`memory_save`, `memory_list`) | New `memory_sqlite_*` tools; old tools deprecated, proxy to SQLite |
| Agent Core | Default enabled; `ROAMIES_AGENT_CORE=1` in build |
| Config (`sidekick.json`) | Add `memory.backend: "sqlite" | "file"`; migrate on first run |

### 10.2 Migration Steps

1. **V2.1**: Add `computer-control` module, register `linux_*` tools. No breaking changes.
2. **V2.2**: Add `browser-intelligence`, implement `browser_*` replacements behind feature flag. Test parity.
3. **V2.3**: Add `verification`, wrap `executor.executeStep` → `executeWithVerification`. Opt-in per tool.
4. **V2.4**: Add `skills`, `SkillRegistry`. Built-in skills registered at startup.
5. **V2.5**: Add `memory/sqlite`, migration script `file → sqlite`. Default to SQLite for new installs.
6. **V2.0 Release**: Flip defaults: Agent Core on, SQLite on, Playwright browser, Verification on.

### 10.3 Rollback Plan

- Each phase behind feature flag: `LITTLEBOY_V2_COMPUTER_CONTROL`, `LITTLEBOY_V2_BROWSER`, etc.
- Config `v2Features: { computerControl: false, browser: false, verification: false, skills: false, memory: false }`
- Quick rollback: set flag false, restart sidecar

---

## 11. Open Questions Requiring Decision

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Input simulation: `ydotool` (uinput) vs `libei` (Wayland protocol) | `ydotool` works everywhere but needs `input` group; `libei` needs compositor support | **Both**: `libei` first, `ydotool` fallback. Document setup. |
| 2 | Browser profile isolation: per-task vs persistent default | Per-task = cleaner, no cross-contamination; Persistent = auth survives | **Hybrid**: Persistent "default" profile + ephemeral per-task profiles |
| 3 | Vector embeddings: local (ONNX) vs remote (OpenRouter) | Local = free, private, needs RAM; Remote = paid, simple, no RAM | **Remote only** (OpenRouter `text-embedding-3-small`), opt-in |
| 4 | Skill recording: overlay-driven vs sidecar-driven | Overlay captures user clicks; Sidecar captures tool calls | **Both**: Overlay for user actions, Sidecar for tool calls, merge at stop |
| 5 | Audit log format: JSONL vs SQLite | JSONL = append-only, easy tail; SQLite = queryable | **JSONL for audit**, SQLite for memory |
| 6 | Consolidation schedule: cron vs systemd timer vs in-process | Cron = simple; systemd = reliable; in-process = portable | **In-process** (node-cron), configurable cron expression |
| 7 | Verification default: on for all tools vs opt-in | All = safer; opt-in = gradual | **Opt-in per tool**, default on for `sensitive`+`administrative` |

---

## 12. Appendix: Current vs Proposed Tool Map

| Current Tool | V2 Tool | Adapter | Permission | Verification |
|--------------|---------|---------|------------|--------------|
| `read_file` | `read_file` | (unchanged) | observe | file_exists |
| `write_file` | `write_file` | (unchanged) | trusted | file_contains |
| `run_diagnostic` | `run_diagnostic` | (unchanged) | assist | command_succeeds |
| `launch_app` | `launch_app` | (unchanged) | trusted | element_visible |
| `browser_open` | `browser_open` | Playwright | observe | url_matches |
| `browser_read_page` | `browser_read_page` | Playwright | observe | text_present |
| `browser_navigate` | `browser_navigate` | Playwright | observe | url_matches |
| `browser_read_respan_authenticated` | `browser_read_respan_authenticated` | Playwright (auth profile) | observe | text_present |
| `web_fetch` | `web_fetch` | (unchanged) | observe | - |
| `screen_capture` | `linux_capture` | XDG Portal | observe | - |
| `screen_ocr` | `linux_ocr` | Tesseract | observe | text_present |
| `hands_act` (macOS/Win) | `hands_act` | (unchanged) | sensitive | element_visible |
| `hands_locate` (macOS/Win) | `hands_locate` | (unchanged) | observe | - |
| `hands_windows` (macOS/Win) | `hands_windows` | (unchanged) | observe | - |
| — | `linux_act` | AT-SPI2 + ydotool | desktop_control | element_visible |
| — | `linux_locate` | AT-SPI2 | observe | - |
| — | `linux_windows` | D-Bus | observe | - |
| `memory_save` | `memory_save` | SQLite | trusted | - |
| `memory_list` | `memory_list` | SQLite | observe | - |
| — | `skill_web_research` | Skills + Browser + Files | skill_execution | file_exists + file_contains |
| — | `skill_file_organize` | Skills + Files | skill_execution | file_exists |
| — | `skill_code_review` | Skills + Browser + Files | skill_execution | element_visible |

---

## 13. Approval Checklist

Before implementation begins, the following must be explicitly approved:

- [ ] **Architecture direction**: Preserve Agent Core, evolve not replace
- [ ] **Linux Computer Control**: AT-SPI2 + ydotool/libei approach
- [ ] **Browser Intelligence**: Playwright with persistent profiles
- [ ] **Verification Loop**: Execute→Observe→Verify→Recover as standard
- [ ] **Skills**: Internal registry, recording, replay with verification
- [ ] **Memory**: SQLite + FTS5, optional vectors via remote API
- [ ] **Security**: Extended permission model, audit logging
- [ ] **Roadmap**: V2.1–V2.5 sequence and parallelization
- [ ] **Dependencies**: Playwright, @dbus/atspi, ydotool, tesseract, better-sqlite3, sqlite-vec (opt-in), zod, pino
- [ ] **Performance budgets**: Acceptable for target hardware (i7-7500U, 8-16GB RAM)
- [ ] **Migration**: Feature flags, rollback plan, config compatibility

---

**End of Specification**

*This document is a design proposal. No code has been modified. Implementation begins only after explicit approval of the above checklist.*