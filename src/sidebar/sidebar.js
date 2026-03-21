// ═══════════════════════════════════════════
// TipStream Extension — Sidebar UI Logic
// Communicates with service worker via chrome.runtime.sendMessage
// ═══════════════════════════════════════════

const EXPLORERS = {
  polygon: "https://polygonscan.com",
  arbitrum: "https://arbiscan.io",
  ethereum: "https://etherscan.io",
  sepolia: "https://sepolia.etherscan.io",
};

// ── Helpers ──

function msg(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, data }, (res) => resolve(res || { success: false }));
  });
}

function $(id) { return document.getElementById(id); }
function show(id) { $(id).style.display = ""; }
function hide(id) { $(id).style.display = "none"; }

function showMsg(type, text) {
  const el = type === "ok" ? $("msg-success") : $("msg-error");
  el.textContent = text;
  el.style.display = "";
  setTimeout(() => { el.style.display = "none"; }, 3500);
}

function shortAddr(a) { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "—"; }

function txUrl(hash, chain) {
  const base = EXPLORERS[chain] || EXPLORERS.sepolia;
  return `${base}/tx/${hash}`;
}

function addrUrl(addr, chain) {
  const base = EXPLORERS[chain] || EXPLORERS.sepolia;
  return `${base}/address/${addr}`;
}

// ── State ──

let walletReady = false;
let currentChain = "sepolia";
let autoTipOn = false;
let logCount = 0;

// ── Agent Log ──

function addLog(text, type) {
  const log = $("agent-log");
  if (!log) return;
  logCount++;
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const entry = document.createElement("div");
  entry.className = `log-entry ${type ? "log-" + type : ""}`;
  entry.innerHTML = `<span class="log-time">${time}</span>${text}`;
  // Prepend (newest first)
  log.insertBefore(entry, log.firstChild);
  // Cap at 50
  while (log.children.length > 50) log.removeChild(log.lastChild);
  if ($("agent-log-count")) $("agent-log-count").textContent = logCount;
}

