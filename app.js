const appEl = document.getElementById("app");
const timerEl = document.getElementById("timer");
const ringProgressEl = document.getElementById("ringProgress");
const RING_LEN = 2 * Math.PI * 44;
ringProgressEl.setAttribute("stroke-dasharray", `${RING_LEN} ${RING_LEN}`);
ringProgressEl.style.strokeDashoffset = String(RING_LEN);
const secondsEl = document.getElementById("seconds");
const phaseLabelEl = document.getElementById("phaseLabel");
const workoutInput = document.getElementById("workoutInput");
const restInput = document.getElementById("restInput");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const workoutMinus = document.getElementById("workoutMinus");
const workoutPlus = document.getElementById("workoutPlus");
const restMinus = document.getElementById("restMinus");
const restPlus = document.getElementById("restPlus");

const PHASE_WORKOUT = "workout";
const PHASE_REST = "rest";
const MIN_DURATION_SEC = 5;
const WORKOUT_BAND_PALETTE = [
  "#ff69b4",
  "#2187f3",
  "#ffcb00",
  "#9d84cb",
  "#2c9323",
  "#fd6f37",
  "#ff0024",
];
let workoutPaletteIndex = null;

function normalizeHex(hex) {
  return String(hex || "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
}

function canonicalBandHex(hex) {
  const n = normalizeHex(hex);
  return n.length === 6 ? `#${n}` : String(hex);
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((x) => {
      const n = Math.round(Math.max(0, Math.min(255, x)));
      const s = n.toString(16);
      return s.length === 1 ? `0${s}` : s;
    })
    .join("")}`;
}

function blendHex(bg, fg, t) {
  const A = hexToRgb(bg);
  const B = hexToRgb(fg);
  return rgbToHex(
    A.r + (B.r - A.r) * t,
    A.g + (B.g - A.g) * t,
    A.b + (B.b - A.b) * t
  );
}

const KETTLEBELL_PAGE_HEX = "#181818";

function syncBrowserChrome() {
  function upsertThemeColor(mediaAttr) {
    const metas = [...document.head.querySelectorAll('meta[name="theme-color"]')];
    const match = (m) =>
      mediaAttr == null ? !m.hasAttribute("media") : m.getAttribute("media") === mediaAttr;
    let el = metas.find(match);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("name", "theme-color");
      if (mediaAttr != null) el.setAttribute("media", mediaAttr);
      document.head.appendChild(el);
    }
    el.setAttribute("content", KETTLEBELL_PAGE_HEX);
  }

  upsertThemeColor(null);
  upsertThemeColor("(prefers-color-scheme: light)");
  upsertThemeColor("(prefers-color-scheme: dark)");
}

function pickRandomWorkoutIndex(excludeIdx) {
  const n = WORKOUT_BAND_PALETTE.length;
  if (!Number.isInteger(excludeIdx) || excludeIdx < 0 || excludeIdx >= n) {
    return Math.floor(Math.random() * n);
  }
  if (n <= 1) return 0;
  let j = Math.floor(Math.random() * (n - 1));
  if (j >= excludeIdx) j += 1;
  return j;
}

function applyWorkoutThemeFromHex(hex, knownIndex = null) {
  const canonical = canonicalBandHex(hex);
  const { r, g, b } = hexToRgb(canonical);
  const idx = Number.isInteger(knownIndex) ? knownIndex : WORKOUT_BAND_PALETTE.indexOf(canonical);
  workoutPaletteIndex = idx >= 0 ? idx : workoutPaletteIndex;
  const root = document.documentElement;
  root.style.setProperty("--workout-accent", canonical);
  root.style.setProperty("--workout-accent-rgb", `${r} ${g} ${b}`);
  root.style.setProperty("--workout-text-strong", blendHex("#ffffff", canonical, 0.18));
  root.style.setProperty("--workout-stepper-bg", `rgba(${r},${g},${b},0.2)`);
  root.style.setProperty("--workout-stepper-active", `rgba(${r},${g},${b},0.34)`);
  syncBrowserChrome();
}

function getInputValue(input, fallback) {
  const value = Number.parseInt(input.value, 10);
  return Number.isFinite(value) && value >= MIN_DURATION_SEC ? value : fallback;
}

/** Hidden-tab cadence; visible mode uses requestAnimationFrame for display-synced ring motion. */
const HIDDEN_TICK_MS = 1000;

let phase = PHASE_WORKOUT;
let phaseDuration = getInputValue(workoutInput, 30);
let remaining = phaseDuration;
let running = false;
let timerTickId = null;
let rafId = null;
let endTimeMs = 0;
/** Avoid rewriting `secondsEl` when the displayed integer has not changed. */
let lastRenderedCeilSec = null;
/** Skip redundant `strokeDashoffset` writes when quantized value unchanged (fewer style commits). */
let lastRingDashKey = null;
let audioCtx = null;
const beepBufferCache = new Map();
let beepedSecond = null;
let wakeLock = null;
let hasStarted = false;

function updateStartButton() {
  document.body.classList.toggle("has-started", hasStarted);
  if (!hasStarted) {
    startBtn.textContent = "Start";
  } else if (running) {
    startBtn.textContent = "Pause";
  } else {
    startBtn.textContent = "Resume";
  }
}

function updateDurationControlsLock() {
  const locked = hasStarted;
  workoutInput.disabled = locked;
  restInput.disabled = locked;
  workoutMinus.disabled = locked;
  workoutPlus.disabled = locked;
  restMinus.disabled = locked;
  restPlus.disabled = locked;
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function applyDurationInputChange(input) {
  if (hasStarted) return;
  if (input === workoutInput && phase === PHASE_WORKOUT && !running) {
    setPhase(PHASE_WORKOUT);
  }
  if (input === restInput && phase === PHASE_REST && !running) {
    setPhase(PHASE_REST);
  }
}

function stepDuration(input, delta) {
  if (hasStarted) return;
  const fallback = 30;
  let next = getInputValue(input, fallback) + delta;
  if (next < MIN_DURATION_SEC) next = MIN_DURATION_SEC;
  input.value = String(next);
  applyDurationInputChange(input);
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function beep(duration, frequency, gain, fadeOut) {
  const ctx = ensureAudioContext();

  const play = () => {
    if (ctx.state !== "running") return;
    const sr = ctx.sampleRate;
    const attack = 0.008;
    const release = fadeOut ? 0.08 : 0.016;
    const key = [duration, frequency, gain, fadeOut].join("|");
    let buffer = beepBufferCache.get(key);

    if (!buffer) {
      const sampleCount = Math.max(1, Math.floor(duration * sr));
      buffer = ctx.createBuffer(1, sampleCount, sr);
      const data = buffer.getChannelData(0);
      const attackSamples = Math.max(1, Math.floor(attack * sr));
      const releaseSamples = Math.max(1, Math.floor(release * sr));
      const sustainEnd = Math.max(0, sampleCount - releaseSamples);
      const twoPiF = 2 * Math.PI * frequency;

      for (let i = 0; i < sampleCount; i += 1) {
        let env = 1;
        if (i < attackSamples) {
          env = i / attackSamples;
        } else if (i >= sustainEnd) {
          env = (sampleCount - 1 - i) / releaseSamples;
        }
        env = Math.max(0, Math.min(1, env));
        data[i] = Math.sin((twoPiF * i) / sr) * gain * env;
      }
      data[0] = 0;
      data[sampleCount - 1] = 0;
      beepBufferCache.set(key, buffer);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(ctx.currentTime + 0.003);
  };

  if (ctx.state === "running") {
    play();
    return;
  }
  void ctx.resume().then(play);
}

function setPhase(nextPhase) {
  phase = nextPhase;
  phaseDuration = phase === PHASE_WORKOUT
    ? getInputValue(workoutInput, 30)
    : getInputValue(restInput, 30);
  remaining = phaseDuration;
  beepedSecond = null;
  updateUI();
}

function switchPhase() {
  const next = phase === PHASE_WORKOUT ? PHASE_REST : PHASE_WORKOUT;
  if (next === PHASE_WORKOUT) {
    const nextIdx = pickRandomWorkoutIndex(workoutPaletteIndex);
    applyWorkoutThemeFromHex(WORKOUT_BAND_PALETTE[nextIdx], nextIdx);
  }
  setPhase(next);
  if (running) {
    endTimeMs = performance.now() + remaining * 1000;
  }
}

function syncPhaseChrome() {
  timerEl.classList.add("workout");
  document.body.classList.toggle("phase-workout", phase === PHASE_WORKOUT);
  document.body.classList.toggle("phase-rest", phase === PHASE_REST);
  const label = phase === PHASE_WORKOUT ? "Workout" : "Rest";
  if (phaseLabelEl.textContent !== label) {
    phaseLabelEl.textContent = label;
  }
}

function syncRingFromRemaining() {
  const doneRatio = 1 - (remaining / phaseDuration);
  const p = Math.max(0, Math.min(1, doneRatio));
  const off = RING_LEN * (1 - p);
  const key = off.toFixed(2);
  if (key === lastRingDashKey) return;
  lastRingDashKey = key;
  ringProgressEl.style.strokeDashoffset = key;
}

function updateUI() {
  syncPhaseChrome();
  const shown = Math.max(0, Math.ceil(remaining));
  secondsEl.textContent = String(shown);
  lastRenderedCeilSec = shown;
  lastRingDashKey = null;
  syncRingFromRemaining();
}

function clearScheduler() {
  if (timerTickId !== null) {
    clearTimeout(timerTickId);
    timerTickId = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function finishPhase() {
  beep(0.7, 990, 0.16, false);
  switchPhase();
  if (running) {
    scheduleNextTick();
  }
}

function tick() {
  if (!running) return;
  const now = performance.now();
  remaining = Math.max(0, (endTimeMs - now) / 1000);
  const shown = Math.max(0, Math.ceil(remaining));

  if (shown !== beepedSecond) {
    if (shown >= 1 && shown <= 3) {
      beep(0.25, 990, 0.16, true);
    }
    beepedSecond = shown;
  }

  syncRingFromRemaining();
  if (shown !== lastRenderedCeilSec) {
    secondsEl.textContent = String(shown);
    lastRenderedCeilSec = shown;
  }

  if (remaining <= 0) {
    finishPhase();
    return;
  }

  if (!running) return;
  scheduleNextTick();
}

function scheduleNextTick() {
  if (!running) return;
  if (document.hidden) {
    const msLeft = endTimeMs - performance.now();
    const delay = msLeft <= 0 ? 0 : Math.min(HIDDEN_TICK_MS, Math.max(8, msLeft));
    timerTickId = setTimeout(tick, delay);
    return;
  }
  rafId = requestAnimationFrame(() => {
    rafId = null;
    tick();
  });
}

function startTimer() {
  if (running) return;
  hasStarted = true;
  running = true;
  const ctx = ensureAudioContext();
  void acquireWakeLock();
  updateStartButton();
  updateDurationControlsLock();
  void ctx.resume().then(() => {
    if (!running) return;
    endTimeMs = performance.now() + remaining * 1000;
    clearScheduler();
    scheduleNextTick();
  });
}

function pauseTimer() {
  if (!running) return;
  remaining = Math.max(0, (endTimeMs - performance.now()) / 1000);
  running = false;
  clearScheduler();
  lastRingDashKey = null;
  syncRingFromRemaining();
  const shown = Math.max(0, Math.ceil(remaining));
  secondsEl.textContent = String(shown);
  lastRenderedCeilSec = shown;
  if (audioCtx && audioCtx.state === "running") {
    void audioCtx.suspend();
  }
  updateStartButton();
}

function resetTimer() {
  pauseTimer();
  hasStarted = false;
  void releaseWakeLock();
  setPhase(PHASE_WORKOUT);
  updateStartButton();
  updateDurationControlsLock();
}

function toggleStartPause() {
  if (running) {
    pauseTimer();
  } else {
    startTimer();
  }
}

let viewportLocked = false;
/** px height on <html> for the rest of the session (body fills via absolute inset). */
let lockedViewportHeightPx = null;

const VIEWPORT_STABLE_FRAMES = 4;
const VIEWPORT_STABLE_MAX_MS = 600;
/** Extra wait after height stops changing before we lock (iOS second layout pass). */
const VIEWPORT_POST_STABLE_MS = 120;

function readViewportHeight() {
  return window.visualViewport?.height ?? window.innerHeight;
}

function applyLockedViewportHeight(px) {
  document.documentElement.style.height = `${px}px`;
  document.body.style.height = "";
}

function lockViewportHeight(px) {
  lockedViewportHeightPx = px;
  applyLockedViewportHeight(px);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until visualViewport height is unchanged for several frames. */
async function waitForStableViewportHeight() {
  const start = performance.now();
  let last = -1;
  let stableFrames = 0;

  while (performance.now() - start < VIEWPORT_STABLE_MAX_MS) {
    await new Promise(requestAnimationFrame);
    const h = Math.round(readViewportHeight());
    if (h === last) {
      stableFrames += 1;
      if (stableFrames >= VIEWPORT_STABLE_FRAMES) {
        await delay(VIEWPORT_POST_STABLE_MS);
        return Math.round(readViewportHeight());
      }
    } else {
      last = h;
      stableFrames = 1;
    }
  }

  return Math.round(readViewportHeight());
}

/** Kettlebell black background visible; lock only after viewport settles, then fade in #app. */
async function stabilizeViewport() {
  if (viewportLocked) {
    if (lockedViewportHeightPx !== null) applyLockedViewportHeight(lockedViewportHeightPx);
    return;
  }

  appEl?.classList.remove("ready");

  lockViewportHeight(await waitForStableViewportHeight());

  appEl?.offsetHeight;
  appEl?.classList.add("ready");
  viewportLocked = true;
}

window.addEventListener("pageshow", () => {
  if (!viewportLocked) {
    void stabilizeViewport();
  } else if (lockedViewportHeightPx !== null) {
    applyLockedViewportHeight(lockedViewportHeightPx);
  }

  if (hasStarted) {
    void acquireWakeLock();
  }
  if (running) {
    if (audioCtx) void audioCtx.resume();
    remaining = Math.max(0, (endTimeMs - performance.now()) / 1000);
    clearScheduler();
    scheduleNextTick();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (hasStarted) {
      void acquireWakeLock();
    }
    if (running) {
      if (audioCtx) void audioCtx.resume();
      remaining = Math.max(0, (endTimeMs - performance.now()) / 1000);
      clearScheduler();
      scheduleNextTick();
    }
  } else {
    if (hasStarted) {
      void releaseWakeLock();
    }
    if (running) {
      clearScheduler();
      scheduleNextTick();
    }
  }
});

startBtn.addEventListener("click", toggleStartPause);
resetBtn.addEventListener("click", resetTimer);

workoutInput.addEventListener("change", () => applyDurationInputChange(workoutInput));
restInput.addEventListener("change", () => applyDurationInputChange(restInput));

workoutMinus.addEventListener("click", () => stepDuration(workoutInput, -5));
workoutPlus.addEventListener("click", () => stepDuration(workoutInput, 5));
restMinus.addEventListener("click", () => stepDuration(restInput, -5));
restPlus.addEventListener("click", () => stepDuration(restInput, 5));

const initialIdx = Math.floor(Math.random() * WORKOUT_BAND_PALETTE.length);
applyWorkoutThemeFromHex(WORKOUT_BAND_PALETTE[initialIdx], initialIdx);
updateUI();
updateStartButton();
updateDurationControlsLock();
void stabilizeViewport();
