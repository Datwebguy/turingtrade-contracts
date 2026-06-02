const hre = require("hardhat")

const CONTRACTS = {
  TuringRound: process.env.TURING_ROUND_ADDRESS || '0x5FdD4800B445859DF57B4D987ab12a7C6466FCB3',
}

const DURATION_MINUTES = 15  // change this if you want longer

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Creating demo round with:", deployer.address)

  const TuringRound = await hre.ethers.getContractFactory("TuringRound")
  const turingRound = TuringRound.attach(CONTRACTS.TuringRound)

  const now = Math.floor(Date.now() / 1000)
  const startTime = now + 10          // 10 seconds from now
  const endTime   = now + (DURATION_MINUTES * 60)
  const entryFee  = hre.ethers.parseEther("0.01")

  console.log(`Creating ${DURATION_MINUTES}-minute round...`)
  console.log(`  Start: ${new Date(startTime * 1000).toISOString()}`)
  console.log(`  End:   ${new Date(endTime   * 1000).toISOString()}`)
  console.log(`  Entry: 0.01 MNT`)

  const tx = await turingRound.createRound(entryFee, startTime, endTime)
  await tx.wait()
  console.log("Round created! tx:", tx.hash)

  const count = await turingRound.roundCount()
  const newId  = Number(count) - 1
  console.log(`New round ID: #${newId}`)

  // Wait 12 seconds then activate
  console.log("Waiting 12 seconds for startTime to pass...")
  await new Promise(r => setTimeout(r, 12000))

  const activateTx = await turingRound.activateRound(newId)
  await activateTx.wait()
  console.log("Round activated! tx:", activateTx.hash)

  console.log(`\nDone! Round #${newId} is now ACTIVE.`)
  console.log(`Go to: http://localhost:5173/arena/${newId}`)
  console.log(`\nRun finalize in ${DURATION_MINUTES} minutes:`)
  console.log(`  npx hardhat run scripts/finalize.js --network mantleSepolia`)
  console.log(`  (edit ROUND_ID = ${newId} in finalize.js first)`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
