/**
 * TuringTrade AI Agent Bot
 *
 * Fetches live crypto prices, asks the AI to analyze them, then submits
 * real on-chain trades with the AI's full reasoning text.
 *
 * Setup:
 *   1. Copy .env and add:
 *        AGENT_PRIVATE_KEY=0x<fresh_wallet_key>
 *        AI_API_KEY=fe_oa_e0624acff671dda981f5f6938859479d5277ef7c8845f086
 *        AI_BASE_URL=https://api.openai.com/v1   # or your provider's URL
 *   2. Fund the agent wallet with testnet MNT (faucet: https://faucet.sepolia.mantle.xyz)
 *   3. node scripts/agent-bot.js
 */

require('dotenv').config()
const { ethers } = require('ethers')
const OpenAI = require('openai')

// ── Config ──────────────────────────────────────────────────────────────────

const RPC_URL              = 'https://rpc.sepolia.mantle.xyz'
const CONTRACT_ADDRESS     = '0xb5605cAc85c79a98679A743b8E077a21bC652b92'
const REGISTRY_ADDRESS     = '0xff08093DC2bBFde8a08F05C9c10fe9ae8757632B'
const POLL_MS              = 60_000          // how often to check for new rounds
const TRADE_INTERVAL_MS    = 4 * 60_000      // how often to trade inside a round (4 min)

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY
const AI_API_KEY  = process.env.AI_API_KEY
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1'
const AI_MODEL    = process.env.AI_MODEL    || 'gpt-4o-mini'

if (!PRIVATE_KEY) { console.error('ERROR: AGENT_PRIVATE_KEY not set'); process.exit(1) }
if (!AI_API_KEY)  { console.error('ERROR: AI_API_KEY not set');         process.exit(1) }

// ── Contracts ────────────────────────────────────────────────────────────────

const ABI = [
  'function roundCount() view returns (uint256)',
  'function getRound(uint256) view returns (tuple(uint256 id, uint256 entryFee, uint256 prizePool, uint256 startTime, uint256 endTime, uint8 state, address[] participantList, address winner, int256 winnerRoiBps))',
  'function getParticipant(uint256, address) view returns (tuple(address addr, bool isAI, int256 roiBps, uint256 tradeCount, bool liquidated, bool claimed))',
  'function enter(uint256 roundId, bool isAI) payable',
  'function submitTrade(uint256 roundId, string pair, int256 amountBps, bool isBuy, string reasoning)',
]

const REGISTRY_ABI = [
  'function ownerToAgent(address) view returns (uint256)',
  'function registerAgent(string name, string strategyDescription)',
]

const ROUND_STATE = { Open: 0, Active: 1, Finalizing: 2, Closed: 3 }

const PAIRS = [
  { symbol: 'MNT/USDT',  cgId: 'mantle' },
  { symbol: 'ETH/USDT',  cgId: 'ethereum' },
  { symbol: 'BTC/USDT',  cgId: 'bitcoin' },
  { symbol: 'ARB/USDT',  cgId: 'arbitrum' },
  { symbol: 'OP/USDT',   cgId: 'optimism' },
]

// tracks rounds this bot has entered / last-traded-in
const enteredRounds  = new Set()
const lastTradeTime  = {}   // roundId → timestamp

// ── Price fetch (CoinGecko free tier, no key) ────────────────────────────────

async function fetchPrices() {
  const ids = PAIRS.map(p => p.cgId).join(',')
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
  try {
    const res  = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    return PAIRS.map(p => ({
      symbol:    p.symbol,
      price:     data[p.cgId]?.usd         ?? null,
      change24h: data[p.cgId]?.usd_24h_change ?? null,
    }))
  } catch (err) {
    console.warn('[bot] Price fetch failed:', err.message)
    return PAIRS.map(p => ({ symbol: p.symbol, price: null, change24h: null }))
  }
}

// ── AI decision ──────────────────────────────────────────────────────────────

const ai = new OpenAI({
  apiKey:  AI_API_KEY,
  baseURL: AI_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': 'https://turingtrade.xyz',
    'X-Title': 'TuringTrade AI Agent',
  },
})

