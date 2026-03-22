// ═══════════════════════════════════════════
// TipStream Extension — Service Worker (FIXED)
// Autonomous: WATCH_UPDATE triggers tip evaluation
// Bypasses decideTip() in-memory gate — uses address from content script
// Chat hype analysis + LLM reasoning + WDK tips
// ═══════════════════════════════════════════

import {
  initWallet, restoreWallet, isReady, isBtcReady, getBalances,
  sendTip, sendBtcTip, sendSplitTip, switchChain, generateSeed, getAddress, getBtcAddress,
} from "./wallet.js";
import {
  getStore, setStore, setKey, getKey,
  addTip, getTips, getDashboard,
  setCreator, getCreator, getCreatorFull, getAllCreators, getAllCreatorsFull,
  getSplits, setSplits,
  getOrCreateBudget, saveBudget, getBudgets,
  addPool, getPools, fundPool,
  addHypeScore, getLatestHype, getHypeHistory,
  getAgentSettings, saveAgentSettings,
  getMilestoneState, setMilestoneState,
} from "./store.js";
import { analyzeHype, deduplicateSpam } from "./hype-agent.js";
import { RUMBLE_API_URL } from "./config.js";
import { llmEvaluate } from "./llm-agent.js";

// ── Restore wallet on startup (trackable promise for WALLET_GET race fix) ──
let walletRestorePromise = null;
try {
  walletRestorePromise = restoreWallet().then((ok) => {
    if (ok) console.log("[TipStream] Wallet restored from storage");
    else console.log("[TipStream] No stored wallet — waiting for setup");
    return ok;
  }).catch((err) => {
    console.warn("[TipStream] Wallet restore failed:", err.message);
    return false;
  });
} catch (err) {
  console.warn("[TipStream] Init error:", err.message);
  walletRestorePromise = Promise.resolve(false);
}

// ── Sidebar ──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[TipStream] sidePanel error:", err));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes("rumble.com")) {
    chrome.sidePanel.setOptions({ tabId, path: "sidebar/sidebar.html", enabled: true });
  }
});

