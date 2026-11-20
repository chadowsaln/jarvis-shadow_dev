# Audio on Fedora (PipeWire / WebKitGTK)

## Symptoms
- No sound effects or spoken replies in the panel.
- Voice recording does not start or the mic is never granted.

## Likely causes and fixes

1. WebKitGTK autoplay / AudioContext
   - WebKitGTK suspends AudioContext until a user gesture. The app resumes it on pointer/keyboard input.
   - If still silent, click anywhere in the panel once to unlock audio.

2. PipeWire vs ALSA
   - Fedora uses PipeWire. Ensure PipeWire and the ALSA compatibility layer are running:
     `systemctl --user status pipewire pipewire-pulse`
   - Set the default sink/source:
     `pactl set-default-sink <sink>` / `pactl set-default-source <source>` (or use GNOME Sound settings).

3. Missing GStreamer plugins for WebKit audio
   - Install: `sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav`

4. Voice recording (ALSA mic in the Linux helper)
   - The helper uses ALSA. With PipeWire, install `pipewire-alsa` and ensure the mic is the default source.

5. Talk key on Wayland
   - GNOME cannot grab global keys. Bind a custom shortcut to `jarvis_v2 --talk`:
     Settings -> Keyboard -> Custom Shortcuts -> Command: `jarvis_v2 --talk`.

6. AppImage sandbox
   - The AppImage may not see host env vars. Launch with:
     `DBUS_SESSION_BUS_ADDRESS=... XDG_RUNTIME_DIR=... ./JARVIS*.AppImage`
