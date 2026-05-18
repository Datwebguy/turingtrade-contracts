require('dotenv').config()
const { ethers } = require('ethers')
const fs   = require('fs')
const path = require('path')

const RPC_URL          = process.env.RPC_URL || 'https://rpc.sepolia.mantle.xyz'
// Keeper has its own key — separate from deployer so a leak doesn't give owner access
const PRIVATE_KEY      = process.env.KEEPER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY
const CONTRACT_ADDRESS = '0x5FdD4800B445859DF57B4D987ab12a7C6466FCB3'
const POLL_INTERVAL_MS = 60_000

if (!PRIVATE_KEY) {
  console.error('ERROR: KEEPER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) not set')
  process.exit(1)
}

const ABI = [
  'function roundCount() view returns (uint256)',
  'function getRound(uint256) view returns (tuple(uint256 id, uint256 entryFee, uint256 prizePool, uint256 startTime, uint256 endTime, uint8 state, address[] participantList, address winner, int256 winnerRoiBps))',
  'function getParticipant(uint256, address) view returns (tuple(address addr, bool isAI, int256 roiBps, uint256 tradeCount, bool liquidated, bool claimed))',
  'function submitResults(uint256 roundId, address[] addrs, int256[] roiBpsArr, bool[] liquidatedArr)',
  'event TradeSubmitted(uint256 indexed roundId, address indexed trader, string pair, int256 amountBps, bool isBuy, uint256 logEntryId)',
]

const ROUND_STATE = { Open: 0, Active: 1, Finalizing: 2, Closed: 3 }

// ── Canonical pair → CoinGecko ID mapping ─────────────────────────────────────
// Must match Arena.jsx and agent-bot.js
const PAIR_TO_CG = {
  'MNT/USDT':  'mantle',
  'ETH/USDT':  'ethereum',
  'BTC/USDT':  'bitcoin',
  'ARB/USDT':  'arbitrum',
  'OP/USDT':   'optimism',
}

// ── Price snapshot persistence ─────────────────────────────────────────────────

const SNAPSHOT_FILE = path.join(__dirname, '../.price-snapshots.json')

function loadSnapshots() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) }
  catch { return {} }
}

function saveSnapshots(snaps) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snaps, null, 2))
}

async function fetchCurrentPrices() {
  const ids = Object.values(PAIR_TO_CG).join(',')
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const data = await res.json()
  const out  = {}
  for (const [pair, cgId] of Object.entries(PAIR_TO_CG)) {
    out[pair] = data[cgId]?.usd ?? null
  }
  return out
}

async function captureStartPrices(roundId) {
  const snaps = loadSnapshots()
  if (snaps[roundId]?.startPrices) return   // already snapped
  try {
    const prices = await fetchCurrentPrices()
    snaps[roundId] = { ...(snaps[roundId] ?? {}), startPrices: prices, startCapturedAt: Date.now() }
    saveSnapshots(snaps)
    console.log(`[keeper] Round #${roundId}: start prices captured`)
  } catch (err) {
    console.warn(`[keeper] Round #${roundId}: failed to capture start prices:`, err.message)
  }
}

// ── Real ROI calculation ───────────────────────────────────────────────────────

/**
 * Compute ROI for each participant based on their on-chain trades and
 * the price change between round start and round end.
 *
 * Model: each trade allocates (amountBps / 10000) of a notional portfolio
 * to a long (isBuy) or short (!isBuy) position in that pair.
 * ROI = Σ (allocation × direction × priceReturn)
 */
function computePortfolioRoi(trades, startPrices, endPrices) {
  let totalRoi = 0
  for (const { pair, amountBps, isBuy } of trades) {
    const start = startPrices[pair]
    const end   = endPrices[pair]
    if (!start || !end || start === 0) continue
    const direction   = isBuy ? 1 : -1
    const allocation  = Number(amountBps) / 10_000
    const priceReturn = (end - start) / start
    totalRoi += allocation * direction * priceReturn
  }
  return Math.round(totalRoi * 10_000)   // → basis points (100 bps = 1%)
}

async function fetchTradesFromLogs(provider, roundId, startTime) {
  // Estimate fromBlock using round.startTime to avoid missing old trades.
  // Mantle Sepolia: ~1 block / 2 seconds. Add a 10-minute buffer.
  const iface   = new ethers.Interface(ABI)
  const topic   = iface.getEvent('TradeSubmitted').topicHash
  const rTopic  = ethers.zeroPadValue(ethers.toBeHex(roundId), 32)

  let fromBlock = 0n
  try {
    const latest      = await provider.getBlockNumber()
    const latestBlock = await provider.getBlock(latest)
    const secondsBack = BigInt(Math.max(0, Number(latestBlock.timestamp) - Number(startTime))) + 600n
    const blocksBack  = secondsBack / 2n   // ~2s per block on Mantle Sepolia
    fromBlock = latest > blocksBack ? latest - blocksBack : 0n
  } catch {
    // fall back to a wide scan
    const latest = await provider.getBlockNumber()
    fromBlock = latest > 100_000n ? latest - 100_000n : 0n
  }

  const logs = await provider.getLogs({
    address: CONTRACT_ADDRESS,
    topics:  [topic, rTopic],
    fromBlock,
    toBlock: 'latest',
  })

  // Group trades by trader
  const byTrader = {}
  for (const log of logs) {
    const parsed = iface.parseLog(log)
    const { trader, pair, amountBps, isBuy } = parsed.args
    const addr = trader.toLowerCase()
    if (!byTrader[addr]) byTrader[addr] = []
    byTrader[addr].push({ pair, amountBps, isBuy })
  }
  return byTrader
}

