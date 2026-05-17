/**
 * TuringTrade Keeper Bot
 * Automatically finalizes rounds when their end time passes.
 * Run once and leave it running: node scripts/keeper.js
 */

require('dotenv').config()
const { ethers } = require('ethers')

const RPC_URL    = 'https://rpc.sepolia.mantle.xyz'
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY
const CONTRACT_ADDRESS = '0xb5605cAc85c79a98679A743b8E077a21bC652b92'
const POLL_INTERVAL_MS = 60_000  // check every 60 seconds

if (!PRIVATE_KEY) {
  console.error('ERROR: DEPLOYER_PRIVATE_KEY not set in .env')
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

async function computeRoi(provider, contract, roundId, participants) {
  const tradeCount = {}
  for (const addr of participants) tradeCount[addr.toLowerCase()] = 0

  // Try fetching trade events — skip if RPC doesn't support it
  try {
    const iface = new ethers.Interface(ABI)
    const topic = iface.getEvent('TradeSubmitted').topicHash
    const roundTopic = ethers.zeroPadValue(ethers.toBeHex(roundId), 32)
    const latest = await provider.getBlockNumber()
    const fromBlock = Math.max(0, latest - 50000)
    const logs = await provider.getLogs({
      address: CONTRACT_ADDRESS,
      topics: [topic, roundTopic],
      fromBlock,
      toBlock: 'latest',
    })
    for (const log of logs) {
      const parsed = iface.parseLog(log)
      const trader = parsed.args.trader.toLowerCase()
      if (tradeCount[trader] !== undefined) tradeCount[trader]++
    }
  } catch {
    // Fall back to on-chain tradeCount per participant
    for (const addr of participants) {
      try {
        const p = await contract.getParticipant(roundId, addr)
        tradeCount[addr.toLowerCase()] = Number(p.tradeCount)
      } catch {}
    }
  }

  return participants.map(addr => {
    const count = tradeCount[addr.toLowerCase()] ?? 0
    return Math.round((3.5 + count * 1.2) * 100)  // simulated ROI in bps
  })
}

async function finalizeRound(contract, provider, roundId) {
  console.log(`[keeper] Finalizing round #${roundId}…`)
  const round = await contract.getRound(roundId)
  const participants = round.participantList

  if (!participants.length) {
    console.log(`[keeper] Round #${roundId} has no participants — skipping.`)
    return
  }

  const roiBpsArr = await computeRoi(provider, contract, roundId, participants)
  const liquidatedArr = participants.map(() => false)

  participants.forEach((addr, i) => {
    console.log(`  ${addr.slice(0, 10)}… → ROI: ${(roiBpsArr[i] / 100).toFixed(2)}%`)
  })

  const tx = await contract.submitResults(roundId, participants, roiBpsArr, liquidatedArr)
  console.log(`[keeper] submitResults tx sent: ${tx.hash}`)
  await tx.wait()
  console.log(`[keeper] Round #${roundId} CLOSED. Winner determined on-chain.`)
}

async function tick(contract, provider) {
  const count = Number(await contract.roundCount())
  if (count === 0) return

  const now = Math.floor(Date.now() / 1000)

  for (let i = 0; i < count; i++) {
    try {
      const round = await contract.getRound(i)
      const state = Number(round.state)
      const endTime = Number(round.endTime)

      if (state === ROUND_STATE.Active && now >= endTime) {
        console.log(`[keeper] Round #${i} ended ${Math.floor((now - endTime) / 60)}m ago — finalizing…`)
        await finalizeRound(contract, provider, i)
      }
    } catch (err) {
      console.error(`[keeper] Error checking round #${i}:`, err.message)
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet)

  const network = await provider.getNetwork()
  console.log(`[keeper] Connected to chain ${network.chainId}`)
  console.log(`[keeper] Keeper wallet: ${wallet.address}`)
  console.log(`[keeper] Watching TuringRound: ${CONTRACT_ADDRESS}`)
  console.log(`[keeper] Polling every ${POLL_INTERVAL_MS / 1000}s\n`)

  // Run immediately on start, then on interval
  await tick(contract, provider)
  setInterval(() => tick(contract, provider), POLL_INTERVAL_MS)
}

main().catch(err => {
  console.error('[keeper] Fatal error:', err)
  process.exit(1)
})