async function getAIDecision(roundId, minutesLeft, prices, myTradeHistory) {
  const priceTable = prices
    .map(p => p.price
      ? `  ${p.symbol}: $${p.price.toLocaleString()} (24h ${p.change24h >= 0 ? '+' : ''}${p.change24h?.toFixed(2)}%)`
      : `  ${p.symbol}: price unavailable`)
    .join('\n')

  const historyText = myTradeHistory.length === 0
    ? '  No trades yet this round.'
    : myTradeHistory.map(t => `  ${t.pair} ${t.isBuy ? 'BUY' : 'SELL'} ${t.amountBps / 100}%`).join('\n')

  const systemPrompt = `You are TuringBot, an autonomous AI trading agent competing in TuringTrade — a Human vs AI DeFi arena on Mantle Network. Your trades are permanent, public, and on-chain. Analyze real market data and make a decisive trade. Be concise but genuine in your reasoning. Never fabricate data.`

  const userPrompt = `
Round #${roundId} — ${minutesLeft} minutes remaining.

LIVE PRICES (CoinGecko):
${priceTable}

MY TRADES THIS ROUND:
${historyText}

Make your next trade. Respond ONLY with valid JSON (no markdown):
{
  "pair": "<one of: MNT/USDT, ETH/USDT, BTC/USDT, ARB/USDT, OP/USDT>",
  "isBuy": <true or false>,
  "amountBps": <integer 100–1000, in basis points of position size>,
  "reasoning": "<2-4 sentences explaining your decision based on the actual price data above>"
}`.trim()

  const completion = await ai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature:  0.7,
    max_tokens:   300,
    response_format: { type: 'json_object' },
  })

  const raw = completion.choices[0].message.content
  const parsed = JSON.parse(raw)

  // Validate fields
  const validPairs = PAIRS.map(p => p.symbol)
  if (!validPairs.includes(parsed.pair))     parsed.pair = 'ETH/USDT'
  if (typeof parsed.isBuy !== 'boolean')     parsed.isBuy = true
  parsed.amountBps = Math.max(100, Math.min(1000, Number(parsed.amountBps) || 500))
  if (!parsed.reasoning || parsed.reasoning.length < 10) parsed.reasoning = 'Strategic position based on current market conditions.'

  return parsed
}

// ── Core: execute one trade for a round ─────────────────────────────────────

async function executeTrade(contract, roundId, myAddress, myTradeHistory) {
  console.log(`\n[bot] ── Executing trade for round #${roundId} ──`)

  const [round, prices] = await Promise.all([
    contract.getRound(roundId),
    fetchPrices(),
  ])

  const now        = Math.floor(Date.now() / 1000)
  const minutesLeft = Math.max(0, Math.floor((Number(round.endTime) - now) / 60))

  console.log(`[bot] ${minutesLeft}m left in round | fetched ${prices.filter(p => p.price).length}/${prices.length} prices`)
  prices.forEach(p => p.price && console.log(`[bot]   ${p.symbol} $${p.price.toLocaleString()} (${p.change24h?.toFixed(2)}%)`))

  let decision
  try {
    decision = await getAIDecision(roundId, minutesLeft, prices, myTradeHistory)
  } catch (err) {
    console.error('[bot] AI API failed:', err.message)
    // Fallback: simple momentum strategy
    const best = prices.filter(p => p.change24h !== null).sort((a, b) => b.change24h - a.change24h)[0]
    decision = {
      pair:      best?.symbol ?? 'ETH/USDT',
      isBuy:     (best?.change24h ?? 0) > 0,
      amountBps: 500,
      reasoning: `AI API unavailable. Fallback: ${best?.symbol ?? 'ETH/USDT'} shows ${best?.change24h?.toFixed(2) ?? '0'}% 24h movement — positioning accordingly.`,
    }
  }

  console.log(`[bot] Decision: ${decision.isBuy ? 'BUY' : 'SELL'} ${decision.pair} @ ${decision.amountBps / 100}%`)
  console.log(`[bot] Reasoning: ${decision.reasoning}`)

  const tx = await contract.submitTrade(
    BigInt(roundId),
    decision.pair,
    BigInt(decision.amountBps),
    decision.isBuy,
    decision.reasoning,
  )
  console.log(`[bot] TX sent: ${tx.hash}`)
  await tx.wait()
  console.log(`[bot] Trade confirmed on-chain ✓`)

  lastTradeTime[roundId] = Date.now()
  return decision
}

// ── Core: enter a round ──────────────────────────────────────────────────────

async function enterRound(contract, roundId, entryFee) {
  console.log(`[bot] Entering round #${roundId} as AI (fee: ${ethers.formatEther(entryFee)} MNT)…`)
  const tx = await contract.enter(BigInt(roundId), true, { value: entryFee })
  console.log(`[bot] Enter TX: ${tx.hash}`)
  await tx.wait()
  console.log(`[bot] Entered round #${roundId} ✓`)
  enteredRounds.add(roundId)
}

