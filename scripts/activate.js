const hre = require("hardhat")

const CONTRACTS = {
  TuringRound: '0xb5605cAc85c79a98679A743b8E077a21bC652b92',
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Activating with:", deployer.address)

  const TuringRound = await hre.ethers.getContractFactory("TuringRound")
  const turingRound = TuringRound.attach(CONTRACTS.TuringRound)

  const round = await turingRound.getRound(0)
  const stateLabels = ['Open', 'Active', 'Finalizing', 'Closed']
  console.log(`Round #0 state: ${stateLabels[round.state]}`)

  if (Number(round.state) !== 0) {
    console.log("Round is not in Open state, skipping activation.")
    return
  }

  console.log("Calling activateRound(0)...")
  const tx = await turingRound.activateRound(0)
  await tx.wait()
  console.log("Round #0 activated! tx:", tx.hash)

  const updated = await turingRound.getRound(0)
  console.log(`New state: ${stateLabels[updated.state]}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
