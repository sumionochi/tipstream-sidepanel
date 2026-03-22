// ═══════════════════════════════════════════
// TipStream Extension — WDK Wallet
// EVM (Polygon/Arb/ETH/Sepolia) + Bitcoin via Tether WDK
// ═══════════════════════════════════════════

import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import WalletManagerBtc, { ElectrumWs } from "@tetherto/wdk-wallet-btc";
import { CHAINS, TOKENS, DEFAULT_CHAIN } from "./config.js";
import { getKey, setStore } from "./store.js";

// ── State ──

let wdkInstance = null;
let accountInstance = null;   // EVM account
let btcAccount = null;        // BTC account
let cachedAddress = null;     // EVM address
let cachedBtcAddress = null;  // BTC address

// ── Init ──

export async function initWallet(seed) {
  if (!seed || seed.split(" ").length < 12) {
    throw new Error("Invalid seed phrase — need 12 or 24 words");
  }

  const chain = (await getKey("walletChain")) || DEFAULT_CHAIN;
  const rpcUrl = CHAINS[chain]?.rpcUrl || CHAINS.sepolia.rpcUrl;

  // ── EVM init (always) ──
  console.log(`[WDK] Initializing EVM wallet on ${chain} (${rpcUrl})`);

  wdkInstance = new WDK(seed).registerWallet("evm", WalletManagerEvm, {
    provider: rpcUrl,
  });

  accountInstance = await wdkInstance.getAccount("evm", 0);
  cachedAddress = await accountInstance.getAddress();
  console.log(`[WDK] EVM wallet ready: ${cachedAddress}`);

  // ── BTC init (WebSocket transport for Chrome extension service worker) ──
  try {
    const electrumClient = new ElectrumWs({
      url: "wss://electrum.blockstream.info:50004",
      network: "bitcoin",
    });

    const btcManager = new WalletManagerBtc(seed, {
      client: electrumClient,
      network: "bitcoin",
    });

    // Timeout BTC init — Electrum WSS can be slow, don't block EVM wallet
    const btcInitPromise = btcManager.getAccount(0).then(async (acc) => {
      const addr = await acc.getAddress();
      return { acc, addr };
    });
    const btcTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("BTC init timeout (10s)")), 10000));
    const { acc, addr } = await Promise.race([btcInitPromise, btcTimeout]);
    btcAccount = acc;
    cachedBtcAddress = addr;
    console.log(`[WDK] BTC wallet ready: ${cachedBtcAddress}`);
  } catch (err) {
    console.warn(`[WDK] BTC init failed (non-fatal): ${err.message}`);
    btcAccount = null;
    cachedBtcAddress = null;
  }

  // Persist
  await setStore({
    walletSeed: seed,
    walletAddress: cachedAddress,
    walletBtcAddress: cachedBtcAddress || "",
    walletChain: chain,
  });

  console.log(`[WDK] Wallet ready: ${cachedAddress}` + (cachedBtcAddress ? ` | BTC: ${cachedBtcAddress}` : ""));
  return { address: cachedAddress, btcAddress: cachedBtcAddress || null, chain };
}

export async function restoreWallet() {
  const seed = await getKey("walletSeed");
  if (seed) {
    try {
      await initWallet(seed);
      return true;
    } catch (err) {
      console.error("[WDK] Failed to restore wallet:", err.message);
    }
  }
  return false;
}

export function isReady() {
  return !!accountInstance && !!cachedAddress;
}

export function isBtcReady() {
  return !!btcAccount && !!cachedBtcAddress;
}

export function getAddress() {
  return cachedAddress;
}

export function getBtcAddress() {
  return cachedBtcAddress;
}

// ── Balance ──