// ── Main tick ────────────────────────────────────────────────────────────────

const myTradesByRound = {}  // roundId → decision[]

async function tick(contract, myAddress, provider) {
  const count = Number(await contract.roundCount())
  if (count === 0) return

  const now = Math.floor(Date.now() / 1000)

  for (let i = 0; i < count; i++) {
    try {
      const round = await contract.getRound(i)
      const state = Number(round.state)
      const endTime = Number(round.endTime)

      if (state !== ROUND_STATE.Active) continue
      if (now >= endTime)               continue  // round over, keeper handles finalize

      // Check if we're already a participant
      const participant = await contract.getParticipant(i, myAddress)
      const isParticipant = participant.addr !== ethers.ZeroAddress

      if (!isParticipant && !enteredRounds.has(i)) {
        // Check wallet balance before entering
        const balance = await provider.getBalance(myAddress)
        const entryFee = round.entryFee
        const gasBuffer = ethers.parseEther('0.01')
        if (balance < entryFee + gasBuffer) {
          console.warn(`[bot] Round #${i}: insufficient balance (${ethers.formatEther(balance)} MNT < ${ethers.formatEther(entryFee + gasBuffer)} MNT needed)`)
          continue
        }
        await enterRound(contract, i, entryFee)
      } else if (!enteredRounds.has(i)) {
        enteredRounds.add(i)  // already in, just mark it
      }

      // Decide whether to trade
      const timeSinceLastTrade = Date.now() - (lastTradeTime[i] ?? 0)
      const minutesLeft = (endTime - now) / 60

      if (minutesLeft < 1) continue  // too close to end

      if (timeSinceLastTrade >= TRADE_INTERVAL_MS) {
        if (!myTradesByRound[i]) myTradesByRound[i] = []
        const decision = await executeTrade(contract, i, myAddress, myTradesByRound[i])
        myTradesByRound[i].push(decision)
      } else {
        const waitMin = Math.ceil((TRADE_INTERVAL_MS - timeSinceLastTrade) / 60_000)
        console.log(`[bot] Round #${i}: next trade in ~${waitMin}m`)
      }
    } catch (err) {
      console.error(`[bot] Error processing round #${i}:`, err.message)
    }
  }
}

// ── Agent registration ───────────────────────────────────────────────────────

async function ensureAgentRegistered(wallet) {
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, wallet)

  const existingId = await registry.ownerToAgent(wallet.address)
  if (existingId > 0n) {
    console.log(`[bot] Agent already registered (ID #${existingId})`)
    return
  }

  console.log('[bot] Registering agent on-chain…')
  const tx = await registry.registerAgent(
    'TuringBot',
    'Momentum-aware AI agent. Analyzes live BTC/ETH/MNT/ARB/OP price data and 24h trend signals via LLM reasoning to determine optimal trade direction and sizing each round.',
  )
  console.log(`[bot] Register TX: ${tx.hash}`)
  await tx.wait()
  const newId = await registry.ownerToAgent(wallet.address)
  console.log(`[bot] Agent registered — ID #${newId} ✓`)
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet)

  const network = await provider.getNetwork()
  const balance = await provider.getBalance(wallet.address)

  console.log(`[bot] ══════════════════════════════════════`)
  console.log(`[bot] TuringTrade AI Agent Bot`)
  console.log(`[bot] Chain:    ${network.chainId}`)
  console.log(`[bot] Wallet:   ${wallet.address}`)
  console.log(`[bot] Balance:  ${ethers.formatEther(balance)} MNT`)
  console.log(`[bot] AI Model: ${AI_MODEL} via ${AI_BASE_URL}`)
  console.log(`[bot] Contract: ${CONTRACT_ADDRESS}`)
  console.log(`[bot] ══════════════════════════════════════\n`)

  if (balance < ethers.parseEther('0.05')) {
    console.warn('[bot] WARNING: Low balance. Fund this wallet from the Mantle Sepolia faucet.')
    console.warn(`[bot] Faucet: https://faucet.sepolia.mantle.xyz`)
    console.warn(`[bot] Address: ${wallet.address}`)
  }

  await ensureAgentRegistered(wallet)

  await tick(contract, wallet.address, provider)
  setInterval(() => tick(contract, wallet.address, provider), POLL_MS)
}

main().catch(err => {
  console.error('[bot] Fatal:', err)
  process.exit(1)
})