function updateAIBadge(mode) {
  const badge = $("ai-badge");
  if (!badge) return;
  if (mode === "ai") {
    badge.textContent = "AI";
    badge.className = "ai-badge ai-active";
  } else {
    badge.textContent = "RULES";
    badge.className = "ai-badge";
  }
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════

async function init() {
  // Check wallet status
  const walletRes = await msg("WALLET_GET");
  if (walletRes.success) {
    walletReady = true;
    currentChain = walletRes.data.chain;
    showDashboard();
    updateWallet(walletRes.data);
  } else {
    showOnboarding();
  }

  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Buttons
  $("btn-gen-seed").onclick = generateSeed;
  $("btn-connect").onclick = connectWallet;
  $("btn-auto-tip").onclick = toggleAutoTip;
  $("btn-cycle").onclick = runCycle;
  $("btn-rumble").onclick = connectRumble;
  $("btn-rumble-dc").onclick = disconnectRumble;
  $("btn-register").onclick = registerCreator;
  $("btn-tip").onclick = sendTip;
  $("btn-budget").onclick = saveBudget;
  $("btn-pool").onclick = createPool;
  $("btn-save-settings").onclick = saveSettings;
  $("btn-chain").onclick = switchChain;
  $("btn-disconnect").onclick = disconnectWallet;

  // OpenAI key
  $("btn-save-openai").onclick = saveOpenAIKey;

  // Hype slider label
  $("set-hype").oninput = () => { $("set-hype-val").textContent = $("set-hype").value; };

  // Listen for updates from service worker
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "TIP_SENT") {
      const tx = m.data;
      showMsg("ok", `Tip sent: $${tx.amount} → ${tx.creatorUsername}`);
      const aiInfo = tx.aiMode === "ai"
        ? ` <span style="color:#A5B4FC">[AI ${(tx.aiConfidence * 100).toFixed(0)}%]</span> ${tx.aiReasoning || ""}`
        : ` [RULES]`;
      addLog(`✅ $${tx.amount} → ${tx.creatorUsername} (${tx.triggerReason || tx.trigger || "auto"})${aiInfo}`, "tip");
      updateAIBadge(tx.aiMode || "rules");
      $("agent-status").textContent = "TIPPED";
      $("agent-status").style.color = "var(--accent)";
      $("agent-creator").textContent = tx.creatorUsername || "—";
      refreshDashboard();
    }
    if (m.type === "HYPE_UPDATE") {
      updateHype(m.data);
      const h = m.data;
      if (h.isSpike) {
        addLog(`🔥 HYPE SPIKE ${h.score}/100 | ${h.chatVelocity} msg/s | keys: ${h.keywordHits?.join(", ") || "—"}`, "hype");
      }
    }
  });

  // Check OpenAI key status
  const oaRes = await msg("OPENAI_KEY_GET");
  if (oaRes.success && oaRes.data.hasKey) {
    updateAIBadge("ai");
    if ($("ai-status-text")) {
      $("ai-status-text").textContent = "GPT-4o-mini active — evaluating with confidence scoring";
      $("ai-status-text").className = "setting-desc ai-on";
    }
  }

  addLog("Agent initialized — watching for activity", "dim");

  // Load settings
  const settingsRes = await msg("AGENT_SETTINGS_GET");
  if (settingsRes.success) {
    const s = settingsRes.data;
    $("set-hype").value = s.hypeThreshold || 70;
    $("set-hype-val").textContent = s.hypeThreshold || 70;
    $("set-tip").value = s.defaultTipAmount || 0.5;
    $("set-max").value = s.maxTipPerEvent || 5;
    $("set-cd").value = s.cooldownSeconds || 60;
    $("set-budget").value = s.monthlyBudgetDefault || 20;
  }

  // Load Rumble status
  const rumbleRes = await msg("RUMBLE_STATUS");
  if (rumbleRes.success) updateRumble(rumbleRes.data);

  // Load chain selector
  const store = await new Promise((r) => chrome.storage.local.get("walletChain", r));
  if (store.walletChain) {
    $("setting-chain").value = store.walletChain;
    currentChain = store.walletChain;
  }
}

// ── Views ──

function showOnboarding() {
  show("view-onboard");
  hide("view-dashboard");
  hide("view-tip");
  hide("view-history");
  hide("view-settings");
}

function showDashboard() {
  hide("view-onboard");
  show("view-dashboard");
  refreshDashboard();
  refreshConnections();
}

function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector(`[data-tab="${tab}"]`).classList.add("active");
  ["dashboard", "tip", "history", "settings"].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.style.display = v === tab ? "" : "none";
  });
  hide("view-onboard");

  if (tab === "dashboard") refreshDashboard();
  if (tab === "tip") refreshCreators();
  if (tab === "history") refreshHistory();
  if (tab === "settings") refreshConnections();
}

// ══════════════════════════════════════════
// WALLET
// ══════════════════════════════════════════

async function generateSeed() {
  $("btn-gen-seed").textContent = "GENERATING...";
  const res = await msg("WALLET_GENERATE_SEED");
  $("btn-gen-seed").textContent = "GENERATE SEED PHRASE";

  if (res.success) {
    const seed = res.data.seedPhrase;
    $("input-seed").value = seed;
    const grid = $("seed-display");
    grid.innerHTML = seed.split(" ").map((w, i) =>
      `<div class="seed-word"><span class="num">${i + 1}.</span> ${w}</div>`
    ).join("");
    show("seed-display");
    showMsg("ok", "Seed generated — save it securely!");
  }
}

