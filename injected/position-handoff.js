// Carries the viewer's position across a page reload that the extension
// requests for a quality change. This runs in the page's own world because the
// player's ad state (video.player.isAd) is invisible to the content script.
const RESUME_KEY = 'pqiIndexedResume';
const MAX_AGE_MS = 120000;
const RESTORE_EVENTS = ['loadedmetadata', 'canplay', 'playing', 'timeupdate'];

const isAd = video => video.player?.isAd === true;

// Save the program video's position. Nothing is saved during an ad, where the
// element's time does not describe the program; the site's own resume applies.
export function savePlaybackPosition() {
  try {
    const video = Array.from(document.querySelectorAll('video')).find(item =>
      Number(item.videoHeight) > 0 && !isAd(item));
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({
      path: window.location.pathname, time: video.currentTime, duration: video.duration,
      paused: video.paused, savedAt: Date.now()
    }));
    return true;
  } catch { return false; }
}

function consumeSavedPosition() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(RESUME_KEY));
    window.sessionStorage.removeItem(RESUME_KEY);
    return saved && saved.path === window.location.pathname && Number.isFinite(saved.time) &&
      Number.isFinite(saved.duration) && saved.duration > 0 && Number.isFinite(saved.savedAt) &&
      Date.now() - saved.savedAt <= MAX_AGE_MS ? saved : null;
  } catch { return null; }
}

// Restore once, on the same program (matched by duration), and only while the
// program rather than an ad is showing. A stream that opens with an ad raises
// no further load events when the program begins, so playback events count too.
export function restorePlaybackPosition() {
  const saved = consumeSavedPosition();
  if (!saved) return;
  const stop = () => RESTORE_EVENTS.forEach(type => document.removeEventListener(type, restore, true));
  function restore(event) {
    if (Date.now() - saved.savedAt > MAX_AGE_MS) { stop(); return; }
    const video = event.target;
    if (video?.tagName !== 'VIDEO' || isAd(video) || !Number.isFinite(video.duration) ||
        Math.abs(video.duration - saved.duration) > 2 || video.readyState < 1) return;
    stop();
    video.currentTime = Math.max(0, Math.min(saved.time, video.duration - 0.1));
    if (saved.paused) {
      video.pause();
      // Some players autoplay after metadata, so retain the paused state
      // through the first playing event after the restored seek.
      const keepPaused = () => video.pause();
      video.addEventListener('playing', keepPaused, { once: true });
      setTimeout(() => video.removeEventListener('playing', keepPaused), 2000);
    } else {
      Promise.resolve(video.play()).catch(() => {});
    }
  }
  RESTORE_EVENTS.forEach(type => document.addEventListener(type, restore, true));
}
