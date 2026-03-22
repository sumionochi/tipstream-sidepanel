// ═══════════════════════════════════════════
// TipStream Extension — Config
// ═══════════════════════════════════════════

export const CHAINS = {
  polygon: {
    name: "Polygon",
    rpcUrl: "https://polygon-rpc.com",
    chainId: 137,
    explorer: "https://polygonscan.com",
    gasNote: "~$0.001",
  },
  arbitrum: {
    name: "Arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
    explorer: "https://arbiscan.io",
    gasNote: "~$0.01",
  },
  ethereum: {
    name: "Ethereum",
    rpcUrl: "https://eth.drpc.org",
    chainId: 1,
    explorer: "https://etherscan.io",
    gasNote: "~$1-5",
  },
  sepolia: {
    name: "Sepolia (Testnet)",
    rpcUrl: "https://sepolia.drpc.org",
    chainId: 11155111,
    explorer: "https://sepolia.etherscan.io",
    gasNote: "Free (testnet)",
  },
  bitcoin: {
    name: "Bitcoin",
    type: "btc",
    explorer: "https://mempool.space",
    gasNote: "~$0.50-5",
  },
};

export const TOKENS = {
  USDT: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    addresses: {
      polygon: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      sepolia: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
    },
  },
  USDT0: {
    symbol: "USDT0",
    name: "USD₮0",
    decimals: 6,
    addresses: {
      polygon: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      ethereum: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      sepolia: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
    },
  },
  XAUT: {
    symbol: "XAUT",
    name: "Tether Gold",
    decimals: 6,
    addresses: {
      ethereum: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
      sepolia: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
    },
  },
};

// Aave V3 pool addresses
export const AAVE = {
  polygon: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  sepolia: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
};

export const DEFAULT_CHAIN = "sepolia";

export const AGENT_DEFAULTS = {
  hypeThreshold: 70,
  defaultTipAmount: 0.5,
  maxTipPerEvent: 5.0,
  cooldownSeconds: 60,
  monthlyBudgetDefault: 20,
};

export const RUMBLE_API_URL = "https://rumble.com/-livestream-api/get-data";