export async function getBalances() {
  if (!accountInstance) throw new Error("Wallet not initialized");

  const chain = (await getKey("walletChain")) || DEFAULT_CHAIN;
  let balanceETH = "0";
  let balanceUSDT = "0";
  let balanceBTC = "0";

  try {
    const native = await accountInstance.getBalance();
    balanceETH = (Number(native) / 1e18).toFixed(6);
  } catch (err) {
    console.warn("[WDK] Native balance error:", err.message);
  }

  try {
    const usdtAddr = TOKENS.USDT.addresses[chain];
    if (usdtAddr) {
      const tokenBal = await accountInstance.getTokenBalance(usdtAddr);
      balanceUSDT = (Number(tokenBal) / 1e6).toFixed(2);
    }
  } catch (err) {
    console.warn("[WDK] USDt balance error:", err.message);
  }

  // BTC balance (with timeout — Electrum WSS can be slow)
  if (btcAccount) {
    try {
      const btcBalPromise = btcAccount.getBalance();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000));
      const btcBal = await Promise.race([btcBalPromise, timeoutPromise]);
      balanceBTC = (Number(btcBal) / 1e8).toFixed(8);
    } catch (err) {
      console.warn("[WDK] BTC balance error:", err.message);
    }
  }

  return {
    address: cachedAddress,
    btcAddress: cachedBtcAddress || null,
    balanceETH, balanceUSDT, balanceBTC,
    chain,
    btcAvailable: !!btcAccount,
  };
}

// ── Transfer ──

export async function sendTip(recipientAddress, amountUSDT, creatorUsername, trigger) {
  if (!accountInstance) throw new Error("Wallet not initialized");

  const chain = (await getKey("walletChain")) || DEFAULT_CHAIN;
  const usdtAddr = TOKENS.USDT.addresses[chain];
  if (!usdtAddr) throw new Error(`No USDt address for chain: ${chain}`);

  const fromAddress = cachedAddress;
  const amountBase = BigInt(Math.floor(amountUSDT * 1e6));

  console.log(`[WDK] Tipping ${amountUSDT} USDt to ${recipientAddress} (${creatorUsername}) on ${chain}`);

  try {
    const result = await accountInstance.transfer({
      token: usdtAddr,
      recipient: recipientAddress,
      amount: amountBase,
    });

    console.log(`[WDK] Tip confirmed! Hash: ${result.hash}`);

    return {
      id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromAddress,
      toAddress: recipientAddress,
      amount: amountUSDT.toFixed(2),
      amountWei: amountBase.toString(),
      txHash: result.hash,
      creatorUsername,
      triggerReason: trigger,
      timestamp: Date.now(),
      status: "confirmed",
      chain,
    };
  } catch (err) {
    console.error(`[WDK] Tip failed:`, err.message);
    return {
      id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromAddress,
      toAddress: recipientAddress,
      amount: amountUSDT.toFixed(2),
      amountWei: amountBase.toString(),
      txHash: "",
      creatorUsername,
      triggerReason: trigger,
      timestamp: Date.now(),
      status: "failed",
      chain,
      error: err.message,
    };
  }
}

/**
 * Send BTC tip via WDK Bitcoin wallet
 */
export async function sendBtcTip(recipientBtcAddress, amountBTC, creatorUsername, trigger) {
  if (!btcAccount) throw new Error("BTC wallet not initialized");

  const fromAddress = cachedBtcAddress;
  const satoshis = BigInt(Math.floor(amountBTC * 1e8));

  console.log(`[WDK] BTC Tipping ${amountBTC} BTC to ${recipientBtcAddress} (${creatorUsername})`);

  try {
    const result = await btcAccount.sendTransaction({
      to: recipientBtcAddress,
      value: satoshis,
    });

    console.log(`[WDK] BTC Tip confirmed! TxID: ${result.hash || result.txid}`);

    return {
      id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromAddress,
      toAddress: recipientBtcAddress,
      amount: amountBTC.toFixed(8),
      txHash: result.hash || result.txid || "",
      creatorUsername,
      triggerReason: trigger,
      timestamp: Date.now(),
      status: "confirmed",
      chain: "bitcoin",
      token: "BTC",
    };
  } catch (err) {
    console.error(`[WDK] BTC Tip failed:`, err.message);
    return {
      id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromAddress,
      toAddress: recipientBtcAddress,
      amount: amountBTC.toFixed(8),
      txHash: "",
      creatorUsername,
      triggerReason: trigger,
      timestamp: Date.now(),
      status: "failed",
      chain: "bitcoin",
      token: "BTC",
      error: err.message,
    };
  }
}

