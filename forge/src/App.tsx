import { useEffect, useMemo, useRef, useState } from "react";

type Mode = "focus" | "short" | "long";
type DurationParts = { hours: string; minutes: string; seconds: string };
type Settings = {
  focusMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  completionSound: boolean;
  completionNotifications: boolean;
};
type FocusSession = {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMinutes: number;
};
type Timer = {
  mode: Mode;
  running: boolean;
  endAt: number | null;
  remainingMs: number;
  startedAt: number | null;
  durationMinutes: number;
};
type AppData = { settings: Settings; sessions: FocusSession[]; timer: Timer };
type Panel = "progress" | "settings" | null;
type SaveStatus = "idle" | "saving" | "saved" | "error";

const STORAGE_KEY_PREFIX = "forge-app-v1";
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX;
const BROWSER_ID_KEY = "forge-browser-id-v1";
const DEFAULT_SETTINGS: Settings = {
  focusMinutes: 25,
  shortMinutes: 5,
  longMinutes: 15,
  completionSound: true,
  completionNotifications: false,
};
const MODE_NAMES: Record<Mode, string> = {
  focus: "Focus",
  short: "Short break",
  long: "Long break",
};
const SETTINGS_KEY: Record<Mode, "focusMinutes" | "shortMinutes" | "longMinutes"> = {
  focus: "focusMinutes",
  short: "shortMinutes",
  long: "longMinutes",
};
const LIMITS: Record<Mode, number> = { focus: 120, short: 60, long: 90 };
const PRESETS = [15, 25, 45, 60];
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function getBrowserStorageKey(): string {
  let browserId = localStorage.getItem(BROWSER_ID_KEY);
  if (!browserId) {
    browserId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(BROWSER_ID_KEY, browserId);
  }
  return `${STORAGE_KEY_PREFIX}:${browserId}`;
}

function durationDrafts(settings: Settings): Record<Mode, DurationParts> {
  return {
    focus: durationParts(settings.focusMinutes * 60),
    short: durationParts(settings.shortMinutes * 60),
    long: durationParts(settings.longMinutes * 60),
  };
}

function durationParts(totalSeconds: number): DurationParts {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return {
    hours: String(Math.floor(seconds / 3600)).padStart(2, "0"),
    minutes: String(Math.floor((seconds % 3600) / 60)).padStart(2, "0"),
    seconds: String(seconds % 60).padStart(2, "0"),
  };
}

