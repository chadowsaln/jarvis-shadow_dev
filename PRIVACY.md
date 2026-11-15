# Privacy

Effective date: 15 November 2026

JARVIS V2 (rebranding in progress from Roamies/Little Boy) is an open-source desktop app. This page describes, in plain words, what data the app handles and where it goes. Some internal names, paths, and UI strings may still reflect the legacy Roamies/Little Boy naming while the transition is ongoing.

## The short version

- The developer runs no servers and collects nothing from you.
- There is no analytics or telemetry.
- Data leaves your computer only to services you choose to use, listed below.

## What leaves your computer, and where it goes

**The AI provider you sign in to** (Anthropic via Claude Code, OpenAI/ChatGPT, or a provider you add with an API
key) receives:

- your messages and the conversation so far
- a "live state" block: the date and time, your time zone, the name or title of the app and window in front,
  and the facts and commitments the app has saved in memory
- screenshots or window text, when the app looks at your screen to answer

**Fish Audio** or **Google** (Gemini), whichever you pick as the voice, receives the text of each reply to speak it, only if spoken replies are on. It uses your own key for that service (for Gemini, the Gemini key you added for the AI is used unless you save a separate one for the voice).

**GitHub** may be used to check for and download updates (configured endpoints may still reference legacy release/update locations during rebranding).

**Hugging Face** may be used once, on Windows and Linux, to download the speech model.

**Wikipedia** may be used to fetch photos for photo cards, and websites' `favicon.ico` may be fetched for source cards.

**Websites** that you or the agent open or fetch (for example with its web/fetch tools) receive the usual
request a browser would send.

**Search engines**: when the agent searches the web on a model from Anthropic, Anthropic
may run the search. On other providers, or when that search fails, search words may go to DuckDuckGo and, if it
doesn't answer, to Brave, Bing or Google (depending on available integrations/configuration).

Each provider's own privacy policy applies to what is sent to it.

## Speech, microphone and screen

- **macOS:** speech may be turned into text on your Mac by Apple's on-device recognizer. On Macs where on-device
  recognition isn't available, Apple's recognizer may use Apple's servers, under Apple's terms.
- **Windows and Linux:** speech is turned into text on your computer (Parakeet) where the voice helper/model are available.
- The microphone is used only while you hold the talk keys/shortcut (behavior can vary by platform/session, e.g. Wayland).
- **Wake word (if enabled; legacy naming may appear):** when turned on, the microphone may stay open to listen for the configured wake phrase, and the OS may show its microphone indicator. Audio is processed locally by the configured speech path; nothing is kept or sent anywhere until the phrase is detected (implementation details may vary by platform/build).
- The screen is captured only when you ask the app to inspect the screen/area or when a capture tool is used. On Linux with Wayland, capture may go through the desktop portal and require user consent.

## What's stored on your computer

Configuration, memory, and session data are stored locally on your computer. Current/legacy locations may include:

| File or folder (common/legacy) | What's in it |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `~/.gg/sidekick.json`          | settings (path may vary by build/config) |
| `~/.gg/sidekick/`              | memory, sessions, logs, models and related local data (legacy layout) |
| `~/.gg/sidekick/sessions/`     | conversations (retention limits may apply) |
| `~/.gg/sidekick/logs/`         | activity/log files (content and retention depend on implementation) |
| `~/.gg/sidekick/usage.jsonl`   | token counts/timings (if enabled) |
| `~/.gg/auth.json`              | AI sign-ins/credentials as used by the current auth integration |

On Windows, equivalent paths may be under `%USERPROFILE%\.gg`. Actual locations can change as the JARVIS V2 data/storage model evolves.

**Diagnostics export** (if available in the UI/build): may write a diagnostics file locally only when you request it. It can include logs, system/screen details, microphone/permission states, and settings; sensitive values should be redacted by the implementation, but you should review the file before sharing it. Nothing is uploaded unless you choose to send it.

Voice/service keys may be stored in the platform key store (macOS Keychain, Windows DPAPI/credential storage, or Linux Secret Service/keyring) depending on build and configuration. Some legacy service/account identifiers may still be used.

You can inspect and remove remembered items using the app's memory UI if available.

## Deleting everything

Uninstall the app and remove its local data/config/keys for your platform and install method. Because naming/paths are in transition, check both legacy Roamies/Little Boy and JARVIS V2 locations (e.g. `~/.gg/sidekick*`, app data, autostart entries, and keyring entries).

## Children

JARVIS V2 is not made for children under 13 (or the minimum age in their country), and it does not ask about age.
Parents should supervise any use by children.

## Changes

Changes to this notice are made in this file in the repository, so its history shows what changed and when.

## Questions

Email [ken@kenkais.com](mailto:ken@kenkais.com) or [open an issue](https://github.com/KenKaiii/Roamies/issues).