/**
 * Smart Split Tip — splits a tip across creator + collaborators/causes
 * splits: [{ address, pct, label }] where pct is 1-100
 * Creator gets (100 - sum(pct))% of the total
 */
export async function sendSplitTip(creatorAddress, splits, totalAmountUSDT, creatorUsername, trigger) {
  if (!accountInstance) throw new Error("Wallet not initialized");

  const chain = (await getKey("walletChain")) || DEFAULT_CHAIN;
  const usdtAddr = TOKENS.USDT.addresses[chain];
  if (!usdtAddr) throw new Error(`No USDt address for chain: ${chain}`);

  const fromAddress = cachedAddress;
  const results = [];

  // Calculate amounts
  let splitTotal = 0;
  const splitPayments = [];
  for (const s of (splits || [])) {
    if (!s.address || !s.pct || s.pct <= 0) continue;
    const pct = Math.min(s.pct, 50); // Cap at 50% per split
    const amount = Math.round(totalAmountUSDT * (pct / 100) * 100) / 100;
    if (amount >= 0.01) {
      splitPayments.push({ address: s.address, amount, label: s.label || "split" });
      splitTotal += amount;
    }
  }
  const creatorAmount = Math.round((totalAmountUSDT - splitTotal) * 100) / 100;

  console.log(`[WDK] Smart split: $${creatorAmount} to ${creatorUsername} + ${splitPayments.length} splits ($${splitTotal})`);

  // Send to creator first
  if (creatorAmount >= 0.01) {
    try {
      const creatorBase = BigInt(Math.floor(creatorAmount * 1e6));
      const r = await accountInstance.transfer({ token: usdtAddr, recipient: creatorAddress, amount: creatorBase });
      console.log(`[WDK] Creator tip confirmed: ${r.hash}`);
      results.push({
        id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromAddress, toAddress: creatorAddress,
        amount: creatorAmount.toFixed(2), txHash: r.hash,
        creatorUsername, triggerReason: trigger,
        timestamp: Date.now(), status: "confirmed", chain,
        splitLabel: "creator",
      });
    } catch (err) {
      console.error(`[WDK] Creator tip failed:`, err.message);
      results.push({
        id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromAddress, toAddress: creatorAddress,
        amount: creatorAmount.toFixed(2), txHash: "",
        creatorUsername, triggerReason: trigger,
        timestamp: Date.now(), status: "failed", chain,
        splitLabel: "creator", error: err.message,
      });
    }
  }

  // Send to each split recipient
  for (const sp of splitPayments) {
    try {
      const spBase = BigInt(Math.floor(sp.amount * 1e6));
      const r = await accountInstance.transfer({ token: usdtAddr, recipient: sp.address, amount: spBase });
      console.log(`[WDK] Split tip (${sp.label}) confirmed: ${r.hash}`);
      results.push({
        id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromAddress, toAddress: sp.address,
        amount: sp.amount.toFixed(2), txHash: r.hash,
        creatorUsername: `${creatorUsername}/${sp.label}`,
        triggerReason: `${trigger}_split`,
        timestamp: Date.now(), status: "confirmed", chain,
        splitLabel: sp.label,
      });
    } catch (err) {
      console.error(`[WDK] Split (${sp.label}) failed:`, err.message);
      results.push({
        id: `tip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromAddress, toAddress: sp.address,
        amount: sp.amount.toFixed(2), txHash: "",
        creatorUsername: `${creatorUsername}/${sp.label}`,
        triggerReason: `${trigger}_split`,
        timestamp: Date.now(), status: "failed", chain,
        splitLabel: sp.label, error: err.message,
      });
    }
  }

  return results;
}

// ── Change chain ──

export async function switchChain(newChain) {
  if (!CHAINS[newChain]) throw new Error(`Unknown chain: ${newChain}`);
  await setStore({ walletChain: newChain });

  // Re-init wallet on new chain
  const seed = await getKey("walletSeed");
  if (seed) {
    await initWallet(seed);
  }

  return { chain: newChain };
}

// ── Generate seed ──

export function generateSeed() {
  return WDK.getRandomSeedPhrase();
}