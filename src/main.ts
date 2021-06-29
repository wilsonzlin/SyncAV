import assertState from "extlib/js/assertState";
import Dict from "extlib/js/Dict";

type EventName =
  | "loadedmetadata"
  | "playbackchange"
  | "seekchange"
  | "timechange"
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

  constructor({
    fullSize = false,
  }: {
    fullSize?: boolean;
  } = {}) {
    const { primary, secondary } = this;

    // TODO WARNING External triggers of pause and play must be handled by consumer of this class.
    // External events include:
    // - Media keys.
    // - System GUI controls (e.g. notification playback controls).
    // - System interception (e.g. Android audio focus (see https://developer.android.com/guide/topics/media-apps/audio-focus)).
    // Other than media keys, the only way to determine when the above occur is through `play` and `pause` events, which can't be distinguished from:
    // - User initiated.
    // - Programmatic app logic (sync audio + video, pause while debounced seek).
    const sync = () => {
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

    primary.addEventListener("canplay", sync);
    primary.addEventListener("canplaythrough", sync);
    primary.addEventListener("pause", sync);
    primary.addEventListener("suspend", sync);
    secondary.addEventListener("canplay", sync);
    secondary.addEventListener("canplaythrough", sync);
    secondary.addEventListener("pause", sync);
    secondary.addEventListener("suspend", sync);

    primary.addEventListener("durationchange", () =>
      this.callEventListeners("timechange")
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
        this.callEventListeners("timechange");
      }
    });
    primary.addEventListener("volumechange", () =>
      this.callEventListeners("volumechange")
    );

    this.primary.autoplay = false;
    this.secondary.autoplay = false;
    this.primary.controls = false;
    if (fullSize) {
      this.primary.style.backgroundColor = "#000";
      this.primary.style.width = "100%";
      this.primary.style.height = "100%";
      this.primary.style.objectFit = "contain";
    }
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

  seek(timestamp: number) {
    if (this.primaryLoaded) {
      this.primary.currentTime = timestamp;
    }
    if (this.secondaryLoaded) {
      this.secondary.currentTime = timestamp;
    }
    this.playIfNotUserPaused();
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
    this.userPaused = true;
    this.primary.pause();
    this.secondary.pause();
    this.callEventListeners("playbackchange");
  }

  play() {
    // userPaused should always be set even if no source loaded; this way, when
    // source loads, it starts playing automatically.
    this.userPaused = false;
    this.primary.play();
    this.secondary.play();
    this.callEventListeners("playbackchange");
  }

  setSource(primary: string | undefined, secondary: string | undefined) {
    assertState(!!primary || !secondary);
    const setSrc = (elem: HTMLMediaElement, val: string | undefined) => {
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

  setMuted(muted: boolean) {
    this.primary.muted = muted;
    this.secondary.muted = muted;
  }

  setVolume(volume: number) {
    this.primary.volume = volume;
    this.secondary.volume = volume;
  }

  private playIfNotUserPaused() {
    if (!this.userPaused) {
      this.primary.play();
      this.secondary.play();
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
}
