# TuringTrade — Contracts & Bots

Smart contracts, keeper bot, and AI agent bot for [TuringTrade](https://github.com/Datwebguy/turingtrade).

---

## Contracts (Mantle Sepolia)

| Contract | Address | Purpose |
|---|---|---|
| TuringRound | `0xb5605cAc85c79a98679A743b8E077a21bC652b92` | Core round logic — entry, trading, finalization, prize claim |
| AgentRegistry | `0xff08093DC2bBFde8a08F05C9c10fe9ae8757632B` | ERC-8004 soulbound NFT — AI agent identity |
| ReasoningLog | `0x41AAb6A7B02D19ED30B49408C98648BBd34E032F` | Permanent on-chain storage of trade reasoning text |

---

## Scripts

| Script | Command | Description |
|---|---|---|
| `keeper.js` | `node scripts/keeper.js` | Polls every 60s, auto-finalizes rounds when they end |
| `agent-bot.js` | `node scripts/agent-bot.js` | AI agent — fetches live prices, reasons via LLM, trades on-chain |
| `create-demo-round.js` | `npx hardhat run scripts/create-demo-round.js --network mantleSepolia` | Creates a 15-minute test round |
| `finalize.js` | `npx hardhat run scripts/finalize.js --network mantleSepolia` | Manually finalize a specific round |

---

## Setup

```bash
npm install
```

Create `.env`:

```env
DEPLOYER_PRIVATE_KEY=0x...      # Owner wallet (creates rounds, submits results)
AGENT_PRIVATE_KEY=0x...         # Agent wallet (separate — enters rounds, trades)
AI_API_KEY=sk-or-...            # OpenRouter key (free tier: openrouter.ai)
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=openai/gpt-oss-20b:free
```

Fund the agent wallet with testnet MNT: [faucet.sepolia.mantle.xyz](https://faucet.sepolia.mantle.xyz)

---

## Deploying to Railway (24/7 bots)

Create two Railway services from this repo, each with a custom start command:

- **Keeper**: `node scripts/keeper.js`
- **AI Agent**: `node scripts/agent-bot.js`

Add all `.env` variables in Railway's Variables tab. No build step needed.

---

## Contract Overview

### TuringRound

The core game contract. Rounds flow through four states:

```
Open → Active → Finalizing → Closed
```

- `createRound(entryFee, startTime, endTime)` — owner only
- `enter(roundId, isAI)` — payable, requires registered agent if isAI
- `submitTrade(roundId, pair, amountBps, isBuy, reasoning)` — any participant, Active rounds only
- `submitResults(roundId, addrs, roiBpsArr, liquidatedArr)` — owner only, after endTime
- `claimPrize(roundId)` — winner only

### AgentRegistry (ERC-8004)

Soulbound NFT for AI agent identity. One agent per wallet. Non-transferable.

- `registerAgent(name, strategyDescription)` — mints a soulbound token
- `ownerToAgent(address)` — returns token ID for a wallet

### ReasoningLog

Append-only on-chain store for trade reasoning text (max 2048 chars per entry).

- `log(roundId, reasoning, dataHash)` — authorised callers only (TuringRound)
- `getAgentRoundEntries(agent, roundId)` — returns all entry IDs for an agent in a round

---

## License

MIT
