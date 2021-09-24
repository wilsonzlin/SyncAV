import assertState from "extlib/js/assertState";
import Dict from "extlib/js/Dict";

type EventName =
  | "durationchange"
  | "error"
  | "loadedmetadata"
  | "playbackchange"
  | "seekchange"
  | "timeupdate"
  | "volumechange";
type PauseReason = "userSeeking" | "syncing";

export class SyncAV {
  private readonly primary: HTMLVideoElement = document.createElement("video");
  private readonly eventListeners = new Dict<string, Set<() => void>>();
  private readonly secondary: HTMLAudioElement =
    document.createElement("audio");
  private readonly pauseReasons = new Set<PauseReason>();
  private primaryLoaded: boolean = false;
  private secondaryLoaded: boolean = false;
  private userPaused: boolean = true;

  constructor() {
    const { primary, secondary } = this;

    const sync = (e: Event) => {
      console.debug(
        `[SyncAV] Sync triggered due to event ${e.type} on ${e.target?.constructor.name}`
      );
      if (!this.secondaryLoaded) {
        return;
      }
      if (
        primary.readyState !== HTMLMediaElement.HAVE_ENOUGH_DATA ||
        secondary.readyState !== HTMLMediaElement.HAVE_ENOUGH_DATA
      ) {
        this.addPauseReason("syncing");
      } else {
        this.removePauseReason("syncing");
      }
    };

    for (const e of [
      "canplay",
      "canplaythrough",
      // Do not react to "pause" event, as it might never resolve and update readyState.
      "stalled",
      // Do not react to "suspend" event, as it might cause an infinite loop from pause() => suspend => canplay => sync() => pause() => suspend => ...; stalled and waiting should be enough to capture buffering.
      "waiting",
    ]) {
      primary.addEventListener(e, sync);
      secondary.addEventListener(e, sync);
    }

    // Handle external triggers of pausing on either stream.
    primary.addEventListener("pause", () => secondary.pause());
    secondary.addEventListener("pause", () => primary.pause());

    // NOTE: We don't call this.pause on pause, as that indicates user pausing, and pausing could be done by us instead. However, if media starts playing, then the user pause state must be overriden, as otherwise it would indicate it's paused but it's actually not.
    primary.addEventListener("play", () => this.play());
    secondary.addEventListener("play", () => this.play());

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
      if (!this.pauseReasons.has("userSeeking")) {
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
    this.playIfNotUserPaused();
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
    this.addPauseReason("userSeeking");
  }

  endUserSeeking() {
    this.removePauseReason("userSeeking");
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
    this.primary.pause();
    this.secondary.pause();
    if (willChange) this.callEventListeners("playbackchange");
  }

  play() {
    // userPaused should always be set even if no source loaded; this way, when
    // source loads, it starts playing automatically.
    const willChange = this.userPaused !== false;
    this.userPaused = false;
    this.syncCurrentTime();
    this.pauseReasons.clear();
    this.primary.play();
    this.secondary.play();
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

  private playIfNotUserPaused() {
    if (!this.userPaused) {
      this.play();
    }
  }

  private addPauseReason(reason: PauseReason) {
    this.pauseReasons.add(reason);
    this.primary.pause();
    this.secondary.pause();
  }

  private removePauseReason(reason: PauseReason) {
    this.pauseReasons.delete(reason);
    if (!this.pauseReasons.size) {
      this.playIfNotUserPaused();
    }
  }

  private callEventListeners(type: EventName) {
    this.eventListeners
      .computeIfAbsent(type, () => new Set())
      .forEach((l) => l());
  }

  private syncCurrentTime() {
    // Extra check to ensure times are aligned.
    // NOTE: It might trigger sync => addPauseReason => sync => removePauseReason loop again.
    if (this.secondaryLoaded) {
      console.debug(
        "[SyncAV] Synchronising currentTime to",
        this.primary.currentTime
      );
      this.secondary.currentTime = this.primary.currentTime;
    }
  }
}

if (typeof window == "object") {
  (window as any).SyncAV = SyncAV;
}
