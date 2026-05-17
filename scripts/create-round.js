/**
 * Creates a new TuringRound.
 * Usage:
 *   npx hardhat run scripts/create-round.js --network mantleSepolia
 *
 * Set DURATION_HOURS in the config below before running.
 */
require('dotenv').config()
const hre = require("hardhat")

const TURING_ROUND = '0x5FdD4800B445859DF57B4D987ab12a7C6466FCB3'
const DURATION_HOURS = 1          // change this — how long the round lasts
const ENTRY_FEE_MNT  = '0.01'    // entry fee in MNT

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log('Creating round with:', deployer.address)

  const TuringRound = await hre.ethers.getContractFactory('TuringRound')
  const contract = TuringRound.attach(TURING_ROUND)

  const now       = Math.floor(Date.now() / 1000)
  const startTime = now + 60                                  // starts in 1 min
  const endTime   = startTime + DURATION_HOURS * 3600

  const entryFee = hre.ethers.parseEther(ENTRY_FEE_MNT)
  const tx = await contract.createRound(entryFee, startTime, endTime)
  await tx.wait()

  const roundId = await contract.roundCount() - 1n
  console.log(`\nRound #${roundId} created ✓`)
  console.log(`  Start : ${new Date(startTime * 1000).toISOString()}`)
  console.log(`  End   : ${new Date(endTime   * 1000).toISOString()} (${DURATION_HOURS}h from now)`)
  console.log(`  Fee   : ${ENTRY_FEE_MNT} MNT`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
