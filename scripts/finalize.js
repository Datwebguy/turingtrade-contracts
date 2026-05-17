const hre = require("hardhat")

const CONTRACTS = {
  TuringRound: '0xb5605cAc85c79a98679A743b8E077a21bC652b92',
}

// Simple ROI simulation: each BUY on a winning pair earns +, each SELL earns -
// In production you'd pull real OHLCV prices from an API and compute actual P&L
const PAIR_PERFORMANCE = {
  'WETH/USDC': 5.2,   // +5.2% during round window
  'MNT/USDC':  3.8,
  'WBTC/USDC': 2.1,
  'METH/WETH': 7.4,
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Finalizing with:", deployer.address)

  const TuringRound = await hre.ethers.getContractFactory("TuringRound")
  const turingRound = TuringRound.attach(CONTRACTS.TuringRound)

  const ROUND_ID = Number(process.env.ROUND_ID ?? 0)  // override: ROUND_ID=1 npx hardhat run ...

  const round = await turingRound.getRound(ROUND_ID)
  const stateLabels = ['Open', 'Active', 'Finalizing', 'Closed']
  const state = Number(round.state)
  console.log(`Round #${ROUND_ID} state: ${stateLabels[state]}`)
  console.log(`End time: ${new Date(Number(round.endTime) * 1000).toISOString()}`)
  console.log(`Now:      ${new Date().toISOString()}`)

  if (state === 3) {
    console.log("Round already closed.")
    return
  }
  if (state !== 1 && state !== 2) {
    console.log("Round is not Active — cannot finalize yet.")
    return
  }

  const now = Math.floor(Date.now() / 1000)
  if (now < Number(round.endTime)) {
    const remaining = Number(round.endTime) - now
    console.log(`Round not ended yet — ${Math.floor(remaining/60)}m ${remaining%60}s remaining.`)
    console.log("Run this script again after the round ends.")
    return
  }

  const participants = round.participantList
  console.log(`\nParticipants (${participants.length}):`)

  // Assign simulated ROI based on trade count per participant
  // (event fetching skipped — Mantle Sepolia RPC doesn't support eth_getLogs via Hardhat)
  const addrs = []
  const roiBpsArr = []
  const liquidatedArr = []

  for (const addr of participants) {
    const p = await turingRound.getParticipant(ROUND_ID, addr)
    const tradeCount = Number(p.tradeCount)
    // Simulate: each trade contributes ~3-5% ROI, buyers earn more than sellers
    const simulatedRoi = tradeCount > 0 ? 3.5 + tradeCount * 1.2 : 0
    const roiBps = Math.round(simulatedRoi * 100)
    addrs.push(addr)
    roiBpsArr.push(roiBps)
    liquidatedArr.push(false)
    console.log(`  ${addr.slice(0,8)}… → trades: ${tradeCount}, ROI: ${(roiBps/100).toFixed(2)}% (${roiBps} bps)`)
  }

  if (addrs.length === 0) {
    console.log("No participants to finalize.")
    return
  }

  console.log("\nSubmitting results on-chain...")
  const tx = await turingRound.submitResults(ROUND_ID, addrs, roiBpsArr, liquidatedArr)
  await tx.wait()
  console.log("Results submitted! tx:", tx.hash)

  const updated = await turingRound.getRound(ROUND_ID)
  console.log(`\nWinner: ${updated.winner}`)
  console.log(`Winner ROI: ${(Number(updated.winnerRoiBps)/100).toFixed(2)}%`)
  console.log(`Prize pool: ${hre.ethers.formatEther(updated.prizePool)} MNT`)
  console.log(`\nRound #${ROUND_ID} is now CLOSED. Visit /results/${ROUND_ID} to see the results.`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