function partsToSeconds(parts: DurationParts): number | null {
  const values = [parts.hours, parts.minutes, parts.seconds];
  if (values.some((value) => value.trim() === "" || !/^\d+$/.test(value))) return null;
  const [hours, minutes, seconds] = values.map(Number);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function DurationInputs({
  value,
  onChange,
  onCommit,
  prefix,
}: {
  value: DurationParts;
  onChange: (part: keyof DurationParts, value: string) => void;
  onCommit: () => void;
  prefix: string;
}) {
  return (
    <div className="duration-inputs" aria-label={`${prefix} custom duration`}>
      {([
        ["hours", "hr", 999],
        ["minutes", "min", 59],
        ["seconds", "sec", 59],
      ] as const).map(([part, label, max]) => (
        <label className="duration-input" key={part}>
          <input
            aria-label={`${prefix} duration ${label}`}
            type="number"
            min={0}
            max={max}
            step={1}
            inputMode="numeric"
            value={value[part]}
            onChange={(event) => onChange(part, event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onCommit();
                event.currentTarget.blur();
              }
            }}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

const freshTimer = (mode: Mode, settings: Settings): Timer => {
  const durationMinutes = settings[SETTINGS_KEY[mode]];
  return {
    mode,
    running: false,
    endAt: null,
    remainingMs: durationMinutes * 60_000,
    startedAt: null,
    durationMinutes,
  };
};

const emptyData = (): AppData => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  timer: freshTimer("focus", DEFAULT_SETTINGS),
});

function clampDuration(value: unknown, mode: Mode, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const seconds = Math.min(LIMITS[mode] * 60, Math.max(1, Math.round(number * 60)));
  return seconds / 60;
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(getBrowserStorageKey()) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return emptyData();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return emptyData();
    const stored = value as Partial<AppData> & {
      settings?: Partial<Settings>;
      timer?: Partial<Timer>;
    };
    const oldSettings: Partial<Settings> = stored.settings ?? {};
    const settings: Settings = {
      focusMinutes: clampDuration(oldSettings.focusMinutes, "focus", DEFAULT_SETTINGS.focusMinutes),
      shortMinutes: clampDuration(oldSettings.shortMinutes, "short", DEFAULT_SETTINGS.shortMinutes),
      longMinutes: clampDuration(oldSettings.longMinutes, "long", DEFAULT_SETTINGS.longMinutes),
      completionSound: oldSettings.completionSound !== false,
      completionNotifications: oldSettings.completionNotifications === true,
    };
    const sessions = Array.isArray(stored.sessions)
      ? stored.sessions.filter((item): item is FocusSession =>
          Boolean(
            item &&
              typeof item.id === "string" &&
              Number.isFinite(item.startedAt) &&
              Number.isFinite(item.completedAt) &&
              Number.isFinite(item.durationMinutes) &&
              item.durationMinutes > 0,
          ),
        )
      : [];
    const saved = stored.timer;
    const mode: Mode =
      saved?.mode === "short" || saved?.mode === "long" ? saved.mode : "focus";
    const timer = freshTimer(mode, settings);
    if (!saved || typeof saved !== "object") return { settings, sessions, timer };
    const durationMinutes = clampDuration(
      saved.durationMinutes,
      mode,
      settings[SETTINGS_KEY[mode]],
    );
    if (saved.running && Number.isFinite(saved.endAt)) {
      return {
        settings,
        sessions,
        timer: {
          mode,
          running: true,
          endAt: saved.endAt!,
          remainingMs: Math.max(0, saved.endAt! - Date.now()),
          startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt! : null,
          durationMinutes,
        },
      };
    }
    if (Number.isFinite(saved.remainingMs)) {
      return {
        settings,
        sessions,
        timer: {
          mode,
          running: false,
          endAt: null,
          remainingMs: Math.max(0, saved.remainingMs!),
          startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt! : null,
          durationMinutes,
        },
      };
    }
    return { settings, sessions, timer };
  } catch (error) {
    console.warn("Forge could not read its saved focus data.", error);
    return emptyData();
  }
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayOrdinal(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function currentStreak(sessions: FocusSession[]): number {
  const days = [...new Set(sessions.map((session) => dayKey(session.completedAt)))].sort();
  if (!days.length) return 0;
  const today = dayKey(Date.now());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const last = days[days.length - 1];
  if (last !== today && last !== dayKey(yesterday.getTime())) return 0;
  let streak = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (dayOrdinal(days[index]) - dayOrdinal(days[index - 1]) !== 1) break;
    streak += 1;
  }
  return streak;
}

function completeExpiredTimer(data: AppData, completedAt: number): AppData {
  const timer = data.timer;
  if (!timer.running || timer.endAt === null || timer.endAt > completedAt) return data;
  const sessionId = String(timer.startedAt ?? timer.endAt);
  const alreadyRecorded = data.sessions.some((session) => session.id === sessionId);
  const sessions =
    timer.mode === "focus" && timer.startedAt !== null && !alreadyRecorded
      ? [
          ...data.sessions,
          {
            id: sessionId,
            startedAt: timer.startedAt,
            completedAt,
            durationMinutes: timer.durationMinutes,
          },
        ]
      : data.sessions;
  return {
    ...data,
    sessions,
    timer: { ...timer, running: false, endAt: null, remainingMs: 0 },
  };
}

function formatDuration(minutes: number): string {
  const totalSeconds = Math.max(0, Math.round(minutes * 60));
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  if (totalSeconds < 3600) {
    const wholeMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${wholeMinutes}m ${seconds}s` : `${wholeMinutes} min`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const remainder = Math.floor((totalSeconds % 3600) / 60);
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function playCompletionChime(context: AudioContext): void {
  const startAt = context.currentTime + 0.04;
  const notes = [
    { frequency: 587.33, offset: 0, length: 0.34 },
    { frequency: 739.99, offset: 0.15, length: 0.4 },
    { frequency: 880, offset: 0.3, length: 0.58 },
  ];
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startAt + note.offset;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.13, noteStart + 0.045);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.length);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + note.length + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}

function getWeekDays(): Date[] {
  const today = new Date();
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    day.setDate(day.getDate() - 6 + index);
    return day;
  });
}

function Icon({ name, size = 18 }: { name: "spark" | "settings" | "chart" | "close" | "minus" | "plus" | "play" | "pause" | "reset" | "check"; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  const paths: Record<typeof name, React.ReactNode> = {
    spark: <><path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></>,
    settings: <><path d="M9.8 3.5h4.4l.6 2a7.4 7.4 0 0 1 1.5.9l2-.6 2.2 3.8-1.5 1.5a7.2 7.2 0 0 1 0 1.8l1.5 1.5-2.2 3.8-2-.6a7.4 7.4 0 0 1-1.5.9l-.6 2H9.8l-.6-2a7.4 7.4 0 0 1-1.5-.9l-2 .6-2.2-3.8L5 12a7.2 7.2 0 0 1 0-1.8L3.5 8.7l2.2-3.8 2 .6a7.4 7.4 0 0 1 1.5-.9z" /><circle cx="12" cy="12" r="2.4" /></>,
    chart: <><path d="M4 19.5h16M6.5 16v-5M12 16V5M17.5 16V9" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    play: <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5h3v14H8zM15 5h3v14h-3z" fill="currentColor" stroke="none" /></>,
    reset: <><path d="M3.5 11a8.5 8.5 0 1 1 2.2 6M3.5 4.5V11h6.5" /><path d="M12 7v5l3 2" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function App() {
  const [data, setData] = useState<AppData>(loadData);
  const [now, setNow] = useState(Date.now());
  const [panel, setPanel] = useState<Panel>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [durationDraftsState, setDurationDrafts] = useState(() => durationDrafts(data.settings));
  const [durationError, setDurationError] = useState("");
  const [settingDurationError, setSettingDurationError] = useState("");
  const [notificationMessage, setNotificationMessage] = useState("");
  const [soundMessage, setSoundMessage] = useState("");
  const completionGuard = useRef<string | null>(null);
  const soundedCompletion = useRef<string | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const timer = data.timer;
  const remainingMs = timer.running && timer.endAt !== null
    ? Math.max(0, timer.endAt - now)
    : timer.remainingMs;
  const complete = !timer.running && timer.remainingMs === 0 && timer.startedAt !== null;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let statusTimeout: number | undefined;
    setSaveStatus("saving");
    try {
      localStorage.setItem(getBrowserStorageKey(), JSON.stringify(data));
      setSaveStatus("saved");
      statusTimeout = window.setTimeout(() => setSaveStatus("idle"), 1800);
    } catch (error) {
      console.error("Forge could not save focus data in this browser.", error);
      setSaveStatus("error");
    }
    return () => {
      if (statusTimeout !== undefined) window.clearTimeout(statusTimeout);
    };
  }, [data]);

  useEffect(() => {
    if (!timer.running || timer.endAt === null || remainingMs > 0) return;
    const sessionId = String(timer.startedAt ?? timer.endAt);
    if (completionGuard.current === sessionId) return;
    completionGuard.current = sessionId;
    const completedAt = Date.now();
    setData((previous) => completeExpiredTimer(previous, completedAt));
    if (data.settings.completionSound && soundedCompletion.current !== sessionId) {
      soundedCompletion.current = sessionId;
      try {
        const context = audioContext.current ?? new AudioContext();
        audioContext.current = context;
        const play = () => playCompletionChime(context);
        if (context.state === "suspended") {
          void context.resume().then(play).catch((error: unknown) => {
            console.warn("Forge could not play the completion chime.", error);
            setSoundMessage("The completion sound was blocked by your browser.");
          });
        } else if (context.state === "running") {
          play();
        } else {
          setSoundMessage("The completion sound is unavailable in this browser.");
        }
      } catch (error) {
        console.warn("Forge could not initialize the completion chime.", error);
        setSoundMessage("The completion sound is unavailable in this browser.");
      }
    }
    if (data.settings.completionNotifications && "Notification" in window && Notification.permission === "granted") {
      new Notification(timer.mode === "focus" ? "Session complete" : "Break complete", {
        body: timer.mode === "focus" ? `${formatDuration(timer.durationMinutes)} of focus. Nicely done.` : "Ready when you are.",
      });
    }
  }, [data.settings.completionNotifications, data.settings.completionSound, remainingMs, timer]);

  useEffect(() => {
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel]);

  useEffect(() => {
    if (panel !== "settings") return;
    setDurationDrafts(durationDrafts(data.settings));
    setSettingDurationError("");
    setNotificationMessage("");
  }, [panel]);

  const todayStart = useMemo(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }, [now]);
  const todaySessions = data.sessions.filter((session) => session.completedAt >= todayStart);
  const todayMinutes = todaySessions.reduce((total, session) => total + session.durationMinutes, 0);
  const weekDays = getWeekDays();
  const weekActivity = weekDays.map((day) => ({
    day,
    minutes: data.sessions
      .filter((session) => dayKey(session.completedAt) === dayKey(day.getTime()))
      .reduce((total, session) => total + session.durationMinutes, 0),
  }));
  const weekTotal = weekActivity.reduce((total, item) => total + item.minutes, 0);
  const timerProgress = timer.durationMinutes > 0
    ? Math.min(1, Math.max(0, 1 - remainingMs / (timer.durationMinutes * 60_000)))
    : 0;
  const displayHours = Math.floor(remainingMs / 3_600_000);
  const displayMinutes = String(Math.floor((remainingMs % 3_600_000) / 60_000)).padStart(2, "0");
  const seconds = String(Math.floor((remainingMs % 60_000) / 1_000)).padStart(2, "0");
  const status = complete
    ? "SESSION COMPLETE"
    : timer.running
      ? timer.mode === "focus" ? "FOCUSING" : "ON BREAK"
      : timer.startedAt !== null && remainingMs > 0
        ? "PAUSED"
        : "READY";
  const startLabel =
    timer.startedAt !== null && remainingMs > 0
      ? `Resume ${timer.mode === "focus" ? "focus" : "break"}`
      : timer.mode === "focus"
        ? "Start focusing"
        : `Start ${MODE_NAMES[timer.mode].toLowerCase()}`;

  const chooseMode = (mode: Mode) => {
    completionGuard.current = null;
    setData((previous) => ({ ...previous, timer: freshTimer(mode, previous.settings) }));
  };

  const startTimer = () => {
    setSoundMessage("");
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      if (context.state === "suspended") {
        void context.resume().catch((error: unknown) => {
          console.warn("Forge could not activate the completion chime.", error);
          setSoundMessage("Browser audio could not be activated. You can still use the timer.");
        });
      }
    } catch (error) {
      console.warn("Forge could not initialize browser audio.", error);
      setSoundMessage("Browser audio is unavailable. You can still use the timer.");
    }
    completionGuard.current = null;
    setData((previous) => {
      let current = previous.timer;
      if (current.remainingMs === 0) current = freshTimer(current.mode, previous.settings);
      const startedAt = current.startedAt ?? Date.now();
      const endAt = Date.now() + current.remainingMs;
      return {
        ...previous,
        timer: { ...current, running: true, endAt, startedAt },
      };
    });
  };

  const startFreshFocus = () => {
    completionGuard.current = null;
    setSoundMessage("");
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      if (context.state === "suspended") {
        void context.resume().catch((error: unknown) => {
          console.warn("Forge could not activate the completion chime.", error);
          setSoundMessage("Browser audio could not be activated. You can still use the timer.");
        });
      }
    } catch (error) {
      console.warn("Forge could not initialize browser audio.", error);
      setSoundMessage("Browser audio is unavailable. You can still use the timer.");
    }
    setData((previous) => {
      const fresh = freshTimer("focus", previous.settings);
      const startedAt = Date.now();
      return {
        ...previous,
        timer: {
          ...fresh,
          running: true,
          startedAt,
          endAt: startedAt + fresh.remainingMs,
        },
      };
    });
  };

  const pauseTimer = () => {
    setData((previous) => {
      if (!previous.timer.running || previous.timer.endAt === null) return previous;
      const remainingMs = previous.timer.endAt - Date.now();
      if (remainingMs <= 0) return previous;
      return {
        ...previous,
        timer: {
          ...previous.timer,
          running: false,
          endAt: null,
          remainingMs,
        },
      };
    });
  };

  const resetTimer = () => {
    completionGuard.current = null;
    setData((previous) => {
      if (previous.timer.running && previous.timer.endAt !== null && previous.timer.endAt <= Date.now()) {
        return completeExpiredTimer(previous, Date.now());
      }
      return { ...previous, timer: freshTimer(previous.timer.mode, previous.settings) };
    });
  };

  const updateDuration = (mode: Mode, rawSeconds: number) => {
    const value = clampDuration(rawSeconds / 60, mode, data.settings[SETTINGS_KEY[mode]]);
    setData((previous) => {
      const settings = { ...previous.settings, [SETTINGS_KEY[mode]]: value };
      const timer =
        previous.timer.mode === mode &&
        !previous.timer.running &&
        previous.timer.startedAt === null
          ? freshTimer(mode, settings)
          : previous.timer;
      return { ...previous, settings, timer };
    });
  };

  const updateDurationDraft = (mode: Mode, part: keyof DurationParts, value: string) => {
    const nextDraft = { ...durationDraftsState[mode], [part]: value };
    setDurationDrafts((previous) => ({
      ...previous,
      [mode]: nextDraft,
    }));
    setDurationError("");
    setSettingDurationError("");
    const seconds = partsToSeconds(nextDraft);
    if (seconds !== null && seconds >= 1 && seconds <= LIMITS[mode] * 60) {
      updateDuration(mode, seconds);
    }
  };

  const applyCustomDuration = (mode: Mode) => {
    const value = partsToSeconds(durationDraftsState[mode]);
    if (value === null || value < 1 || value > LIMITS[mode] * 60) {
      setDurationError(`Choose a valid ${MODE_NAMES[mode].toLowerCase()} duration from 1 second to ${LIMITS[mode]} minutes.`);
      return;
    }
    updateDuration(mode, value);
    setDurationDrafts((previous) => ({ ...previous, [mode]: durationParts(value) }));
    setDurationError("");
  };

  const saveSettingDuration = (mode: Mode) => {
    const value = partsToSeconds(durationDraftsState[mode]);
    if (value === null || value < 1 || value > LIMITS[mode] * 60) {
      setSettingDurationError(`${MODE_NAMES[mode]} duration must be between 1 second and ${LIMITS[mode]} minutes.`);
      return;
    }
    updateDuration(mode, value);
    setDurationDrafts((previous) => ({ ...previous, [mode]: durationParts(value) }));
    setSettingDurationError("");
  };

  const toggleNotifications = async () => {
    setNotificationMessage("");
    if (data.settings.completionNotifications) {
      setData((previous) => ({
        ...previous,
        settings: { ...previous.settings, completionNotifications: false },
      }));
      return;
    }
    if (!("Notification" in window)) {
      setNotificationMessage("This browser does not support completion notifications.");
      return;
    }
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission === "granted") {
      setData((previous) => ({
        ...previous,
        settings: { ...previous.settings, completionNotifications: true },
      }));
    } else {
      setNotificationMessage("Notifications are blocked in this browser. Allow them in browser settings to enable this option.");
    }
  };

  const primaryAction = timer.running ? pauseTimer : startTimer;

  return (
    <div className="forge-app">
      <header className="forge-header">
        <a className="forge-brand" href="#" onClick={(event) => event.preventDefault()} aria-label="Forge home">
          <span className="forge-mark" aria-hidden="true">
            <svg viewBox="0 0 36 36" fill="none">
              <circle className="forge-mark-ring" cx="18" cy="18" r="11" />
              <circle className="forge-mark-center" cx="18" cy="18" r="2" />
            </svg>
          </span>
          <span className="forge-brand-copy">
            <span className="forge-brand-name">Forge</span>
            <span className="forge-brand-subtitle">your focus timer</span>
          </span>
        </a>
        <div className="header-center">
          <p className="forge-tagline">Forge — Enter Focus, Build Momentum.</p>
        </div>
        <div className="header-right">
          <div className="header-actions">
            <button className="header-action progress-action" onClick={() => setPanel("progress")} aria-label="Open focus progress" title="Your progress">
              <Icon name="chart" size={18} /><span>Progress</span>
            </button>
            <button className="header-action settings-action" onClick={() => setPanel("settings")} aria-label="Open settings" title="Settings">
              <Icon name="settings" size={18} />
            </button>
          </div>
        </div>
      </header>

      <div className="focus-workspace">
        <aside className="focus-rail progress-rail" aria-label="Today's focus progress">
          <div className="rail-heading">
            <span className="rail-kicker"><span className="rail-indicator" /> YOUR MOMENTUM</span>
            <h2>Built today</h2>
            <p>Every focused minute adds up.</p>
          </div>
          <div className="rail-stats">
            <div className="rail-stat">
              <span>FOCUS TIME</span>
              <strong>{formatDuration(todayMinutes)}</strong>
              <small>today</small>
            </div>
            <div className="rail-stat">
              <span>SESSIONS</span>
              <strong>{todaySessions.length}</strong>
              <small>completed today</small>
            </div>
            <div className="rail-stat streak-stat">
              <span>STREAK</span>
              <strong>{currentStreak(data.sessions)} <small>{currentStreak(data.sessions) === 1 ? "day" : "days"}</small></strong>
              <small>keep the rhythm</small>
            </div>
          </div>
          <p className="rail-quote">“One session at a time.”</p>
        </aside>

        <main className={`timer-stage ${complete ? "is-complete" : ""}`}>
        <div className="clock-row" aria-label="Current date and local time">
          <time dateTime={new Date(now).toISOString()}>{DATE_FORMATTER.format(now)}</time>
          <time dateTime={new Date(now).toISOString()}>{TIME_FORMATTER.format(now)}</time>
        </div>
        <div className="mode-selector" role="group" aria-label="Choose timer mode">
          {(["focus", "short", "long"] as Mode[]).map((mode) => (
            <button
              key={mode}
              className={`mode-option ${timer.mode === mode ? "selected" : ""}`}
              aria-pressed={timer.mode === mode}
              onClick={() => chooseMode(mode)}
            >
              {MODE_NAMES[mode]}
            </button>
          ))}
        </div>

        {!timer.running && !complete && timer.startedAt === null && (
          <div className="duration-controls">
            {timer.mode === "focus" && (
              <div className="quick-duration" aria-label="Focus duration presets">
                {PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={data.settings.focusMinutes === preset ? "chosen" : ""}
                    onClick={() => {
                      updateDuration("focus", preset * 60);
                      setDurationDrafts((previous) => ({
                        ...previous,
                        focus: durationParts(preset * 60),
                      }));
                    }}
                    aria-pressed={data.settings.focusMinutes === preset}
                  >
                    {preset} min
                  </button>
                ))}
              </div>
            )}
            <DurationInputs
              value={durationDraftsState[timer.mode]}
              onChange={(part, value) => updateDurationDraft(timer.mode, part, value)}
              onCommit={() => applyCustomDuration(timer.mode)}
              prefix={MODE_NAMES[timer.mode]}
            />
            {durationError && <p className="duration-error" role="alert">{durationError}</p>}
          </div>
        )}

        <section className="timer-center" aria-label={`${MODE_NAMES[timer.mode]} timer`}>
          <div className={`timer-orbit ${timer.running ? "is-running" : ""} ${complete ? "is-complete" : ""}`}>
            <svg className="timer-svg" viewBox="0 0 340 340" aria-hidden="true">
              <circle className="timer-track" cx="170" cy="170" r="156" />
              <circle
                className="timer-progress"
                cx="170"
                cy="170"
                r="156"
                style={{ strokeDashoffset: `${980.18 * (1 - timerProgress)}` }}
              />
            </svg>
            <div className="timer-display">
              <span className="timer-mode-name">{MODE_NAMES[timer.mode].toUpperCase()}</span>
              <span className={`timer-digits ${displayHours > 0 ? "has-hours" : ""}`} aria-live="off">
                {displayHours > 0 && <><span>{String(displayHours).padStart(2, "0")}</span><i>:</i></>}
                <span>{displayMinutes}</span><i>:</i><span>{seconds}</span>
              </span>
              <span className={`timer-status ${timer.running ? "status-running" : complete ? "status-complete" : status === "PAUSED" ? "status-paused" : ""}`}>
                <span className="state-indicator" />{status}
              </span>
            </div>
          </div>
        </section>

        {complete && (
          <section className="completion-card" aria-live="polite">
            <span className="completion-check"><Icon name="check" size={17} /></span>
            <div className="completion-copy">
              <strong>{timer.mode === "focus" ? "Focus session complete!" : "Break complete!"}</strong>
              <span>{timer.mode === "focus" ? `${formatDuration(timer.durationMinutes)} of focus, built by you.` : "Take a breath. You're ready when you are."}</span>
            </div>
            <div className="completion-actions">
              <button className="completion-primary" onClick={startFreshFocus}>Focus Again</button>
              <button className="completion-secondary" onClick={() => chooseMode(timer.mode === "long" ? "short" : "long")}>Take a Break</button>
            </div>
          </section>
        )}

        {!complete && (
          <div className="timer-actions">
            <button className="timer-primary" onClick={primaryAction} aria-label={timer.running ? "Pause timer" : startLabel}>
              <Icon name={timer.running ? "pause" : "play"} size={17} />
              <span>{timer.running ? "Pause" : startLabel}</span>
            </button>
            <button className="timer-reset" onClick={resetTimer} aria-label="Reset timer" title="Reset timer">
              <Icon name="reset" size={18} />
            </button>
          </div>
        )}
        <p className="stage-hint">
          <span className="hint-dot" />
          {timer.running ? "One thing at a time. Stay with it." : complete ? "A little progress is still progress." : "A clear mind starts with one small step."}
        </p>
        </main>

        <aside className="focus-rail activity-rail" aria-label="Weekly focus activity">
          <div className="activity-heading rail-activity-heading">
            <div>
              <span className="rail-kicker"><span className="rail-indicator cyan" /> THIS WEEK</span>
              <h2>Quiet progress</h2>
            </div>
            <strong>{formatDuration(weekTotal)}</strong>
          </div>
          <div className="rail-chart" role="img" aria-label={`Focus activity for the last seven days, ${formatDuration(weekTotal)} total`}>
            {weekActivity.map(({ day, minutes: dayMinutes }) => {
              const peak = Math.max(45, ...weekActivity.map((item) => item.minutes));
              return (
                <div className="rail-day" key={dayKey(day.getTime())} title={`${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(day)}: ${dayMinutes} minutes`}>
                  <span className="rail-bar-track"><span style={{ height: `${dayMinutes ? Math.max(5, dayMinutes / peak * 100) : 0}%` }} /></span>
                  <span className={`rail-day-label ${dayKey(day.getTime()) === dayKey(Date.now()) ? "today" : ""}`}>
                    {new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(day)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="rail-footnote">{weekTotal ? "Completed focus sessions, day by day." : "Your first session will light the way."}</p>
        </aside>
      </div>

      <footer className="forge-footer">
        <span className="footer-status"><span className={timer.running ? "status-dot active" : "status-dot"} />{timer.running ? "Focus session in progress" : "Your focus stays on this device"}</span>
        <span className="footer-divider" />
        {saveStatus !== "idle" && (
          <span className={`save-indicator ${saveStatus}`} role="status" aria-live="polite">
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved locally" : "Couldn’t save locally"}
          </span>
        )}
        {saveStatus !== "idle" && <span className="footer-divider save-divider" />}
        <button onClick={() => setPanel("progress")}>Today <span>{todaySessions.length} {todaySessions.length === 1 ? "session" : "sessions"}</span><span className="footer-arrow">↗</span></button>
      </footer>

      {panel && (
        <div className="panel-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
          <section className={`side-panel ${panel === "progress" ? "progress-panel" : "settings-panel"}`} role="dialog" aria-modal="true" aria-labelledby="panel-title">
            <div className="panel-heading">
              <div>
                <span className="panel-eyebrow">{panel === "progress" ? "YOUR MOMENTUM" : "MAKE IT YOURS"}</span>
                <h2 id="panel-title">{panel === "progress" ? "Focus progress" : "Settings"}</h2>
              </div>
              <button className="panel-close" onClick={() => setPanel(null)} aria-label="Close panel"><Icon name="close" /></button>
            </div>
            {panel === "progress" ? (
              <>
                <div className="progress-metrics">
                  <div className="progress-metric"><span>FOCUS TODAY</span><strong>{formatDuration(todayMinutes)}</strong></div>
                  <div className="progress-metric"><span>SESSIONS TODAY</span><strong>{todaySessions.length}</strong></div>
                  <div className="progress-metric"><span>THIS WEEK</span><strong>{formatDuration(weekTotal)}</strong></div>
                  <div className="progress-metric"><span>CURRENT STREAK</span><strong>{currentStreak(data.sessions)} <small>{currentStreak(data.sessions) === 1 ? "day" : "days"}</small></strong></div>
                </div>
                <div className="activity-section">
                  <div className="activity-heading"><h3>Last seven days</h3><span>FOCUS MINUTES</span></div>
                  <div className="activity-chart" role="img" aria-label="Completed focus minutes for the last seven days">
                    {weekActivity.map(({ day, minutes: dayMinutes }) => (
                      <div className="activity-day" key={dayKey(day.getTime())}>
                        <span className="activity-value">{dayMinutes || ""}</span>
                        <div className="activity-track"><span style={{ height: `${dayMinutes ? Math.max(6, Math.min(100, dayMinutes / Math.max(60, ...weekActivity.map((item) => item.minutes)) * 100)) : 0}%` }} /></div>
                        <span className={`activity-label ${dayKey(day.getTime()) === dayKey(Date.now()) ? "today" : ""}`}>
                          {new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(day)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="progress-note">Only completed focus sessions count toward your progress.</p>
              </>
            ) : (
              <>
                <p className="settings-intro">A few small choices to make your focus rhythm feel right.</p>
                <div className="settings-fields">
                  {(["focus", "short", "long"] as Mode[]).map((mode) => (
                    <div className="setting-duration" key={mode}>
                      <span><strong>{mode === "focus" ? "Focus duration" : MODE_NAMES[mode]}</strong><small>1 second–{LIMITS[mode]} minutes</small></span>
                      <DurationInputs
                        value={durationDraftsState[mode]}
                        onChange={(part, value) => updateDurationDraft(mode, part, value)}
                        onCommit={() => saveSettingDuration(mode)}
                        prefix={MODE_NAMES[mode]}
                      />
                    </div>
                  ))}
                </div>
                {settingDurationError && <p className="setting-error" role="alert">{settingDurationError}</p>}
                <label className="notification-setting">
                  <span><strong>Completion sound</strong><small>Play a gentle chime when the timer ends.</small></span>
                  <input
                    type="checkbox"
                    checked={data.settings.completionSound}
                    onChange={(event) => setData((previous) => ({
                      ...previous,
                      settings: { ...previous.settings, completionSound: event.target.checked },
                    }))}
                  />
                </label>
                {soundMessage && <p className="setting-error" role="status">{soundMessage}</p>}
                <label className="notification-setting">
                  <span><strong>Completion notifications</strong><small>Show a browser notification when a timer ends.</small></span>
                  <input type="checkbox" checked={data.settings.completionNotifications} onChange={toggleNotifications} />
                </label>
                {notificationMessage && <p className="setting-error" role="status">{notificationMessage}</p>}
                <p className="settings-privacy"><Icon name="spark" size={15} /> Your timer and session history stay in this browser.</p>
                <span className="forge-watermark settings-watermark">Built by <span className="watermark-name">Pounar</span></span>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
