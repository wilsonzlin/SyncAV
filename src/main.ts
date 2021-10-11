import assertState from "@xtjs/lib/js/assertState";
import asyncTimeout from "@xtjs/lib/js/asyncTimeout";
import Dict from "@xtjs/lib/js/Dict";

type EventName =
  | "durationchange"
  | "error"
  | "loadedmetadata"
  | "playbackchange"
  | "reconciliationstatechange"
  | "seekchange"
  | "timeupdate"
  | "volumechange";

// Up to 30 seconds.
// TODO Is this necessary? Is this fair for slower connections?
const MAX_RECONCILE_ATTEMPTS = 10 * 30;

export enum ReconciliationState {
  IDLE,
  RUNNING,
  FAILED,
}

// This implementation is prone to infinite loops, due to the fact that we don't have full control: the system, browser, and user can do things that we can only react to. To prevent, ensure there are no tug-of-wars:
// - Feel free to pause whenever and without checking, but don't play without checking state.
//   - Setting currentTime or calling play() always emits events that may trigger a sync, which may update currentTime and/or call play().
// - Having the secondary always react to the primary would be great, but that would leave open the chance of secondary being out-of-sync from external triggers.
// - Events don't occur immediately. play() and pause() don't occur immediately. Be aware of accidental interleaving loops.
// - We can never be certain where a "paused" event comes from, since events are asynchronous (i.e. could come anytime) and "paused" is emitted when we call .pause(), when the system pauses, when the browser pauses, etc. Sometimes they don't emit if play() is caused quickly after pause() etc.
// - Not all timestamp values can be set (e.g. frametimes, sampling rates), so don't wait for primary and secondary currentTime values to match exactly.
// We used to use multiple separate event-driven sync functions. This became unwieldy and caused infinite loops. Now we use a single "reconcile" function, such that any external events all trigger a single-instance function that continuously runs until the current state matches the desired state. This is much more reliable due to its simplicity; however, it's still possible for it to cause infinite loops, so be vigilant.
export class SyncAV {
  private readonly primary: HTMLVideoElement = document.createElement("video");
  private readonly secondary: HTMLAudioElement =
    document.createElement("audio");
  private readonly eventListeners = new Dict<string, Set<() => void>>();
  private _userPaused = true;
  // We implement this to allow consumer of this class to pause video while seeking without showing paused state, which is a common UI design.
  private userSeeking = false;
  private _reconciliationState = ReconciliationState.IDLE;
  private expectingPrimaryPause = false;
  private expectingSecondaryPause = false;
  // We need this in case a load() is required during reconciliation, which resets the currentTime to zero.
  private goalCurrentTime: number | undefined;

  private get userPaused() {
    return this._userPaused;
  }

  private set userPaused(newVal: boolean) {
    const willChange = this.userPaused !== newVal;
    this._userPaused = newVal;
    if (willChange) this.callEventListeners("playbackchange");
  }

  private get reconciliationState() {
    return this._reconciliationState;
  }

  private set reconciliationState(newVal: ReconciliationState) {
    const willChange = this.reconciliationState !== newVal;
    this._reconciliationState = newVal;
    if (willChange) this.callEventListeners("reconciliationstatechange");
  }

  private get primaryLoaded() {
    return !!this.primary.src;
  }

  private get secondaryLoaded() {
    return !!this.secondary.src;
  }