// ── Message Router ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error("[SW] Error:", err.message);
    sendResponse({ success: false, error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  const { type, data } = msg;

  // Wait for wallet restore on service worker wake (MV3 race fix)
  if (walletRestorePromise) {
    await walletRestorePromise;
    walletRestorePromise = null;
  }

  switch (type) {
    // ═══ WALLET ═══
    case "WALLET_INIT": {
      const info = await initWallet(data.seed);
      return { success: true, data: info };
    }
    case "WALLET_GENERATE_SEED": {
      return { success: true, data: { seedPhrase: generateSeed() } };
    }
    case "WALLET_GET": {
      if (!isReady()) return { success: false, error: "Wallet not initialized", needsSetup: true };
      return { success: true, data: await getBalances() };
    }
    case "WALLET_SWITCH_CHAIN": {
      return { success: true, data: await switchChain(data.chain) };
    }

    // ═══ RUMBLE ═══
    case "RUMBLE_CONNECT": {
      const key = data.apiKey;
      if (!key) return { success: false, error: "API key required" };
      try {
        const res = await fetch(`${RUMBLE_API_URL}?key=${key}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rd = await res.json();
        await setStore({ rumbleApiKey: key, rumbleUsername: rd.username, rumbleConnected: true });
        return { success: true, data: { username: rd.username, userId: rd.user_id, followers: rd.followers?.num_followers_total || 0 } };
      } catch (err) {
        return { success: false, error: "Invalid Rumble API key" };
      }
    }
    case "RUMBLE_STATUS": {
      const st = await getStore();
      if (!st.rumbleApiKey) return { success: false, error: "Not connected" };
      try {
        const res = await fetch(`${RUMBLE_API_URL}?key=${st.rumbleApiKey}`);
        const rd = await res.json();
        const ls = rd.livestreams?.find((l) => l.is_live) || null;
        return { success: true, data: { isLive: !!ls, username: rd.username, followers: rd.followers?.num_followers_total || 0, livestream: ls ? { title: ls.title, watchingNow: ls.watching_now } : null } };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    case "RUMBLE_DISCONNECT": {
      await setStore({ rumbleApiKey: "", rumbleUsername: "", rumbleConnected: false });
      return { success: true };
    }

    // ═══ CREATORS ═══
    case "CREATOR_REGISTER": {
      if (!data.username || !data.address) return { success: false, error: "username and address required" };
      if (!/^0x[a-fA-F0-9]{40}$/.test(data.address)) return { success: false, error: "Invalid EVM address" };
      await setCreator(data.username, data.address);
      return { success: true, data: { username: data.username, address: data.address } };
    }
    case "CREATOR_GET_ALL": {
      return { success: true, data: await getAllCreators() };
    }
    case "CREATOR_GET_FULL": {
      return { success: true, data: await getAllCreatorsFull() };
    }

    // ═══ SPLITS ═══
    case "SPLITS_SAVE": {
      if (!data.username) return { success: false, error: "username required" };
      await setSplits(data.username, data.splits || []);
      console.log(`[Splits] Saved ${(data.splits || []).length} splits for ${data.username}`);
      return { success: true };
    }
    case "SPLITS_GET": {
      return { success: true, data: await getSplits(data.username) };
    }

    // ═══ MILESTONES ═══
    case "MILESTONE_CHECK": {
      const milestoneResult = await checkMilestones();
      return { success: true, data: milestoneResult };
    }

    // ═══ TIPS ═══
    case "TIP_SEND": {
      if (!isReady()) return { success: false, error: "Wallet not initialized" };
      const addr = data.creatorAddress || await getCreator(data.creatorUsername);
      if (!addr) return { success: false, error: `No address for ${data.creatorUsername}` };
      const tipAmt = parseFloat(data.amount);
      const llmCheck = await llmEvaluate({
        creatorUsername: data.creatorUsername, trigger: "manual", ruleAmount: tipAmt,
        hypeScore: 0, chatVelocity: 0, keywordHits: [], sentimentScore: 0,
        watchMinutes: 0, budgetRemaining: 999, budgetMonthly: 999, spentToday: 0, tipHistory: 0,
      });
      console.log(`[LLM] Manual tip: ${llmCheck.reasoning} (${llmCheck.mode})`);

      // Check for splits
      const splits = await getSplits(data.creatorUsername);
      if (splits && splits.length > 0) {
        const txResults = await sendSplitTip(addr, splits, tipAmt, data.creatorUsername, "manual");
        for (const tx of txResults) {
          tx.aiMode = llmCheck.mode;
          tx.aiConfidence = llmCheck.confidence;
          tx.aiReasoning = llmCheck.reasoning;
          await addTip(tx);
        }
        chrome.runtime.sendMessage({ type: "TIP_SENT", data: txResults[0] }).catch(() => {});
        return { success: true, data: txResults[0], splits: txResults };
      }

      const tx = await sendTip(addr, tipAmt, data.creatorUsername, "manual");
      tx.aiMode = llmCheck.mode;
      tx.aiConfidence = llmCheck.confidence;
      tx.aiReasoning = llmCheck.reasoning;
      await addTip(tx);
      return { success: true, data: tx };
    }
    case "TIP_HISTORY": {
      return { success: true, data: await getTips(data?.limit || 20) };
    }

    // ═══ BTC TIPS ═══
    case "BTC_TIP_SEND": {
      if (!isBtcReady()) return { success: false, error: "BTC wallet not initialized" };
      if (!data.btcAddress || !data.btcAddress.startsWith("bc1")) return { success: false, error: "Invalid BTC address (need bc1... bech32)" };
      const btcAmt = parseFloat(data.amount);
      if (btcAmt <= 0) return { success: false, error: "Invalid amount" };
      console.log(`[BTC] Manual BTC tip: ${btcAmt} BTC to ${data.btcAddress} (${data.creatorUsername})`);
      const tx = await sendBtcTip(data.btcAddress, btcAmt, data.creatorUsername, "manual");
      tx.aiMode = "rules"; tx.aiConfidence = 1; tx.aiReasoning = "Manual BTC tip";
      await addTip(tx);
      return { success: true, data: tx };
    }
    case "BTC_STATUS": {
      return { success: true, data: { available: isBtcReady(), address: getBtcAddress() || null } };
    }

    // ═══ BUDGETS ═══
    case "BUDGET_SAVE": {
      const existing = await getOrCreateBudget(data.creatorUsername);
      const updated = { ...existing, ...data };
      await saveBudget(updated);
      return { success: true, data: updated };
    }
    case "BUDGET_GET_ALL": {
      return { success: true, data: await getBudgets() };
    }

    // ═══ POOLS ═══
    case "POOL_CREATE": {
      const pool = { id: `pool_${Date.now()}`, name: data.name, creatorUsername: data.creatorUsername, totalFunded: 0, totalDistributed: 0, memberCount: 1, hypeThreshold: data.hypeThreshold || 75, createdAt: Date.now() };
      await addPool(pool);
      return { success: true, data: pool };
    }
    case "POOL_FUND": {
      await fundPool(data.poolId, parseFloat(data.amount));
      return { success: true };
    }
    case "POOL_GET_ALL": {
      return { success: true, data: await getPools() };
    }

    // ═══════════════════════════════════════════════════════
    // WATCH_UPDATE — THE KEY AUTONOMOUS HANDLER
    // Content script sends every 30s: { videoId, creatorName, creatorAddress, watchSeconds }
    //
    // WHY WE BYPASS decideTip():
    // decideTip() calls getCreator() which reads chrome.storage.
    // But the creator may not be registered yet — the content script
    // discovered the address via HTMX and is sending it here.
    // So we do the budget math directly using the address from data.
    // ═══════════════════════════════════════════════════════
    case "WATCH_UPDATE": {
      const store = await getStore();
      const { videoId, creatorName, creatorAddress, watchSeconds } = data;
      console.log(`[Agent] WATCH_UPDATE: ${creatorName} | ${watchSeconds}s | addr=${creatorAddress ? creatorAddress.slice(0,10) + "..." : "none"} | vid=${videoId}`);

      // Save watch session
      const sessions = { ...(store.watchSessions || {}) };
      sessions[videoId || "current"] = {
        creator: creatorName,
        creatorAddress: creatorAddress,
        watchSeconds: watchSeconds,
        lastUpdate: Date.now(),
      };
      await setKey("watchSessions", sessions);

      // Broadcast state to sidebar
      chrome.runtime.sendMessage({
        type: "WATCH_STATE",
        data: { creatorName, creatorAddress, watchSeconds, videoId, isLive: !!(store.rumbleConnected) },
      }).catch(() => {});

      // Auto-register creator if address detected from HTMX
      if (creatorName && creatorAddress && /^0x[a-fA-F0-9]{40}$/.test(creatorAddress)) {
        const existing = await getCreator(creatorName);
        if (!existing) {
          await setCreator(creatorName, creatorAddress, data.btcAddress || null);
          console.log(`[Agent] Auto-registered: ${creatorName} → ${creatorAddress}${data.btcAddress ? " | BTC: " + data.btcAddress : ""}`);
        }
      }

      // ── Pre-checks ──
      if (!isReady()) {
        console.log(`[Agent] ✗ wallet_not_ready`);
        return { success: true, tipped: false, reason: "wallet_not_ready" };
      }
      if (!creatorAddress || !/^0x[a-fA-F0-9]{40}$/.test(creatorAddress)) {
        console.log(`[Agent] ✗ no_creator_address (addr=${creatorAddress})`);
        return { success: true, tipped: false, reason: "no_creator_address" };
      }
      if (watchSeconds < 60) {
        console.log(`[Agent] ✗ below_min_watch_time (${watchSeconds}s < 60s)`);
        chrome.runtime.sendMessage({
          type: "AGENT_DECISION",
          data: { type: "thinking", label: "WATCHING", text: `${watchSeconds}s / 60s minimum — ${60 - watchSeconds}s to go` },
        }).catch(() => {});
        return { success: true, tipped: false, reason: "below_min_watch_time" };
      }

      // ── Per-video cooldown — allow re-tipping after cooldown, not permanent block ──
      const tippedVideos = store.tippedVideos || {};
      const lastTipForVideo = tippedVideos[videoId] || 0;
      const settings = await getAgentSettings();
      const cooldown = settings.cooldownSeconds || 60;
      const secsSinceVideoTip = lastTipForVideo ? (Date.now() - lastTipForVideo) / 1000 : Infinity;
      if (lastTipForVideo && secsSinceVideoTip < cooldown) {
        const secsLeft = Math.ceil(cooldown - secsSinceVideoTip);
        console.log(`[Agent] ✗ video_cooldown (${secsLeft}s left for ${videoId})`);
        chrome.runtime.sendMessage({
          type: "AGENT_DECISION",
          data: { type: "thinking", label: "COOLDOWN", text: `Next tip in ${secsLeft}s` },
        }).catch(() => {});
        return { success: true, tipped: false, reason: "video_cooldown" };
      }

      // ── Direct budget calculation (NO decideTip) ──
      const watchMinutes = watchSeconds / 60;
      const tipPerEvent = settings.defaultTipAmount || 0.5;
      const maxTip = settings.maxTipPerEvent || 5;

      // $0.02 per minute watched SINCE LAST TIP (not total)
      const lastTipSec = lastTipForVideo ? Math.floor((Date.now() - lastTipForVideo) / 1000) : watchSeconds;
      const newWatchMinutes = Math.min(lastTipSec, watchSeconds) / 60;
      let tipAmount = Math.min(tipPerEvent, Math.round(newWatchMinutes * 0.02 * 100) / 100);
      tipAmount = Math.min(tipAmount, maxTip);
      if (tipAmount < 0.01) tipAmount = 0.01;
      console.log(`[Agent] Tip calc: ${newWatchMinutes.toFixed(1)} new min × $0.02 = $${tipAmount}`);

      // Monthly budget
      const budget = await getOrCreateBudget(creatorName);
      const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
      if (remaining <= 0) {
        console.log(`[Agent] ✗ monthly_budget_exhausted ($${budget.spentThisMonthUSDT}/$${budget.monthlyBudgetUSDT})`);
        return { success: true, tipped: false, reason: "monthly_budget_exhausted" };
      }
      tipAmount = Math.min(tipAmount, remaining);

      // Cooldown
      const timeSinceLast = (Date.now() - budget.lastTipAt) / 1000;
      if (budget.lastTipAt > 0 && timeSinceLast < (budget.cooldownSeconds || 60)) {
        const secsLeft = Math.ceil((budget.cooldownSeconds || 60) - timeSinceLast);
        console.log(`[Agent] ✗ cooldown_active (${secsLeft}s left)`);
        chrome.runtime.sendMessage({
          type: "AGENT_DECISION",
          data: { type: "thinking", label: "COOLDOWN", text: `Next tip in ${secsLeft}s` },
        }).catch(() => {});
        return { success: true, tipped: false, reason: "cooldown_active" };
      }

      console.log(`[Agent] ✓ All gates passed! $${tipAmount} to ${creatorName} (${watchMinutes.toFixed(1)} min, budget: $${remaining.toFixed(2)} left)`);

      // ── LLM evaluation — pass real hype data if available ──
      const latestHype = await getLatestHype();
      const llmResult = await llmEvaluate({
        creatorUsername: creatorName, trigger: "watch_time", ruleAmount: tipAmount,
        hypeScore: latestHype?.score || 0,
        chatVelocity: latestHype?.chatVelocity || 0,
        keywordHits: latestHype?.keywordHits || [],
        sentimentScore: latestHype?.sentimentScore || 0,
        watchMinutes: watchMinutes,
        budgetRemaining: remaining, budgetMonthly: budget.monthlyBudgetUSDT,
        spentToday: store.dailySpend || 0,
        tipHistory: (store.tips || []).filter((t) => t.creatorUsername === creatorName && Date.now() - t.timestamp < 86400000).length,
      });

      if (!llmResult.shouldTip) {
        console.log(`[Agent] LLM vetoed: ${llmResult.reasoning}`);
        chrome.runtime.sendMessage({
          type: "AGENT_DECISION",
          data: { type: "veto", label: `${llmResult.mode === "ai" ? "AI" : "RULES"} VETOED`, text: llmResult.reasoning, creatorName },
        }).catch(() => {});
        return { success: true, tipped: false, reason: "llm_veto", llm: llmResult };
      }

      // ── Execute tip (with splits if configured) ──
      const finalAmount = llmResult.adjustedAmount || tipAmount;
      console.log(`[Agent] ═══ AUTO-TIP: $${finalAmount} to ${creatorName} (${watchMinutes.toFixed(1)} min) ═══`);

      const splits = await getSplits(creatorName);
      let tx;
      if (splits && splits.length > 0) {
        const txResults = await sendSplitTip(creatorAddress, splits, finalAmount, creatorName, "watch_time");
        tx = txResults[0]; // Primary creator tx
        for (const t of txResults) {
          t.aiMode = llmResult.mode;
          t.aiConfidence = llmResult.confidence;
          t.aiReasoning = llmResult.reasoning;
          await addTip(t);
        }
        console.log(`[Agent] Split tip: ${txResults.length} transfers ($${finalAmount} total)`);
      } else {
        tx = await sendTip(creatorAddress, finalAmount, creatorName, "watch_time");
        tx.aiMode = llmResult.mode;
        tx.aiConfidence = llmResult.confidence;
        tx.aiReasoning = llmResult.reasoning;
        await addTip(tx);
      }

      // Mark tipped
      tippedVideos[videoId] = Date.now();
      await setKey("tippedVideos", tippedVideos);

      // Notify content script + sidebar
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TIP_SENT", data: tx });
      } catch (_) {}
      chrome.runtime.sendMessage({ type: "TIP_SENT", data: tx }).catch(() => {});

      console.log(`[Agent] ✅ $${finalAmount} → ${creatorName} | ${tx.txHash} | ${llmResult.mode}`);
      return { success: true, tipped: true, tx };
    }

    // ═══ VIDEO_ENDED — final chance to tip ═══
    case "VIDEO_ENDED": {
      const storeVE = await getStore();
      const { videoId: veVid, creatorName: veName, creatorAddress: veAddr, totalWatchSeconds: veWatch } = data;
      const tippedVE = storeVE.tippedVideos || {};
      if (!tippedVE[veVid] && veAddr && isReady() && veWatch >= 60) {
        const watchMin = veWatch / 60;
        const tipAmt = Math.min(0.5, Math.round(watchMin * 0.02 * 100) / 100);
        if (tipAmt >= 0.01) {
          const tx = await sendTip(veAddr, tipAmt, veName, "watch_time");
          tx.aiMode = "rules"; tx.aiConfidence = 1; tx.aiReasoning = "Video ended trigger";
          await addTip(tx);
          tippedVE[veVid] = Date.now();
          await setKey("tippedVideos", tippedVE);
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TIP_SENT", data: tx });
          } catch (_) {}
          console.log(`[Agent] ✅ Video-end tip $${tipAmt} to ${veName}`);
        }
      }
      return { success: true };
    }

    // ═══ CHAT_MESSAGES — Hype analysis (our unique advantage) ═══
    case "CHAT_MESSAGES": {
      // Track creator from chat
      if (data.creator) {
        const chatStore = await getStore();
        const chatSessions = { ...(chatStore.watchSessions || {}) };
        chatSessions["chat"] = { creator: data.creator, lastUpdate: Date.now(), watchSeconds: 0 };
        await setKey("watchSessions", chatSessions);
      }
      if (data.messages && data.messages.length > 0) {
        const chatStoreData = await getStore();
        const clean = deduplicateSpam(data.messages);
        const hype = analyzeHype(clean, 30, chatStoreData.agentSettings);
        await addHypeScore(hype);
        chrome.runtime.sendMessage({ type: "HYPE_UPDATE", data: hype }).catch(() => {});

        // If hype spike detected, try to auto-tip immediately
        if (hype.isSpike && isReady() && data.creator) {
          const creatorAddr = await getCreator(data.creator);
          if (creatorAddr) {
            const store = await getStore();
            const tippedVideos = store.tippedVideos || {};
            // 5-minute window key to avoid spamming
            const hypeKey = `hype_${data.creator}_${Math.floor(Date.now() / 300000)}`;
            if (!tippedVideos[hypeKey]) {
              const budget = await getOrCreateBudget(data.creator);
              const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
              if (remaining > 0) {
                const tipAmt = Math.min(budget.tipPerEvent || 0.5, remaining);
                const llm = await llmEvaluate({
                  creatorUsername: data.creator, trigger: "hype_spike", ruleAmount: tipAmt,
                  hypeScore: hype.score, chatVelocity: hype.chatVelocity,
                  keywordHits: hype.keywordHits, sentimentScore: hype.sentimentScore,
                  watchMinutes: 0, budgetRemaining: remaining,
                  budgetMonthly: budget.monthlyBudgetUSDT,
                  spentToday: store.dailySpend || 0,
                  tipHistory: (store.tips || []).filter((t) => t.creatorUsername === data.creator && Date.now() - t.timestamp < 86400000).length,
                });
                if (llm.shouldTip) {
                  const amt = llm.adjustedAmount || tipAmt;
                  const tx = await sendTip(creatorAddr, amt, data.creator, "hype_spike");
                  tx.aiMode = llm.mode; tx.aiConfidence = llm.confidence; tx.aiReasoning = llm.reasoning;
                  await addTip(tx);
                  tippedVideos[hypeKey] = Date.now();
                  await setKey("tippedVideos", tippedVideos);
                  chrome.runtime.sendMessage({ type: "TIP_SENT", data: tx }).catch(() => {});
                  try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TIP_SENT", data: tx });
                  } catch (_) {}
                  console.log(`[Agent] ✅ Hype-tip $${amt} to ${data.creator} (score: ${hype.score})`);
                }
              }
            }
          }
        }
        return { success: true, data: hype };
      }
      return { success: true };
    }

    // ═══ CREATOR_DETECTED (from content script HTMX extraction) ═══
    case "CREATOR_DETECTED": {
      const detName = data.creatorName || data.username;
      const detAddr = data.creatorAddress || data.address;
      const detBtc = data.btcAddress || null;

      if (detName && detAddr && /^0x[a-fA-F0-9]{40}$/.test(detAddr)) {
        await setCreator(detName, detAddr, detBtc);
        console.log(`[TipStream] Creator: ${detName} → ${detAddr}${detBtc ? " | BTC: " + detBtc : ""}`);
      } else if (detName && detBtc) {
        // Only BTC address (no EVM)
        await setCreator(detName, null, detBtc);
        console.log(`[TipStream] Creator (BTC only): ${detName} → ${detBtc}`);
      }

      if (detName) {
        const csStore = await getStore();
        const csSessions = { ...(csStore.watchSessions || {}) };
        csSessions["detected"] = {
          creator: detName,
          creatorAddress: detAddr || null,
          btcAddress: detBtc,
          lastUpdate: Date.now(), watchSeconds: 0,
        };
        await setKey("watchSessions", csSessions);
      }
      return { success: true };
    }

    // ═══ MANUAL AGENT CYCLE (sidebar "Run Agent Cycle" button) ═══
    case "AGENT_RUN_CYCLE": {
      const store = await getStore();
      const results = { hype: null, decisions: [], tips: [], llm: null, message: "", targetCreator: null };

      // Find current creator from watch sessions
      const sessions = store.watchSessions || {};
      let targetCreator = null;
      let targetAddress = null;
      let watchSecs = 0;

      for (const [key, session] of Object.entries(sessions)) {
        if (session.creator && Date.now() - session.lastUpdate < 120000) {
          targetCreator = session.creator;
          targetAddress = session.creatorAddress || await getCreator(session.creator);
          watchSecs = session.watchSeconds || 0;
          break;
        }
      }

      // Get hype data
      const storedHype = await getLatestHype();
      if (storedHype && Date.now() - storedHype.timestamp < 60000) {
        results.hype = storedHype;
      }

      if (!results.hype) {
        results.message = "No chat data — open a Rumble livestream and wait for chat";
        results.targetCreator = targetCreator;
        return { success: true, data: results };
      }

      results.targetCreator = targetCreator;

      if (!targetCreator) {
        results.message = `Hype: ${results.hype.score}/100 but no creator detected`;
        return { success: true, data: results };
      }

      results.message = `${targetCreator} (${Math.floor(watchSecs / 60)}m)`;
      const threshold = store.agentSettings?.hypeThreshold || 70;

      if (results.hype.isSpike && isReady() && targetAddress) {
        const budget = await getOrCreateBudget(targetCreator);
        const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
        const tipAmt = Math.min(budget.tipPerEvent || 0.5, remaining);

        if (remaining <= 0) {
          results.message = `${targetCreator} — monthly budget exhausted`;
          return { success: true, data: results };
        }

        const recentTips = (store.tips || []).filter(
          (t) => t.creatorUsername === targetCreator && Date.now() - t.timestamp < 86400000
        ).length;

        const llmResult = await llmEvaluate({
          creatorUsername: targetCreator, trigger: "hype_spike", ruleAmount: tipAmt,
          hypeScore: results.hype.score, chatVelocity: results.hype.chatVelocity,
          keywordHits: results.hype.keywordHits, sentimentScore: results.hype.sentimentScore,
          watchMinutes: Math.floor(watchSecs / 60),
          budgetRemaining: remaining, budgetMonthly: budget.monthlyBudgetUSDT,
          spentToday: store.dailySpend || 0, tipHistory: recentTips,
        });
        results.llm = llmResult;

        if (llmResult.shouldTip) {
          const amt = llmResult.adjustedAmount || tipAmt;
          const tx = await sendTip(targetAddress, amt, targetCreator, "hype_spike");
          tx.aiMode = llmResult.mode; tx.aiConfidence = llmResult.confidence; tx.aiReasoning = llmResult.reasoning;
          await addTip(tx);
          results.tips.push(tx);
          results.message = `Tipped $${amt} to ${targetCreator} (${llmResult.mode})`;
        } else {
          results.message = `LLM vetoed: ${llmResult.reasoning}`;
        }
      } else if (!targetAddress) {
        results.message = `${targetCreator} — no wallet. Register in TIP tab.`;
      } else {
        results.message = `${targetCreator} — Hype ${results.hype.score}/${threshold} (monitoring)`;
      }

      return { success: true, data: results };
    }

    // ═══ AGENT SETTINGS ═══
    case "AGENT_TOGGLE_AUTO": {
      const storeAT = await getStore();
      const newState = !storeAT.autoTipEnabled;
      await setKey("autoTipEnabled", newState);
      return { success: true, data: { autoTipEnabled: newState } };
    }
    case "AGENT_SETTINGS_SAVE": {
      await saveAgentSettings(data);
      return { success: true, data: await getAgentSettings() };
    }
    case "AGENT_SETTINGS_GET": {
      return { success: true, data: await getAgentSettings() };
    }

    // ═══ OPENAI KEY ═══
    case "OPENAI_KEY_SAVE": {
      await setKey("openaiApiKey", data.apiKey || "");
      return { success: true, data: { saved: true, llmEnabled: !!(data.apiKey) } };
    }
    case "OPENAI_KEY_GET": {
      const oaKey = await getKey("openaiApiKey");
      return { success: true, data: { hasKey: !!oaKey, llmEnabled: !!oaKey } };
    }

    // ═══ HYPE / DASHBOARD ═══
    case "HYPE_GET": {
      return { success: true, data: { current: await getLatestHype(), history: await getHypeHistory(20) } };
    }
    case "DASHBOARD_GET": {
      return { success: true, data: await getDashboard() };
    }

    // ═══ CONTENT LOG RELAY ═══
    case "CONTENT_LOG": {
      console.log(data.message);
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ── Daily spending reset alarm ──
try {
  chrome.alarms.create("resetDailySpending", {
    when: getNextMidnight(),
    periodInMinutes: 24 * 60,
  });
} catch (_) {}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "resetDailySpending") {
    setKey("dailySpend", 0);
    setKey("tippedVideos", {});
    console.log("[TipStream] Daily reset");
  }
});

function getNextMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// ── Auto-tip interval (listens for toggle) ──
let autoTipInterval = null;

chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoTipEnabled) {
    if (changes.autoTipEnabled.newValue) {
      console.log("[TipStream] Auto-tip ON");
      // Auto-tip is primarily driven by WATCH_UPDATE from content script
      // This interval is a fallback for Rumble API polling
      autoTipInterval = setInterval(async () => {
        const store = await getStore();
        if (!store.autoTipEnabled || !store.rumbleApiKey) return;
        try {
          const res = await fetch(`${RUMBLE_API_URL}?key=${store.rumbleApiKey}`);
          const rd = await res.json();
          const ls = rd.livestreams?.find((l) => l.is_live);
          if (ls && ls.chat && ls.chat.length > 0) {
            const messages = ls.chat.map((m) => ({
              id: m.id, text: m.text, username: m.username,
              user_id: m.user_id || m.username, timestamp: m.time || Date.now(),
            }));
            const clean = deduplicateSpam(messages);
            const hype = analyzeHype(clean, 30, store.agentSettings);
            await addHypeScore(hype);
            chrome.runtime.sendMessage({ type: "HYPE_UPDATE", data: hype }).catch(() => {});
          }
        } catch (_) {}
      }, 10000);
    } else {
      console.log("[TipStream] Auto-tip OFF");
      if (autoTipInterval) clearInterval(autoTipInterval);
      autoTipInterval = null;
    }
  }
});

// ═══════════════════════════════════════════
// MILESTONE DETECTION
// Polls Rumble API, compares follower/subscriber
// counts to stored state, fires bonus tips on milestones
// ═══════════════════════════════════════════

const MILESTONE_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

function findCrossedMilestone(prev, current) {
  for (let i = MILESTONE_THRESHOLDS.length - 1; i >= 0; i--) {
    const t = MILESTONE_THRESHOLDS[i];
    if (current >= t && prev < t) return t;
  }
  return null;
}

async function checkMilestones() {
  const store = await getStore();
  if (!store.rumbleApiKey) return { checked: false, reason: "no_api_key" };

  try {
    const res = await fetch(`${RUMBLE_API_URL}?key=${store.rumbleApiKey}`);
    const rd = await res.json();
    const currentFollowers = rd.followers?.num_followers_total || 0;
    const currentSubs = rd.subscribers?.num_subscribers || 0;
    const username = rd.username;

    // Get livestream viewer count
    const livestream = rd.livestreams?.find((l) => l.is_live) || null;
    const currentViewers = livestream?.watching_now || 0;

    const milestoneState = await getMilestoneState();
    const prevFollowers = milestoneState.followers || 0;
    const prevSubs = milestoneState.subscribers || 0;
    const prevViewers = milestoneState.viewers || 0;
    const lastSpikeAt = milestoneState.lastSpikeAt || 0;

    const results = { milestones: [], followers: currentFollowers, subs: currentSubs, viewers: currentViewers };

    // ── Viewer Spike Detection ──
    // A "spike" is when viewers jump by ≥50% AND at least 10 new viewers
    // (prevents noise from small streams: 2→3 viewers = 50% but not meaningful)
    if (prevViewers > 0 && currentViewers > 0 && livestream) {
      const increase = currentViewers - prevViewers;
      const pctIncrease = (increase / prevViewers) * 100;
      const spikeCooldown = 300000; // 5 min between spike tips

      if (increase >= 10 && pctIncrease >= 50 && (Date.now() - lastSpikeAt) > spikeCooldown) {
        console.log(`[Spike] 📈 ${username}: ${prevViewers} → ${currentViewers} viewers (+${pctIncrease.toFixed(0)}%)`);
        results.milestones.push({ type: "viewer_spike", value: currentViewers, previousValue: prevViewers, pctIncrease: Math.round(pctIncrease), username });

        // Auto-tip on viewer spike
        if (isReady() && username) {
          const addr = await getCreator(username);
          if (addr) {
            const budget = await getOrCreateBudget(username);
            const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
            // Tip scales with spike magnitude: 1.5× for 50-100%, 2× for 100-200%, 2.5× for 200%+
            const spikeMult = pctIncrease >= 200 ? 2.5 : pctIncrease >= 100 ? 2 : 1.5;
            const tipAmt = Math.min(Math.round(budget.tipPerEvent * spikeMult * 100) / 100, remaining);
            if (tipAmt >= 0.01) {
              const llm = await llmEvaluate({
                creatorUsername: username, trigger: "viewer_spike", ruleAmount: tipAmt,
                hypeScore: 0, chatVelocity: 0, keywordHits: [], sentimentScore: 0,
                watchMinutes: 0, budgetRemaining: remaining,
                budgetMonthly: budget.monthlyBudgetUSDT,
                spentToday: store.dailySpend || 0,
                tipHistory: (store.tips || []).filter((t) => t.creatorUsername === username && Date.now() - t.timestamp < 86400000).length,
              });
              if (llm.shouldTip) {
                const amt = llm.adjustedAmount || tipAmt;
                const tx = await sendTip(addr, amt, username, "viewer_spike");
                tx.aiMode = llm.mode; tx.aiConfidence = llm.confidence;
                tx.aiReasoning = `Viewer spike: ${prevViewers}→${currentViewers} (+${Math.round(pctIncrease)}%)`;
                tx.viewerSpike = { from: prevViewers, to: currentViewers, pct: Math.round(pctIncrease) };
                await addTip(tx);
                chrome.runtime.sendMessage({ type: "TIP_SENT", data: tx }).catch(() => {});
                chrome.runtime.sendMessage({
                  type: "VIEWER_SPIKE",
                  data: { from: prevViewers, to: currentViewers, pct: Math.round(pctIncrease), username, tx },
                }).catch(() => {});
                console.log(`[Spike] ✅ Tipped $${amt} for viewer spike (${prevViewers}→${currentViewers})`);
                // Update spike timestamp
                milestoneState.lastSpikeAt = Date.now();
              }
            }
          }
        }
      }
    }

    // ── Viewer Milestone Detection ──
    // Also check if viewer count crosses round milestones (100, 500, 1000, etc.)
    const viewerMilestone = findCrossedMilestone(prevViewers, currentViewers);
    if (viewerMilestone && livestream) {
      console.log(`[Milestone] 👁️ ${username} hit ${viewerMilestone} concurrent viewers!`);
      results.milestones.push({ type: "viewer_milestone", value: viewerMilestone, username });
      chrome.runtime.sendMessage({
        type: "MILESTONE_HIT",
        data: { type: "viewer", value: viewerMilestone, username },
      }).catch(() => {});
    }

    // Check follower milestone
    const followerMilestone = findCrossedMilestone(prevFollowers, currentFollowers);
    if (followerMilestone) {
      console.log(`[Milestone] 🎉 ${username} hit ${followerMilestone} followers!`);
      results.milestones.push({ type: "follower", value: followerMilestone, username });

      // Auto-tip if wallet ready and creator registered
      if (isReady() && username) {
        const addr = await getCreator(username);
        if (addr) {
          const budget = await getOrCreateBudget(username);
          const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
          const tipAmt = Math.min(budget.tipPerEvent * 2, remaining); // Double tip for milestones
          if (tipAmt >= 0.01) {
            const tx = await sendTip(addr, tipAmt, username, "milestone_follower");
            tx.aiMode = "rules";
            tx.aiConfidence = 1;
            tx.aiReasoning = `Follower milestone: ${followerMilestone} reached!`;
            tx.milestoneValue = followerMilestone;
            await addTip(tx);
            chrome.runtime.sendMessage({ type: "TIP_SENT", data: tx }).catch(() => {});
            chrome.runtime.sendMessage({ type: "MILESTONE_HIT", data: { type: "follower", value: followerMilestone, username, tx } }).catch(() => {});
            console.log(`[Milestone] ✅ Tipped $${tipAmt} for ${followerMilestone} followers`);
          }
        }
      }
    }

    // Check subscriber milestone
    const subMilestone = findCrossedMilestone(prevSubs, currentSubs);
    if (subMilestone) {
      console.log(`[Milestone] 🎉 ${username} hit ${subMilestone} subscribers!`);
      results.milestones.push({ type: "subscriber", value: subMilestone, username });

      if (isReady() && username) {
        const addr = await getCreator(username);
        if (addr) {
          const budget = await getOrCreateBudget(username);
          const remaining = budget.monthlyBudgetUSDT - budget.spentThisMonthUSDT;
          const tipAmt = Math.min(budget.tipPerEvent * 3, remaining); // Triple tip for sub milestones
          if (tipAmt >= 0.01) {
            const tx = await sendTip(addr, tipAmt, username, "milestone_subscriber");
            tx.aiMode = "rules";
            tx.aiConfidence = 1;
            tx.aiReasoning = `Subscriber milestone: ${subMilestone} reached!`;
            tx.milestoneValue = subMilestone;
            await addTip(tx);
            chrome.runtime.sendMessage({ type: "TIP_SENT", data: tx }).catch(() => {});
            chrome.runtime.sendMessage({ type: "MILESTONE_HIT", data: { type: "subscriber", value: subMilestone, username, tx } }).catch(() => {});
            console.log(`[Milestone] ✅ Tipped $${tipAmt} for ${subMilestone} subscribers`);
          }
        }
      }
    }

    // Save current state
    await setMilestoneState({
      followers: currentFollowers, subscribers: currentSubs,
      viewers: currentViewers, lastSpikeAt: milestoneState.lastSpikeAt || lastSpikeAt,
      lastCheck: Date.now(),
    });
    return results;
  } catch (err) {
    console.warn("[Milestone] Check failed:", err.message);
    return { checked: false, reason: err.message };
  }
}

// Milestone check alarm — every 60 seconds when auto-tip is on
try {
  chrome.alarms.create("milestoneCheck", { periodInMinutes: 1 });
} catch (_) {}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "milestoneCheck") {
    getStore().then((store) => {
      if (store.autoTipEnabled && store.rumbleApiKey) {
        checkMilestones();
      }
    });
  }
});