async function connectWallet() {
  const seed = $("input-seed").value.trim();
  if (!seed || seed.split(" ").length < 12) {
    showMsg("err", "Enter a valid 12 or 24 word seed phrase");
    return;
  }

  $("btn-connect").textContent = "CONNECTING...";
  $("btn-connect").disabled = true;

  const res = await msg("WALLET_INIT", { seed });

  $("btn-connect").textContent = "CONNECT";
  $("btn-connect").disabled = false;

  if (res.success) {
    walletReady = true;
    currentChain = res.data.chain;
    showMsg("ok", `Wallet: ${shortAddr(res.data.address)}`);
    showDashboard();
    // Fetch full balances
    const bal = await msg("WALLET_GET");
    if (bal.success) updateWallet(bal.data);
  } else {
    showMsg("err", res.error || "Connection failed");
  }
}

async function disconnectWallet() {
  await new Promise((r) => chrome.storage.local.clear(r));
  walletReady = false;
  showMsg("ok", "Wallet disconnected");
  showOnboarding();
}

function updateWallet(data) {
  $("wallet-address").textContent = data.address;
  $("stat-eth").textContent = parseFloat(data.balanceETH).toFixed(4);
  $("stat-usdt").textContent = `$${data.balanceUSDT}`;
  $("stat-chain").textContent = (data.chain || "sepolia").toUpperCase();
  $("wallet-link").href = addrUrl(data.address, data.chain);
  currentChain = data.chain;
}

async function switchChain() {
  const chain = $("setting-chain").value;
  $("btn-chain").textContent = "SWITCHING...";
  const res = await msg("WALLET_SWITCH_CHAIN", { chain });
  $("btn-chain").textContent = "SWITCH CHAIN";
  if (res.success) {
    currentChain = chain;
    showMsg("ok", `Switched to ${chain}`);
    const bal = await msg("WALLET_GET");
    if (bal.success) updateWallet(bal.data);
  } else {
    showMsg("err", res.error);
  }
}

// ══════════════════════════════════════════
// RUMBLE
// ══════════════════════════════════════════

async function connectRumble() {
  const key = $("input-rumble").value.trim();
  if (!key) return;
  $("btn-rumble").textContent = "CONNECTING...";
  const res = await msg("RUMBLE_CONNECT", { apiKey: key });
  $("btn-rumble").textContent = "CONNECT RUMBLE";
  if (res.success) {
    showMsg("ok", `Rumble: @${res.data.username}`);
    updateRumble({ username: res.data.username, followers: res.data.followers, isLive: false });
  } else {
    showMsg("err", res.error);
  }
}

async function disconnectRumble() {
  await msg("RUMBLE_DISCONNECT");
  hide("rumble-connected");
  show("rumble-disconnected");
  showMsg("ok", "Rumble disconnected");
}

function updateRumble(data) {
  if (data.username) {
    show("rumble-connected");
    hide("rumble-disconnected");
    $("rumble-user").textContent = `@${data.username}`;
    $("stat-live").textContent = data.isLive ? "🔴 LIVE" : "OFFLINE";
    $("stat-live").style.color = data.isLive ? "#EF4444" : "";
    $("stat-followers").textContent = data.followers || 0;
  }
}

// ══════════════════════════════════════════
// AGENTS
// ══════════════════════════════════════════

async function toggleAutoTip() {
  const res = await msg("AGENT_TOGGLE_AUTO");
  if (res.success) {
    autoTipOn = res.data.autoTipEnabled;
    const btn = $("btn-auto-tip");
    btn.textContent = autoTipOn ? "ON" : "OFF";
    btn.classList.toggle("active", autoTipOn);
    $("agent-status").textContent = autoTipOn ? "MONITORING" : "IDLE";
    $("agent-status").style.color = autoTipOn ? "#F59E0B" : "";
    addLog(autoTipOn ? "🟢 AI Monitor ON — auto-tipping enabled" : "🔴 AI Monitor OFF", autoTipOn ? "tip" : "");
    showMsg("ok", autoTipOn ? "Auto-tip ON" : "Auto-tip OFF");
  }
}

