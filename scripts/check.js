const hre = require("hardhat")

const CONTRACTS = {
  TuringRound: '0xc7DB459EcCB647e0b741965cadCA4798D0Cc825c',
}

async function main() {
  const TuringRound = await hre.ethers.getContractFactory("TuringRound")
  const turingRound = TuringRound.attach(CONTRACTS.TuringRound)

  const roundCount = await turingRound.roundCount()
  console.log("roundCount:", roundCount.toString())

  if (roundCount > 0n) {
    for (let i = 0n; i < roundCount; i++) {
      const round = await turingRound.getRound(i)
      const stateLabels = ['Open', 'Active', 'Finalizing', 'Closed']
      console.log(`\nRound #${i}:`)
      console.log(`  state:      ${stateLabels[round.state]} (${round.state})`)
      console.log(`  entryFee:   ${hre.ethers.formatEther(round.entryFee)} MNT`)
      console.log(`  prizePool:  ${hre.ethers.formatEther(round.prizePool)} MNT`)
      console.log(`  startTime:  ${new Date(Number(round.startTime) * 1000).toISOString()}`)
      console.log(`  endTime:    ${new Date(Number(round.endTime) * 1000).toISOString()}`)
      console.log(`  participants: ${round.participantList.length}`)
    }
  } else {
    console.log("No rounds created yet.")
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