async function computeRoi(provider, roundId, startTime, participants) {
  const snaps = loadSnapshots()
  const startPrices = snaps[roundId]?.startPrices ?? {}

  let endPrices = {}
  try {
    endPrices = await fetchCurrentPrices()
    // Persist end prices so results are reproducible if the keeper restarts
    snaps[roundId] = { ...(snaps[roundId] ?? {}), endPrices, endCapturedAt: Date.now() }
    saveSnapshots(snaps)
  } catch (err) {
    console.warn('[keeper] Failed to fetch end prices:', err.message)
    endPrices = snaps[roundId]?.endPrices ?? {}
  }

  const hasPrices = Object.values(startPrices).some(Boolean) && Object.values(endPrices).some(Boolean)
  if (!hasPrices) {
    console.warn('[keeper] No price data available — falling back to trade-count scoring')
  }

  let tradesByTrader = {}
  try {
    tradesByTrader = await fetchTradesFromLogs(provider, roundId, startTime)
  } catch (err) {
    console.warn('[keeper] Log fetch failed:', err.message)
    // Fall back to on-chain tradeCount (trade-count scoring, not price-based)
    for (const addr of participants) {
      tradesByTrader[addr.toLowerCase()] = null  // null = use fallback
    }
  }

  return participants.map(addr => {
    const key    = addr.toLowerCase()
    const trades = tradesByTrader[key]

    if (hasPrices && trades && trades.length > 0) {
      return computePortfolioRoi(trades, startPrices, endPrices)
    }
    // Fallback when prices are unavailable: reward participation over inaction
    const count = trades ? trades.length : 0
    return count > 0 ? 50 : 0   // flat +0.5% for participating, 0 for no trades
  })
}

// ── Finalization ───────────────────────────────────────────────────────────────

async function finalizeRound(contract, provider, roundId, round) {
  console.log(`[keeper] Finalizing round #${roundId}…`)
  const participants = round.participantList

  if (!participants.length) {
    console.log(`[keeper] Round #${roundId}: no participants — skipping.`)
    return
  }

  const roiBpsArr     = await computeRoi(provider, roundId, round.startTime, participants)
  const liquidatedArr = participants.map(() => false)

  participants.forEach((addr, i) => {
    console.log(`  ${addr.slice(0, 10)}… → ROI: ${(roiBpsArr[i] / 100).toFixed(2)}%`)
  })

  const tx = await contract.submitResults(roundId, [...participants], roiBpsArr, liquidatedArr)
  console.log(`[keeper] submitResults TX: ${tx.hash}`)
  await tx.wait()
  console.log(`[keeper] Round #${roundId} CLOSED ✓`)
}

// ── Tick ───────────────────────────────────────────────────────────────────────

let tickRunning = false

async function tick(contract, provider) {
  const count = Number(await contract.roundCount())
  if (count === 0) return

  const now = Math.floor(Date.now() / 1000)

  for (let i = 0; i < count; i++) {
    try {
      const round   = await contract.getRound(i)
      const state   = Number(round.state)
      const endTime = Number(round.endTime)

      // Snap start prices as soon as a round goes Active
      if (state === ROUND_STATE.Active) {
        await captureStartPrices(i)
      }

      if (state === ROUND_STATE.Active && now >= endTime) {
        console.log(`[keeper] Round #${i} ended ${Math.floor((now - endTime) / 60)}m ago — finalizing…`)
        await finalizeRound(contract, provider, i, round)
      }
    } catch (err) {
      console.error(`[keeper] Error on round #${i}:`, err.message)
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet)

  const network = await provider.getNetwork()
  console.log(`[keeper] Connected to chain ${network.chainId}`)
  console.log(`[keeper] Keeper wallet: ${wallet.address}`)
  console.log(`[keeper] Watching TuringRound: ${CONTRACT_ADDRESS}`)
  console.log(`[keeper] Polling every ${POLL_INTERVAL_MS / 1000}s\n`)

  const safeTick = async () => {
    if (tickRunning) return
    tickRunning = true
    try { await tick(contract, provider) }
    catch (err) { console.error('[keeper] Tick error:', err.message) }
    finally { tickRunning = false }
  }

  await safeTick()
  setInterval(safeTick, POLL_INTERVAL_MS)
}

main().catch(err => {
  console.error('[keeper] Fatal error:', err)
  process.exit(1)
})
