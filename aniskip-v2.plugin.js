/**
 * @name AniSkip v2
 * @description Skip anime openings, endings, and recaps automatically or with a premium popup using the AniSkip v2 API and AnimeAPI mappings.
 * @author theguy000
 * @version 1.0.0
 */

(function () {
  console.log("AniSkip v2: Plugin loaded.");

  // Configuration
  const AUTO_SKIP_DELAY = 5000; // time in ms before auto-skipping (0 for instant)
  let activeSegments = [];
  let videoListeners = new Map();
  let popupElement = null;
  let activeVideoElement = null;

  // Inject beautiful modern CSS styles for popup and timeline marks
  const style = document.createElement("style");
  style.textContent = `
    .aniskip-v2-popup {
      position: absolute;
      bottom: 90px;
      right: 24px;
      z-index: 10000;
      background: rgba(18, 18, 26, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 14px 18px;
      width: 310px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
      font-family: 'Outfit', 'Inter', sans-serif;
      color: #fff;
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: aniskip-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      transition: opacity 0.3s ease, transform 0.3s ease;
    }
    @keyframes aniskip-slide-in {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .aniskip-v2-popup .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .aniskip-v2-popup .title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: #e5c158;
      text-transform: uppercase;
    }
    .aniskip-v2-popup .subtitle {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.6);
      line-height: 1.4;
    }
    .aniskip-v2-popup .buttons {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
    .aniskip-v2-popup button {
      flex: 1;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }
    .aniskip-v2-popup .btn-skip {
      background: #e5c158;
      color: #0c0c14;
      border: none;
    }
    .aniskip-v2-popup .btn-skip:hover {
      background: #f3d273;
      transform: translateY(-1px);
    }
    .aniskip-v2-popup .btn-dismiss {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .aniskip-v2-popup .btn-dismiss:hover {
      background: rgba(255, 255, 255, 0.18);
    }
    .aniskip-timeline-mark {
      position: absolute;
      background: rgba(229, 193, 88, 0.75) !important;
      height: 100%;
      border-radius: 2px;
      pointer-events: none;
      z-index: 5;
    }
  `;
  document.head.appendChild(style);

  // Helper: Poll for element
  function pollElement(selector, callback, maxAttempts = 30) {
    let attempts = 0;
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        callback(el);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
      attempts++;
    }, 1000);
  }

  // Format seconds to mm:ss
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  // Fetch translation ID (IMDb/Kitsu -> MAL)
  async function fetchMALId(metaId) {
    console.log("AniSkip v2: Fetching translation for Meta ID:", metaId);
    let url = "";
    if (metaId.startsWith("kitsu:")) {
      const kitsuId = metaId.split(":")[1];
      url = `https://animeapi.my.id/kitsu/${kitsuId}`;
    } else if (metaId.startsWith("tt")) {
      const imdbId = metaId.split(":")[0];
      url = `https://animeapi.my.id/imdb/${imdbId}`;
    } else {
      console.log("AniSkip v2: Unsupported metadata provider.");
      return null;
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        return data.myanimelist || null;
      }
    } catch (e) {
      console.error("AniSkip v2: Error translating ID via AnimeAPI:", e);
    }
    return null;
  }

  // Fetch AniSkip v2 Timestamps
  async function fetchSkipTimes(malId, episode, duration) {
    console.log(`AniSkip v2: Fetching skip times for MAL ID ${malId}, Episode ${episode}, Duration ${duration}s`);
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=${duration}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.found) {
          return data.results;
        }
      }
    } catch (e) {
      console.error("AniSkip v2: Error querying AniSkip v2:", e);
    }
    return [];
  }

  // Inject timeline marks on Stremio's progress bar
  function injectTimelineMarks(segments, duration) {
    pollElement(".slider-hBDOf", (slider) => {
      // Remove any existing marks
      slider.querySelectorAll(".aniskip-timeline-mark").forEach(mark => mark.remove());

      segments.forEach(segment => {
        const start = segment.interval.startTime;
        const end = segment.interval.endTime;
        const left = (start / duration) * 100;
        const width = ((end - start) / duration) * 100;

        const mark = document.createElement("div");
        mark.classList.add("aniskip-timeline-mark");
        mark.style.left = `${left}%`;
        mark.style.width = `${width}%`;
        slider.appendChild(mark);
      });
      console.log("AniSkip v2: Timeline markers successfully injected.");
    });
  }

  // Show Skip Popup UI
  function showSkipPopup(video, segment) {
    if (popupElement) popupElement.remove();

    const skipTypeLabel = segment.skipType === "op" ? "Opening" : segment.skipType === "ed" ? "Ending" : "Recap";
    const endTimeFormatted = formatTime(segment.interval.endTime);

    popupElement = document.createElement("div");
    popupElement.className = "aniskip-v2-popup";
    popupElement.innerHTML = `
      <div class="header-row">
        <span class="title">Skip ${skipTypeLabel}</span>
      </div>
      <span class="subtitle">Skip straight to ${endTimeFormatted} (Autoskipping in 5s)</span>
      <div class="buttons">
        <button class="btn-dismiss">Dismiss</button>
        <button class="btn-skip">Skip</button>
      </div>
    `;

    const playerContainer = document.querySelector(".player-container-wIELK") || document.body;
    playerContainer.appendChild(popupElement);

    let autoSkipTimeout = setTimeout(() => {
      performSkip();
    }, AUTO_SKIP_DELAY);

    function performSkip() {
      console.log(`AniSkip v2: Skipping ${segment.skipType} to ${segment.interval.endTime}`);
      video.currentTime = segment.interval.endTime;
      cleanup();
    }

    function cleanup() {
      clearTimeout(autoSkipTimeout);
      if (popupElement) {
        popupElement.style.opacity = "0";
        popupElement.style.transform = "translateY(10px)";
        setTimeout(() => popupElement?.remove(), 300);
      }
    }

    popupElement.querySelector(".btn-skip").addEventListener("click", performSkip);
    popupElement.querySelector(".btn-dismiss").addEventListener("click", cleanup);
  }

  // Setup video playback monitoring
  function monitorVideo(video, segments, duration) {
    if (activeVideoElement) {
      // Clean up previous event listeners
      const oldListener = videoListeners.get(activeVideoElement);
      if (oldListener) activeVideoElement.removeEventListener("timeupdate", oldListener);
    }

    activeVideoElement = video;
    activeSegments = segments;

    const triggered = new Set();

    const onTimeUpdate = () => {
      const curr = video.currentTime;
      segments.forEach(segment => {
        const start = segment.interval.startTime;
        const end = segment.interval.endTime;
        const segId = segment.skipId;

        if (curr >= start && curr < end) {
          if (!triggered.has(segId)) {
            triggered.add(segId);
            showSkipPopup(video, segment);
          }
        } else if (curr >= end || curr < start) {
          if (triggered.has(segId) && popupElement) {
            // Remove popup if player naturally cursor-passed the segment
            popupElement.remove();
            popupElement = null;
          }
        }
      });
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    videoListeners.set(video, onTimeUpdate);
    console.log("AniSkip v2: Playback monitoring active.");
  }

  let playerPollInterval = null;
  let currentEpisodeKey = null;

  function stopPlayerPolling() {
    if (playerPollInterval) {
      clearInterval(playerPollInterval);
      playerPollInterval = null;
    }
  }

  // Load AniSkip for a specific loaded episode
  async function loadAniSkipForEpisode(metaInfo, episodeNumber) {
    console.log(`AniSkip v2: Loading segments for ${metaInfo.name} Ep ${episodeNumber}`);

    // 1. Fetch MAL translation ID using the IMDb/Kitsu metadata ID
    const malId = await fetchMALId(metaInfo.id);
    if (!malId) {
      console.log("AniSkip v2: Translation failed or MyAnimeList ID mapping missing.");
      return;
    }

    // 2. Poll for the video element to retrieve accurate file duration
    pollElement("video", (video) => {
      const handleMetadata = async () => {
        const duration = video.duration;
        if (!duration || isNaN(duration)) return;

        // 3. Fetch AniSkip v2 skip times using MAL ID, Episode, and exact Duration
        const segments = await fetchSkipTimes(malId, episodeNumber, duration);
        if (segments && segments.length > 0) {
          console.log(`AniSkip v2: Found ${segments.length} segment(s)!`, segments);
          injectTimelineMarks(segments, duration);
          monitorVideo(video, segments, duration);
        } else {
          console.log("AniSkip v2: No skip times matched for this episode duration.");
        }
      };

      if (video.readyState >= 1) {
        handleMetadata();
      } else {
        video.addEventListener("loadedmetadata", handleMetadata, { once: true });
      }
    });
  }

  // Core handler: dynamic polling that stops immediately when metadata is ready
  function startPlayerPolling() {
    stopPlayerPolling(); // Clear any existing poll

    console.log("AniSkip v2: Starting dynamic player state polling...");
    playerPollInterval = setInterval(async () => {
      // Check if we left the player page
      if (!location.hash.startsWith("#/player")) {
        stopPlayerPolling();
        return;
      }

      // Check if core services are ready
      const core = window.services?.core;
      if (!core) return;

      // Get player state
      const state = core.transport.getState("player");
      if (!state || !state.seriesInfo || !state.metaItem?.content) return;

      // Ensure we don't double-trigger for the same metadata ID
      const metaInfo = state.metaItem.content;
      const episodeInfo = state.seriesInfo;
      const episodeNumber = episodeInfo.episode;
      const episodeKey = `${metaInfo.id}:${episodeNumber}`;

      if (episodeKey === currentEpisodeKey) {
        // Already initialized for this episode
        stopPlayerPolling();
        return;
      }

      // We found the metadata! Clear the poll and initialize.
      stopPlayerPolling();
      currentEpisodeKey = episodeKey;
      
      console.log("AniSkip v2: Dynamic player metadata detected!");
      await loadAniSkipForEpisode(metaInfo, episodeNumber);
    }, 500); // Check every 500ms
  }

  // Set up listeners for player routing
  function hashChangeHandler() {
    if (location.hash.startsWith("#/player")) {
      startPlayerPolling();
    } else {
      stopPlayerPolling();
      currentEpisodeKey = null;
      // Cleanup popup if player is closed
      if (popupElement) {
        popupElement.remove();
        popupElement = null;
      }
    }
  }

  window.addEventListener("hashchange", hashChangeHandler);
  window.addEventListener("load", hashChangeHandler);

  // If player is already loaded when the script initializes
  if (location.hash.startsWith("#/player")) {
    startPlayerPolling();
  }
})();
