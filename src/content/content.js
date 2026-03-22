// ═══════════════════════════════════════════
// TipStream Extension — Content Script (FIXED)
// Runs on rumble.com — detects video, creator,
// wallet address (3-step HTMX), chat messages,
// watch time. Sends WATCH_UPDATE every 30s with
// ALL data. Smooth 1-second badge timer.
// ═══════════════════════════════════════════

(function () {
  "use strict";

  // ── State ──
  let currentVideoId = null;
  let currentCreatorName = null;
  let currentCreatorAddress = null;
  let currentCreatorBtcAddress = null;
  let watchStartTime = null;
  let totalWatchSeconds = 0;
  let isWatching = false;
  let watchInterval = null;
  let badgeInterval = null;
  let chatInterval = null;
  let videoElement = null;
  let lastReportedSeconds = 0;
  let lastChatIds = new Set();
  let extensionValid = true;

  const WATCH_REPORT_INTERVAL = 30000;
  const DETECTION_RETRY_INTERVAL = 2000;
  const MAX_DETECTION_RETRIES = 15;
  const CHAT_SCRAPE_INTERVAL = 4000;

  // ── Safe message sender ──
  function safeSend(msg) {
    if (!extensionValid) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {
        extensionValid = false;
        cleanup();
      });
    } catch (e) {
      extensionValid = false;
      cleanup();
    }
  }

  function bgLog(msg) {
    console.log("[TipStream]", msg);
    safeSend({ type: "CONTENT_LOG", data: { message: "[Content] " + msg } });
  }

  // ── Init ──
  function init() {
    bgLog("Content script loaded on: " + window.location.href);

    if (!isVideoPage()) {
      bgLog("Not a video page, watching for SPA navigation...");
      observePageChanges();
      return;
    }

    detectVideoAndCreator();
    startChatScraper();
    observePageChanges();
  }

  // ── Is this a video page? ──
  function isVideoPage() {
    const url = window.location.href;
    return (
      /rumble\.com\/v[a-zA-Z0-9]/.test(url) ||
      /rumble\.com\/embed\//.test(url) ||
      document.querySelector("#videoPlayer, .video-player") !== null
    );
  }

  // ── Detect video + creator (with retry) ──
  function detectVideoAndCreator(retryCount) {
    retryCount = retryCount || 0;
    bgLog("Detection attempt " + (retryCount + 1) + "...");

    videoElement = findVideoElement();
    if (!videoElement && retryCount < MAX_DETECTION_RETRIES) {
      setTimeout(function () { detectVideoAndCreator(retryCount + 1); }, DETECTION_RETRY_INTERVAL);
      return;
    }

    if (!videoElement) {
      bgLog("Could not find video element after max retries");
      return;
    }

    currentVideoId = extractVideoId();
    bgLog("Video ID: " + currentVideoId);

    extractCreatorInfo();
    setupWatchTracking();
    injectTipBadge();

    bgLog("Ready! Creator: " + currentCreatorName + " | Address: " + (currentCreatorAddress || "detecting..."));
  }

  // ── Find video element ──
  function findVideoElement() {
    var playerContainer = document.querySelector("#videoPlayer, .video-player");
    if (playerContainer) {
      var video = playerContainer.querySelector("video");
      if (video) return video;
    }
    var rumblePlayer = document.querySelector('[class*="videoPlayer-Rumble"]');
    if (rumblePlayer) {
      var video2 = rumblePlayer.querySelector("video");
      if (video2) return video2;
    }
    var videos = document.querySelectorAll("video");
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].offsetParent !== null) return videos[i];
    }
    return null;
  }

  // ── Extract video ID ──
  function extractVideoId() {
    var m1 = window.location.pathname.match(/\/(v[a-zA-Z0-9]+)-/);
    if (m1) return m1[1];
    var m2 = window.location.pathname.match(/\/(v[a-zA-Z0-9]+)\.html/);
    if (m2) return m2[1];
    var playerDiv = document.querySelector('[id^="vid_"]');
    if (playerDiv) return playerDiv.id.replace("vid_", "");
    return "vid_" + window.location.pathname.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  }

  // ═══════════════════════════════════════════
  // CREATOR DETECTION — multiple strategies
  // ═══════════════════════════════════════════
  function extractCreatorInfo() {
    // Strategy 0: JSON-LD structured data (cleanest, from competitor analysis)
    if (!currentCreatorName) {
      var jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < jsonLdScripts.length; i++) {
        try {
          var jsonData = JSON.parse(jsonLdScripts[i].textContent);
          if (jsonData.author && jsonData.author.name) {
            currentCreatorName = jsonData.author.name.trim();
            break;
          }
        } catch (e) {}
      }
    }

    // Strategy 1: meta author
    if (!currentCreatorName) {
      var meta = document.querySelector('meta[name="author"]');
      if (meta) currentCreatorName = (meta.getAttribute("content") || "").trim();
    }

    // Strategy 2: Channel avatar area with truncate span
    if (!currentCreatorName) {
      var truncEl = document.querySelector(".relative.channel_avatar span.truncate, [class*='channel_avatar'] span.truncate");
      if (truncEl) {
        var titleAttr = truncEl.getAttribute("title");
        if (titleAttr) {
          currentCreatorName = titleAttr.trim();
        } else {
          for (var j = 0; j < truncEl.childNodes.length; j++) {
            if (truncEl.childNodes[j].nodeType === Node.TEXT_NODE && truncEl.childNodes[j].textContent.trim()) {
              currentCreatorName = truncEl.childNodes[j].textContent.trim();
              break;
            }
          }
        }
      }
    }

    // Strategy 3: Channel selectors
    if (!currentCreatorName) {
      var selectors = [".media-heading-name", ".media-by-channel-container a", ".channel-header--title", ".media-by a"];
      for (var k = 0; k < selectors.length; k++) {
        var el = document.querySelector(selectors[k]);
        if (el) {
          for (var n = 0; n < el.childNodes.length; n++) {
            if (el.childNodes[n].nodeType === Node.TEXT_NODE && el.childNodes[n].textContent.trim()) {
              currentCreatorName = el.childNodes[n].textContent.trim();
              break;
            }
          }
          if (currentCreatorName) break;
        }
      }
    }

    // Strategy 4: Channel link href /c/
    if (!currentCreatorName) {
      var links = document.querySelectorAll('a[href*="/c/"]');
      for (var l = 0; l < links.length; l++) {
        var match = (links[l].getAttribute("href") || "").match(/\/c\/([^\/\?]+)/);
        if (match && match[1]) { currentCreatorName = match[1]; break; }
      }
    }

    // Cleanup noise
    if (currentCreatorName) {
      currentCreatorName = currentCreatorName
        .replace(/[\t\n\r]+/g, " ")
        .replace(/\s*Verified\b/gi, "")
        .replace(/\s*\d+\s*followers?/gi, "")
        .trim();
    }

    if (!currentCreatorName) currentCreatorName = "Unknown Creator";

    bgLog("Creator detected: " + currentCreatorName);
    notifyBackground();

    // Start silent wallet extraction via HTMX
    bgLog("Starting wallet extraction...");
    extractWalletSilent();
  }

  // ═══════════════════════════════════════════
  // 3-STEP HTMX WALLET EXTRACTION
  // Same approach as competitor (proven to work)
  // Step 1: Find tip button → fetch modal HTML
  // Step 2: Find "another wallet" button → fetch tabs HTML
  // Step 3: Parse network buttons for address from hx-vals JSON
  // ═══════════════════════════════════════════
  function htmxFetch(hxGet, hxVals) {
    var params = new URLSearchParams(hxVals || {});
    var url = hxGet + (hxGet.indexOf("?") === -1 ? "?" : "&") + params.toString();
    var fullUrl = url.startsWith("http") ? url : window.location.origin + url;

    return fetch(fullUrl, {
      credentials: "include",
      headers: { "HX-Request": "true", "HX-Current-URL": window.location.href },
    })
      .then(function (resp) { return resp.ok ? resp.text() : null; })
      .catch(function () { return null; });
  }

  function extractWalletSilent() {
    if (currentCreatorAddress) return;

    // Step 1: Find tip button with hx-get
    var tipBtn = document.querySelector('button[hx-get*="qr-modal"]');
    if (!tipBtn) {
      var allBtns = document.querySelectorAll("button[hx-get]");
      for (var i = 0; i < allBtns.length; i++) {
        var g = allBtns[i].getAttribute("hx-get") || "";
        if (g.indexOf("wallet") !== -1) { tipBtn = allBtns[i]; break; }
      }
    }

    if (!tipBtn) { bgLog("Step 1: No tip button found"); return; }

    var step1Get = tipBtn.getAttribute("hx-get");
    var step1Vals = {};
    try { step1Vals = JSON.parse(tipBtn.getAttribute("hx-vals") || "{}"); } catch (e) {}
    bgLog("Step 1: hx-get=" + step1Get);

    htmxFetch(step1Get, step1Vals).then(function (modalHTML) {
      if (!modalHTML) { bgLog("Step 1: Failed to fetch modal"); return; }
      bgLog("Step 1: Got modal (" + modalHTML.length + " chars)");

      var parser = new DOMParser();
      var doc = parser.parseFromString(modalHTML, "text/html");

      // Check if address is already in modal
      var earlyAddr = findAddressInDoc(doc) || findAddressInText(modalHTML);
      if (earlyAddr) {
        currentCreatorAddress = earlyAddr;
        bgLog("Wallet found in Step 1: " + currentCreatorAddress);
        notifyBackground();
        return;
      }

      // Step 2: Find "another wallet" / address button
      var step2Btn = doc.querySelector('button[hx-get*="qr-address"]');
      if (!step2Btn) {
        var allParsed = doc.querySelectorAll("button[hx-get], [hx-get]");
        for (var j = 0; j < allParsed.length; j++) {
          var hg = allParsed[j].getAttribute("hx-get") || "";
          if (hg.indexOf("address") !== -1 || hg.indexOf("wallet") !== -1) { step2Btn = allParsed[j]; break; }
        }
      }
      if (!step2Btn) { bgLog("Step 2: No address button found"); return; }

      var step2Get = step2Btn.getAttribute("hx-get");
      var step2Vals = {};
      try { step2Vals = JSON.parse(step2Btn.getAttribute("hx-vals") || "{}"); } catch (e) {}
      bgLog("Step 2: hx-get=" + step2Get);

      htmxFetch(step2Get, step2Vals).then(function (tabsHTML) {
        if (!tabsHTML) { bgLog("Step 2: Failed to fetch tabs"); return; }
        bgLog("Step 2: Got tabs (" + tabsHTML.length + " chars)");

        // Step 3: Parse network buttons for address
        var doc2 = parser.parseFromString(tabsHTML, "text/html");
        var networkBtns = doc2.querySelectorAll('button[hx-vals*="address"], [hx-vals*="address"]');
        bgLog("Step 3: " + networkBtns.length + " network buttons");

        var networks = [];
        for (var k = 0; k < networkBtns.length; k++) {
          try {
            var vals = JSON.parse(networkBtns[k].getAttribute("hx-vals"));
            if (vals.address && vals.address.length > 10) {
              networks.push(vals);
              bgLog("  " + (vals.blockchain || "?") + "/" + (vals.currency || "?") + " → " + vals.address);
            }
          } catch (e) {}
        }

        // Priority: polygon+usdt > polygon > any EVM
        var chosen = null;
        for (var m = 0; m < networks.length; m++) {
          if (networks[m].blockchain === "polygon" && networks[m].currency === "usdt") { chosen = networks[m]; break; }
        }
        if (!chosen) {
          for (var n = 0; n < networks.length; n++) {
            if (networks[n].blockchain === "polygon") { chosen = networks[n]; break; }
          }
        }
        if (!chosen) {
          for (var p = 0; p < networks.length; p++) {
            if (networks[p].blockchain !== "bitcoin") { chosen = networks[p]; break; }
          }
        }

        // Also grab BTC address if available
        for (var q = 0; q < networks.length; q++) {
          if (networks[q].blockchain === "bitcoin" && networks[q].address) {
            currentCreatorBtcAddress = networks[q].address;
            bgLog("BTC: " + currentCreatorBtcAddress);
            break;
          }
        }

        if (chosen) {
          currentCreatorAddress = chosen.address;
          bgLog("Wallet: " + currentCreatorAddress + " (" + (chosen.blockchain || "?") + ")" + (currentCreatorBtcAddress ? " | BTC: " + currentCreatorBtcAddress : ""));
          notifyBackground();
          return;
        }

        var textAddr = findAddressInText(tabsHTML);
        if (textAddr) {
          currentCreatorAddress = textAddr;
          bgLog("Wallet from text: " + currentCreatorAddress);
          notifyBackground();
        } else {
          bgLog("Step 3: No address found");
        }
      });
    });
  }

  function findAddressInDoc(doc) {
    var els = doc.querySelectorAll("[hx-vals]");
    for (var i = 0; i < els.length; i++) {
      try {
        var vals = JSON.parse(els[i].getAttribute("hx-vals"));
        if (vals.address && /^0x[a-fA-F0-9]{40}$/.test(vals.address)) return vals.address;
      } catch (e) {}
    }
    var addrEl = doc.querySelector("#js-wallet-address__value, #js-wallet-address_value");
    if (addrEl) { var addr = addrEl.textContent.trim(); if (addr && addr.length > 10) return addr; }
    return null;
  }

  function findAddressInText(html) {
    var ethMatch = html.match(/0x[a-fA-F0-9]{40}/);
    if (ethMatch) return ethMatch[0];
    return null;
  }

  function notifyBackground() {
    safeSend({
      type: "CREATOR_DETECTED",
      data: { videoId: currentVideoId, creatorName: currentCreatorName, creatorAddress: currentCreatorAddress, btcAddress: currentCreatorBtcAddress },
    });
  }

  // ═══════════════════════════════════════════
  // WATCH TIME TRACKING
  // ═══════════════════════════════════════════
  function setupWatchTracking() {
    if (!videoElement) return;

    videoElement.addEventListener("play", function () {
      bgLog("Video playing");
      isWatching = true;
      watchStartTime = Date.now();
      startWatchReporting();
    });

    videoElement.addEventListener("pause", function () {
      bgLog("Video paused");
      if (isWatching) {
        totalWatchSeconds += (Date.now() - watchStartTime) / 1000;
        isWatching = false;
      }
    });

    videoElement.addEventListener("ended", function () {
      bgLog("Video ended");
      if (isWatching) {
        totalWatchSeconds += (Date.now() - watchStartTime) / 1000;
        isWatching = false;
      }
      stopWatchReporting();
      reportVideoEnded();
    });

    videoElement.addEventListener("seeked", function () {
      if (isWatching) watchStartTime = Date.now();
    });

    // Already playing?
    if (!videoElement.paused) {
      isWatching = true;
      watchStartTime = Date.now();
      startWatchReporting();
    }

    // ── Smooth 1-second badge update (separate from 30s reporting) ──
    badgeInterval = setInterval(function () {
      if (!extensionValid) return;
      var secs = isWatching
        ? Math.floor(totalWatchSeconds + (Date.now() - watchStartTime) / 1000)
        : Math.floor(totalWatchSeconds);
      updateTipBadge(secs);
    }, 1000);

    window.addEventListener("beforeunload", function () {
      if (isWatching) totalWatchSeconds += (Date.now() - watchStartTime) / 1000;
      if (totalWatchSeconds > 0) reportVideoEnded();
    });
  }

  function startWatchReporting() {
    if (watchInterval) return;

    watchInterval = setInterval(function () {
      if (!extensionValid) { cleanup(); return; }
      if (!isWatching) return;

      var currentSeconds = totalWatchSeconds + (Date.now() - watchStartTime) / 1000;

      if (currentSeconds > lastReportedSeconds + 5) {
        lastReportedSeconds = currentSeconds;

        // Send ALL data in one message — service worker uses this to auto-tip
        bgLog("WATCH_UPDATE → " + currentCreatorName + " | " + Math.floor(currentSeconds) + "s | addr=" + (currentCreatorAddress ? "yes" : "none"));
        safeSend({
          type: "WATCH_UPDATE",
          data: {
            videoId: currentVideoId,
            creatorName: currentCreatorName,
            creatorAddress: currentCreatorAddress,
            btcAddress: currentCreatorBtcAddress,
            watchSeconds: Math.floor(currentSeconds),
            videoDuration: videoElement ? videoElement.duration || 0 : 0,
          },
        });
      }
    }, WATCH_REPORT_INTERVAL);
  }

  function stopWatchReporting() {
    if (watchInterval) { clearInterval(watchInterval); watchInterval = null; }
  }

  function reportVideoEnded() {
    safeSend({
      type: "VIDEO_ENDED",
      data: {
        videoId: currentVideoId,
        creatorName: currentCreatorName,
        creatorAddress: currentCreatorAddress,
        btcAddress: currentCreatorBtcAddress,
        totalWatchSeconds: Math.floor(totalWatchSeconds),
      },
    });
  }

  // ═══════════════════════════════════════════
  // LIVE CHAT SCRAPING (our unique advantage)
  // Competitor does NOT have this
  // ═══════════════════════════════════════════
  function startChatScraper() {
    chatInterval = setInterval(function () {
      if (!extensionValid) { clearInterval(chatInterval); return; }
      scrapeChatMessages();
    }, CHAT_SCRAPE_INTERVAL);
  }

  function scrapeChatMessages() {
    // Exact Rumble selectors (confirmed working)
    var chatElements = document.querySelectorAll("#chat-history-list > li.chat-history--row");
    if (chatElements.length === 0) return;

    if (!window._tipstreamChatLogged) {
      window._tipstreamChatLogged = true;
      bgLog("Chat found: " + chatElements.length + " messages");
    }

    var messages = [];
    chatElements.forEach(function (el) {
      var id = el.getAttribute("data-message-id");
      if (!id || lastChatIds.has(id)) return;

      var usernameEl = el.querySelector("button.chat-history--username");
      var textEl = el.querySelector("div.chat-history--message");
      var username = (usernameEl ? usernameEl.textContent.trim() : null) || el.getAttribute("data-username") || "unknown";
      var text = textEl ? textEl.textContent.trim() : "";

      if (!text || text.length < 1) return;

      lastChatIds.add(id);
      messages.push({ id: id, text: text, username: username, user_id: el.getAttribute("data-message-user-id") || username, timestamp: Date.now() });
    });

    if (lastChatIds.size > 500) {
      var arr = Array.from(lastChatIds);
      lastChatIds = new Set(arr.slice(-200));
    }

    if (messages.length > 0) {
      safeSend({ type: "CHAT_MESSAGES", data: { messages: messages, creator: currentCreatorName } });
    }
  }

  // ═══════════════════════════════════════════
  // TIP BADGE — on-video overlay
  // ═══════════════════════════════════════════
  function injectTipBadge() {
    var playerContainer = document.querySelector("#videoPlayer, .video-player, .media-container");
    if (!playerContainer) return;
    if (document.getElementById("tipstream-badge")) return;

    var badge = document.createElement("div");
    badge.id = "tipstream-badge";
    badge.innerHTML =
      '<div style="' +
        'position: absolute; top: 12px; right: 12px; z-index: 9999;' +
        'background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);' +
        'color: #10B981; padding: 6px 12px; border-radius: 20px;' +
        'font-size: 11px; font-family: JetBrains Mono, monospace;' +
        'font-weight: 600; display: flex; align-items: center; gap: 6px;' +
        'pointer-events: none; border: 1px solid rgba(16,185,129,0.3);' +
      '">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:#10B981;' +
          'display:inline-block;animation:ts-pulse 2s ease-in-out infinite"></span>' +
        '<span id="tipstream-badge-text">TIPSTREAM ▶ 0:00</span>' +
      '</div>';

    var style = document.createElement("style");
    style.textContent = "@keyframes ts-pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }";
    document.head.appendChild(style);

    if (playerContainer.style.position === "" || playerContainer.style.position === "static") {
      playerContainer.style.position = "relative";
    }
    playerContainer.appendChild(badge);
  }

  function updateTipBadge(watchSeconds) {
    var el = document.getElementById("tipstream-badge-text");
    if (el) {
      var mins = Math.floor(watchSeconds / 60);
      var secs = watchSeconds % 60;
      var status = isWatching ? "▶" : "⏸";
      el.textContent = "TIPSTREAM " + status + " " + mins + ":" + (secs < 10 ? "0" : "") + secs;
    }
  }

  // ═══════════════════════════════════════════
  // TIP NOTIFICATION — on-page toast when tip sent
  // ═══════════════════════════════════════════
  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === "TIP_SENT") showTipNotification(message.data);
  });

  function showTipNotification(tipData) {
    var notification = document.createElement("div");
    notification.style.cssText =
      "position:fixed; bottom:24px; right:24px; z-index:99999;" +
      "background:linear-gradient(135deg,#171717,#0d1117);" +
      "border:1px solid #10B981; color:white; padding:16px 20px;" +
      "border-radius:12px; font-family:JetBrains Mono, monospace;" +
      "font-size:13px; box-shadow:0 8px 32px rgba(16,185,129,0.2);" +
      "animation:ts-slidein 0.4s ease-out; max-width:320px;";
    notification.innerHTML =
      '<div style="font-weight:700;color:#10B981;margin-bottom:6px">₮ Tip Sent!</div>' +
      '<div style="color:#e0e0e0"><strong>$' + (tipData.amount || "?") + ' USDt</strong> → ' + (tipData.creatorUsername || tipData.creatorName || "?") + '</div>' +
      '<div style="color:#6B7280;font-size:11px;margin-top:4px">' +
        (tipData.triggerReason || tipData.trigger || "auto") + ' · ' + (tipData.aiMode || "rules") +
        (tipData.txHash ? " · " + tipData.txHash.slice(0, 12) + "..." : "") +
      '</div>';

    var style = document.createElement("style");
    style.textContent = "@keyframes ts-slidein { from { transform:translateY(100px);opacity:0 } to { transform:translateY(0);opacity:1 } }";
    document.head.appendChild(style);
    document.body.appendChild(notification);

    setTimeout(function () {
      notification.style.transition = "opacity 0.3s, transform 0.3s";
      notification.style.opacity = "0";
      notification.style.transform = "translateY(20px)";
      setTimeout(function () { notification.remove(); }, 300);
    }, 5000);
  }

  // ═══════════════════════════════════════════
  // SPA NAVIGATION OBSERVER
  // ═══════════════════════════════════════════
  function observePageChanges() {
    var lastUrl = window.location.href;
    var observer = new MutationObserver(function () {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        bgLog("Page changed: " + lastUrl);
        cleanup();
        if (isVideoPage()) setTimeout(function () { detectVideoAndCreator(); startChatScraper(); }, 1000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("popstate", function () {
      setTimeout(function () {
        if (isVideoPage()) { cleanup(); detectVideoAndCreator(); startChatScraper(); }
      }, 500);
    });
  }

  // ── Cleanup ──
  function cleanup() {
    stopWatchReporting();
    if (chatInterval) { clearInterval(chatInterval); chatInterval = null; }
    if (badgeInterval) { clearInterval(badgeInterval); badgeInterval = null; }
    if (isWatching && totalWatchSeconds > 0) reportVideoEnded();
    currentVideoId = null;
    currentCreatorName = null;
    currentCreatorAddress = null;
    currentCreatorBtcAddress = null;
    totalWatchSeconds = 0;
    isWatching = false;
    watchStartTime = null;
    lastReportedSeconds = 0;
    videoElement = null;
    lastChatIds = new Set();
    window._tipstreamChatLogged = false;
    var badge = document.getElementById("tipstream-badge");
    if (badge) badge.remove();
  }

  // ── Start ──
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();