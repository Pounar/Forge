# Forge

Forge is a local-first focus timer. It creates an anonymous identity in this browser and stores the timer, preferences, and completed focus sessions in that browser's local storage. No account, personal details, or API key are needed. Data stays on this browser and device; it is not synced to the cloud and may be lost if browser data is cleared.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. To create a production build, run `npm run build`.

## Features

- Focus, short-break, and long-break timers with timestamp-based countdown and reload recovery.
- Quick focus-duration presets plus custom hour, minute, and second durations for focus and breaks, with pause, resume, and reset.
- A gentle, locally generated completion chime, with a sound toggle in settings.
- Daily focus time, completed sessions, a current streak, and a compact seven-day activity view.
- Settings for timer durations, completion sound, and opt-in browser notifications.
- Browser-specific local settings and focus-session history with automatic saving; no account, cloud sync, or external audio assets.