async function runCycle() {
  $("btn-cycle").textContent = "RUNNING...";
  $("btn-cycle").disabled = true;
  $("agent-status").textContent = "RUNNING";
  $("agent-status").style.color = "#F59E0B";
  addLog("⚡ Manual agent cycle triggered", "");

  const res = await msg("AGENT_RUN_CYCLE");
  $("btn-cycle").textContent = "⚡ RUN AGENT CYCLE";
  $("btn-cycle").disabled = false;

  if (res.success) {
    const d = res.data;
    if (d.hype) {
      updateHype(d.hype);
      addLog(`Hype: ${d.hype.score}/100 | vel: ${d.hype.chatVelocity} msg/s | spike: ${d.hype.isSpike ? "YES" : "no"}`, d.hype.isSpike ? "hype" : "");
    }

    if (d.targetCreator) {
      $("agent-creator").textContent = d.targetCreator;
    }

    if (d.llm) {
      const llm = d.llm;
      addLog(`🧠 LLM: ${llm.shouldTip ? "APPROVE" : "VETO"} $${(llm.adjustedAmount || 0).toFixed(2)} (${(llm.confidence * 100).toFixed(0)}%) — ${llm.reasoning}`, llm.shouldTip ? "llm" : "veto");
      updateAIBadge(llm.mode || "rules");
    }

    if (d.tips?.length > 0) {
      $("agent-status").textContent = "TIPPED";
      $("agent-status").style.color = "var(--accent)";
    } else {
      $("agent-status").textContent = "IDLE";
      $("agent-status").style.color = "";
    }

    addLog(d.message || "Cycle complete", d.tips?.length ? "tip" : "gate");
    refreshDashboard();
  } else {
    addLog(`✗ Cycle error: ${res.error || "unknown"}`, "veto");
    $("agent-status").textContent = "ERROR";
    $("agent-status").style.color = "var(--red)";
  }
}

function updateHype(hype) {
  if (!hype) return;
  const score = hype.score || 0;
  const color = score >= 80 ? "#EF4444" : score >= 60 ? "#F59E0B" : score >= 30 ? "#3B82F6" : "#6B7280";

  $("hype-score").textContent = score;
  $("hype-score").style.color = color;
  $("hype-arc").setAttribute("stroke", color);
  $("hype-arc").setAttribute("stroke-dasharray", `${(score / 100) * 251} 251`);
  $("hype-vel").textContent = `${hype.chatVelocity || 0} msg/s`;
  $("hype-sent").textContent = `${((hype.sentimentScore || 0) * 100).toFixed(0)}%`;
  $("hype-emoji").textContent = `${((hype.emojiDensity || 0) * 100).toFixed(0)}%`;
  $("hype-keys").textContent = hype.keywordHits?.join(", ") || "—";
  $("hype-fill").style.width = `${score}%`;
  $("hype-fill").style.background = color;
}

// ══════════════════════════════════════════
// TIPS & CREATORS
// ══════════════════════════════════════════

async function registerCreator() {
  const user = $("reg-user").value.trim();
  const addr = $("reg-addr").value.trim();
  if (!user || !addr) return;
  const res = await msg("CREATOR_REGISTER", { username: user, address: addr });
  if (res.success) {
    showMsg("ok", `Registered ${user}`);
    $("reg-user").value = "";
    $("reg-addr").value = "";
    refreshCreators();
  } else {
    showMsg("err", res.error);
  }
}

async function sendTip() {
  const creator = $("tip-creator").value;
  const amount = $("tip-amount").value;
  if (!creator || !amount) return;

  $("btn-tip").textContent = "SENDING...";
  $("btn-tip").disabled = true;
  const res = await msg("TIP_SEND", { creatorUsername: creator, amount });
  $("btn-tip").textContent = "SEND TIP";
  $("btn-tip").disabled = false;

  if (res.success && res.data) {
    const tx = res.data;
    if (tx.status === "confirmed") {
      showMsg("ok", `$${tx.amount} → ${tx.creatorUsername} — ${shortAddr(tx.txHash)}`);
    } else {
      showMsg("err", `Tip failed: ${tx.error || "unknown error"}`);
    }
    refreshDashboard();
    refreshHistory();
  } else {
    showMsg("err", res.error);
  }
}