  // TODO Stop on errors, but not expected errors caused while reconciling (e.g. aborted playback due to expected pause).
  private reconcile = async () => {
    if (this.reconciliationState === ReconciliationState.RUNNING) {
      return;
    }
    console.debug("[SyncAV] Reconciling...");
    this.reconciliationState = ReconciliationState.RUNNING;
    const { primary, secondary } = this;
    const pauseExpectedly = () => {
      let altered = false;
      if (!primary.paused) {
        console.debug("[SyncAV] Primary is not paused, expectedly pausing...");
        this.expectingPrimaryPause = true;
        primary.pause();
        altered = true;
      }
      if (this.secondaryLoaded && !secondary.paused) {
        console.debug(
          "[SyncAV] Secondary is not paused, expectedly pausing..."
        );
        this.expectingSecondaryPause = true;
        secondary.pause();
        altered = true;
      }
      return altered;
    };
    const syncCurrentTime = () => {
      // TODO Should we check readyState? Is it possible that seeking will throw an exception?
      if (
        this.goalCurrentTime != undefined &&
        Math.abs(this.goalCurrentTime - this.primary.currentTime) > 0.05
      ) {
        this.primary.currentTime = this.goalCurrentTime;
      }
      if (
        this.secondaryLoaded &&
        Math.abs(this.primary.currentTime - this.secondary.currentTime) > 0.05
      ) {
        console.debug(
          "[SyncAV] Synchronising currentTime to",
          this.primary.currentTime
        );
        this.secondary.currentTime = this.primary.currentTime;
        return true;
      }
      return false;
    };
    let attempts = 0;
    let loadAttempts = 0;
    for (
      ;
      attempts <= MAX_RECONCILE_ATTEMPTS;
      attempts++, await asyncTimeout(100)
    ) {
      if (attempts == MAX_RECONCILE_ATTEMPTS) {
        console.debug(
          "[SyncAV] Reached maximum reconcile attempts, setting userPaused"
        );
        this.userPaused = true;
        this.reconciliationState = ReconciliationState.FAILED;
        break;
      }
      if (this.userPaused || this.userSeeking) {
        // If a stream wasn't paused and is pause(), check again in another iteration.
        if (!pauseExpectedly()) {
          break;
        }
        loadAttempts = 0;
      } else {
        if (!this.primaryLoaded) {
          // There's nothing loaded; if we proceed, we'll be waiting forever because readyState will never change.
          console.debug(
            "[SyncAV] No primary source loaded, setting userPaused"
          );
          this.userPaused = true;
          loadAttempts = 0;
          continue;
        }
        if (primary.ended) {
          // We've ended, and we desire to play, so we need to restart (otherwise, we'll wait for readyState forever).
          console.debug("[SyncAV] Primary ended, resetting currentTime");
          primary.currentTime = 0;
          loadAttempts = 0;
        }
        if (syncCurrentTime()) {
          loadAttempts = 0;
          continue;
        }
        // WARNING: `preload` must be "auto", as otherwise this could be HAVE_METADATA forever when changing sources.
        if (
          primary.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
          (this.secondaryLoaded &&
            secondary.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
        ) {
          console.debug(
            "[SyncAV] Not ready:",
            primary.readyState,
            secondary.readyState
          );
          // Call load() if readyState still hasn't changed after 2 seconds. Only do this once; if it still gets stuck afterwards, it's most likely a network or server issue.
          // 2 seconds may sound short, but if we're here, the readyState is at best HAVE_CURRENT_DATA i.e. exactly one frame. This is most likely caused by being stuck and not a network issue. This also happens often, especially while seeking, so if we wait for 3+ seconds every time, it might make for a bad user experience.
          if (++loadAttempts === 20) {
            console.debug(
              "[SyncAV] Waited for readyState to change for",
              loadAttempts,
              "iterations, calling load()..."
            );
            primary.load();
            secondary.load();
          }
          pauseExpectedly();
          continue;
        }
        loadAttempts = 0;
        let altered = false;
        if (this.primary.paused) {
          console.debug("[SyncAV] Primary is paused, expectedly playing...");
          // Cancel any expected pause.
          this.expectingPrimaryPause = false;
          this.primary.play();
          altered = true;
        }
        if (this.secondaryLoaded && this.secondary.paused) {
          console.debug("[SyncAV] Secondary is paused, expectedly playing...");
          // Cancel any expected pause.
          this.expectingSecondaryPause = false;
          this.secondary.play();
          altered = true;
        }
        if (!altered) {
          break;
        }
      }
    }
    this.reconciliationState = ReconciliationState.IDLE;
    this.goalCurrentTime = undefined;
  };

  constructor() {
    const { primary, secondary } = this;

    for (const e of ["canplay", "canplaythrough", "stalled", "waiting"]) {
      primary.addEventListener(e, this.reconcile);
      secondary.addEventListener(e, this.reconcile);
    }

    // Handle external triggers of pausing on either stream.
    primary.addEventListener("pause", () => {
      if (this.expectingPrimaryPause) {
        this.expectingPrimaryPause = false;
      } else {
        console.debug(`[SyncAV] Pause triggered from primary`);
        this.pause();
      }
    });
    secondary.addEventListener("pause", () => {
      if (this.expectingSecondaryPause) {
        this.expectingSecondaryPause = false;
      } else {
        console.debug(`[SyncAV] Pause triggered from secondary`);
        this.pause();
      }
    });

    // Handle external triggers of playing on either stream.
    primary.addEventListener("play", () => {
      console.debug(`[SyncAV] Play triggered from primary`);
      // It's already playing, so any expected pause will not happen (unless there's some extremely rare race condition due to async out-of-order events).
      this.expectingPrimaryPause = false;
      this.play();
    });
    secondary.addEventListener("play", () => {
      console.debug(`[SyncAV] Play triggered from secondary`);
      // It's already playing, so any expected pause will not happen (unless there's some extremely rare race condition due to async out-of-order events).
      this.expectingSecondaryPause = false;
      this.play();
    });

    primary.addEventListener("durationchange", () =>
      this.callEventListeners("durationchange")
    );
    primary.addEventListener("ended", () => (this.userPaused = true));
    const maybeEmitLoadedMetadata = () => {
      if (
        !this.secondaryLoaded ||
        (this.primary.readyState >= HTMLMediaElement.HAVE_METADATA &&
          this.secondary.readyState >= HTMLMediaElement.HAVE_METADATA)
      ) {
        this.callEventListeners("loadedmetadata");
      }
    };
    primary.addEventListener("loadedmetadata", maybeEmitLoadedMetadata);
    secondary.addEventListener("loadedmetadata", maybeEmitLoadedMetadata);
    primary.addEventListener("seeking", () =>
      this.callEventListeners("seekchange")
    );
    primary.addEventListener("seeked", () =>
      this.callEventListeners("seekchange")
    );
    primary.addEventListener("timeupdate", () => {
      if (!this.userSeeking) {
        this.callEventListeners("timeupdate");
      }
    });
    primary.addEventListener("volumechange", () =>
      this.callEventListeners("volumechange")
    );
    primary.addEventListener("error", () => this.callEventListeners("error"));
    secondary.addEventListener("error", () => this.callEventListeners("error"));

    this.primary.autoplay = false;
    this.secondary.autoplay = false;
    this.primary.controls = false;
    // This is needed in order for reconciler to work if sources are changed, as otherwise they could be stuck on HAVE_METADATA forever.
    this.primary.preload = "auto";
    this.secondary.preload = "auto";
  }

  get currentTime() {
    return this.primary.currentTime;
  }

  get duration() {
    return this.primary.duration;
  }

  get element() {
    return this.primary;
  }

  get ended() {
    return this.primary.ended;
  }

  get error() {
    return this.primary.error ?? this.secondary.error;
  }

  get muted() {
    return this.primary.muted;
  }

  get paused() {
    return this.userPaused;
  }

  get seeking() {
    return this.primary.seeking;
  }

  get volume() {
    return this.primary.volume;
  }

  set currentTime(timestamp: number) {
    this.goalCurrentTime = timestamp;
    this.reconcile();
  }

  set muted(muted: boolean) {
    this.primary.muted = muted;
    this.secondary.muted = muted;
  }

  set volume(volume: number) {
    this.primary.volume = volume;
    this.secondary.volume = volume;
  }

  startUserSeeking() {
    this.userSeeking = true;
    this.reconcile();
  }

  endUserSeeking() {
    this.userSeeking = false;
    this.reconcile();
  }

  off(type: EventName, listener: () => void) {
    this.eventListeners.computeIfAbsent(type, () => new Set()).delete(listener);
  }

  on(type: EventName, listener: () => void) {
    this.eventListeners.computeIfAbsent(type, () => new Set()).add(listener);
  }

  once(type: EventName, listener: () => void) {
    const remove = () =>
      void this.eventListeners
        .computeIfAbsent(type, () => new Set())
        .delete(wrapped);
    const wrapped = () => {
      listener();
      remove();
    };
    this.eventListeners.computeIfAbsent(type, () => new Set()).add(wrapped);
    return remove;
  }

  pause() {
    console.debug("[SyncAV] pause() called");
    this.userPaused = true;
    this.reconcile();
  }

  play() {
    console.debug("[SyncAV] play() called");
    // userPaused should always be set even if no source loaded; this way, when
    // source loads, it starts playing automatically.
    this.userPaused = false;
    this.reconcile();
  }

  setSource(
    primary: string | null | undefined,
    secondary: string | null | undefined
  ) {
    console.debug("[SyncAV] Updating sources:", primary, secondary);
    assertState(!!primary || !secondary);
    const setSrc = (elem: HTMLMediaElement, val: string | null | undefined) => {
      if (val) {
        elem.src = val;
        // Sometimes, the browser doesn't automatically load, despite the preload setting, causing reconciler to stall forever on waiting for readyState to change.
        elem.load();
      } else {
        // Chrome requires setting property to empty string.
        elem.src = "";
        // Firefox requires removing attribute.
        elem.removeAttribute("src");
      }
    };
    setSrc(this.primary, primary);
    setSrc(this.secondary, secondary);
  }

  private callEventListeners(type: EventName) {
    console.debug("[SyncAV] Emitting", type);
    this.eventListeners
      .computeIfAbsent(type, () => new Set())
      .forEach((l) => l());
  }
}

if (typeof window == "object") {
  (window as any).SyncAV = SyncAV;
}
