import assertState from "@xtjs/lib/js/assertState";
import asyncTimeout from "@xtjs/lib/js/asyncTimeout";
import Dict from "@xtjs/lib/js/Dict";

type EventName =
  | "durationchange"
  | "error"
  | "loadedmetadata"
  | "playbackchange"
  | "seekchange"
  | "timeupdate"
  | "volumechange";

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
  private primaryLoaded: boolean = false;
  private secondaryLoaded: boolean = false;
  private readonly eventListeners = new Dict<string, Set<() => void>>();
  private userPaused: boolean = true;
  // We implement this to allow consumer of this class to pause video while seeking without showing paused state, which is a common UI design.
  private userSeeking: boolean = false;
  private reconciling = false;
  private expectingPrimaryPause = false;
  private expectingSecondaryPause = false;

  private reconcile = async () => {
    if (this.reconciling) {
      return;
    }
    this.reconciling = true;
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
    for (; ; await asyncTimeout(50)) {
      if (this.userPaused || this.userSeeking) {
        // If a stream wasn't paused and is pause(), check again in another iteration.
        if (!pauseExpectedly()) {
          break;
        }
      } else {
        if (primary.ended) {
          // We've ended, and we desire to play, so we need to restart (otherwise, we'll wait for readyState forever).
          primary.currentTime = 0;
        }
        if (syncCurrentTime()) {
          continue;
        }
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
          pauseExpectedly();
          continue;
        }
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
    this.reconciling = false;
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
    primary.addEventListener("ended", () => {
      this.userPaused = true;
      this.callEventListeners("playbackchange");
    });
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
    if (this.primaryLoaded) {
      this.primary.currentTime = timestamp;
    }
    // This will set this.secondary.currentTime.
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
    const willChange = this.userPaused !== true;
    this.userPaused = true;
    this.reconcile();
    if (willChange) this.callEventListeners("playbackchange");
  }

  play() {
    // userPaused should always be set even if no source loaded; this way, when
    // source loads, it starts playing automatically.
    const willChange = this.userPaused !== false;
    this.userPaused = false;
    this.reconcile();
    if (willChange) this.callEventListeners("playbackchange");
  }

  setSource(
    primary: string | null | undefined,
    secondary: string | null | undefined
  ) {
    assertState(!!primary || !secondary);
    const setSrc = (elem: HTMLMediaElement, val: string | null | undefined) => {
      if (val) {
        elem.src = val;
      } else {
        // Chrome requires setting property to empty string.
        elem.src = "";
        // Firefox requires removing attribute.
        elem.removeAttribute("src");
      }
    };
    setSrc(this.primary, primary);
    this.primaryLoaded = !!primary;
    setSrc(this.secondary, secondary);
    this.secondaryLoaded = !!secondary;
  }

  private callEventListeners(type: EventName) {
    this.eventListeners
      .computeIfAbsent(type, () => new Set())
      .forEach((l) => l());
  }
}

if (typeof window == "object") {
  (window as any).SyncAV = SyncAV;
}