async function saveBudget() {
  const creator = $("budget-creator").value;
  if (!creator) return;
  await msg("BUDGET_SAVE", {
    creatorUsername: creator,
    monthlyBudgetUSDT: parseFloat($("budget-monthly").value),
    tipPerEvent: parseFloat($("budget-per").value),
    cooldownSeconds: parseInt($("budget-cd").value),
  });
  showMsg("ok", `Budget saved: ${creator}`);
  refreshCreators();
}

async function createPool() {
  const name = $("pool-name").value.trim();
  const creator = $("pool-creator").value.trim();
  if (!name || !creator) return;
  await msg("POOL_CREATE", { name, creatorUsername: creator, hypeThreshold: 75 });
  $("pool-name").value = "";
  $("pool-creator").value = "";
  showMsg("ok", `Pool created: ${name}`);
  refreshCreators();
}

async function saveOpenAIKey() {
  const key = $("input-openai").value.trim();
  $("btn-save-openai").textContent = "SAVING...";
  const res = await msg("OPENAI_KEY_SAVE", { apiKey: key });
  $("btn-save-openai").textContent = "SAVE API KEY";
  if (res.success) {
    if (key) {
      updateAIBadge("ai");
      $("ai-status-text").textContent = "GPT-4o-mini active — evaluating with confidence scoring";
      $("ai-status-text").className = "setting-desc ai-on";
      addLog("🧠 AI mode enabled — GPT-4o-mini will evaluate every tip", "llm");
      showMsg("ok", "API key saved — AI reasoning enabled");
    } else {
      updateAIBadge("rules");
      $("ai-status-text").textContent = "Rule-based mode — add API key for GPT-4o-mini";
      $("ai-status-text").className = "setting-desc";
      addLog("AI disabled — using rule-based logic", "");
      showMsg("ok", "API key cleared — rule-based mode");
    }
  }
}

async function saveSettings() {
  const res = await msg("AGENT_SETTINGS_SAVE", {
    hypeThreshold: parseInt($("set-hype").value),
    defaultTipAmount: parseFloat($("set-tip").value),
    maxTipPerEvent: parseFloat($("set-max").value),
    cooldownSeconds: parseInt($("set-cd").value),
    monthlyBudgetDefault: parseFloat($("set-budget").value),
  });
  if (res.success) showMsg("ok", "Settings saved");
  else showMsg("err", res.error);
}

// ══════════════════════════════════════════
// REFRESH
// ══════════════════════════════════════════

async function refreshDashboard() {
  const res = await msg("DASHBOARD_GET");
  if (!res.success) return;
  const d = res.data;

  $("stat-tipped").textContent = `$${(d.totalTipped || 0).toFixed(2)}`;
  $("stat-count").textContent = d.tipCount || 0;
  $("stat-fav").textContent = d.favoriteCreator || "—";

  // Wallet balance refresh
  const bal = await msg("WALLET_GET");
  if (bal.success) updateWallet(bal.data);

  // Hype
  const hypeRes = await msg("HYPE_GET");
  if (hypeRes.success && hypeRes.data.current) updateHype(hypeRes.data.current);
}

async function refreshCreators() {
  const creatorsRes = await msg("CREATOR_GET_ALL");
  const creators = creatorsRes.success ? creatorsRes.data : {};

  // Creators list
  const list = $("creators-list");
  list.innerHTML = Object.entries(creators).map(([u, a]) =>
    `<div class="list-item"><span class="name">${u}</span><a href="${addrUrl(a, currentChain)}" target="_blank" class="detail">${shortAddr(a)} ↗</a></div>`
  ).join("") || '<div class="hint">No creators registered</div>';

  // Dropdowns
  const options = Object.keys(creators).map((u) => `<option value="${u}">${u}</option>`).join("");
  $("tip-creator").innerHTML = `<option value="">select creator...</option>${options}`;
  $("budget-creator").innerHTML = `<option value="">select creator...</option>${options}`;

  // Budgets
  const budgetsRes = await msg("BUDGET_GET_ALL");
  const budgets = budgetsRes.success ? budgetsRes.data : [];
  $("budgets-list").innerHTML = budgets.map((b) =>
    `<div class="list-item"><span class="name">${b.creatorUsername}</span><span class="detail">$${b.spentThisMonthUSDT.toFixed(2)}/${b.monthlyBudgetUSDT} • $${b.tipPerEvent}/tip</span></div>`
  ).join("");

  // Pools
  const poolsRes = await msg("POOL_GET_ALL");
  const pools = poolsRes.success ? poolsRes.data : [];
  $("pools-list").innerHTML = pools.map((p) =>
    `<div class="list-item"><span class="name">${p.name}</span><span class="detail">${p.creatorUsername} • $${p.totalFunded.toFixed(2)}</span></div>`
  ).join("") || '<div class="hint">No pools</div>';
}

async function refreshHistory() {
  const res = await msg("TIP_HISTORY", { limit: 20 });
  const tips = res.success ? res.data : [];

  $("history-list").innerHTML = tips.map((t) => {
    const icon = t.triggerReason === "hype_spike" ? "🔥" :
                 t.triggerReason === "manual" ? "👆" :
                 t.triggerReason === "watch_time" ? "⏱" :
                 t.triggerReason === "milestone_follower" ? "🎉" : "💰";
    const statusText = t.status === "confirmed" ? "✓" : "✗";
    const statusColor = t.status === "confirmed" ? "var(--accent)" : "var(--red)";
    const txLink = t.txHash ? `<a href="${txUrl(t.txHash, t.chain || currentChain)}" target="_blank" class="tip-tx">${shortAddr(t.txHash)} ↗</a>` : "";

    const aiTag = t.aiMode === "ai"
      ? `<span style="color:#A5B4FC;font-size:8px;font-family:var(--mono)">AI ${(t.aiConfidence * 100).toFixed(0)}%</span>`
      : t.aiMode === "rule-based"
      ? `<span style="color:var(--fg2);font-size:8px;font-family:var(--mono)">RULES</span>`
      : "";
    const aiReason = t.aiReasoning
      ? `<div style="font-size:9px;color:var(--fg2);margin-top:2px;line-height:1.2;font-style:italic">${t.aiReasoning}</div>`
      : "";

    return `
      <div class="tip-item">
        <div class="tip-left">
          <span class="tip-icon">${icon}</span>
          <div class="tip-info">
            <div class="tip-creator">${t.creatorUsername} ${aiTag}</div>
            <div class="tip-reason">${(t.triggerReason || t.trigger || "").replace(/_/g, " ")}</div>
            ${aiReason}
          </div>
        </div>
        <div class="tip-right">
          <div class="tip-amount">$${t.amount}</div>
          <div class="tip-status" style="color:${statusColor}">${statusText}</div>
          ${txLink}
        </div>
      </div>
    `;
  }).join("") || '<div class="hint">No tips yet</div>';
}

async function refreshConnections() {
  const store = await new Promise((r) => chrome.storage.local.get(null, r));
  const items = [
    { name: "WDK Wallet", ok: !!store.walletAddress, detail: store.walletAddress ? shortAddr(store.walletAddress) : "Not connected" },
    { name: "Rumble API", ok: !!store.rumbleApiKey, detail: store.rumbleUsername ? `@${store.rumbleUsername}` : "Not connected" },
    { name: "Chain", ok: true, detail: (store.walletChain || "sepolia").toUpperCase() },
    { name: "USDt Token", ok: true, detail: "Tether WDK" },
  ];

  $("connections-list").innerHTML = items.map((c) =>
    `<div class="conn-item"><span class="conn-name"><span class="dot ${c.ok ? "dot-green" : "dot-red"}"></span> ${c.name}</span><span class="conn-detail">${c.detail}</span></div>`
  ).join("");
}

// ── Start ──

init();