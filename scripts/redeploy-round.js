const hre = require("hardhat")

// Keep existing ReasoningLog and AgentRegistry — only redeploy TuringRound
const EXISTING = {
  ReasoningLog:  '0x41AAb6A7B02D19ED30B49408C98648BBd34E032F',
  AgentRegistry: '0xff08093DC2bBFde8a08F05C9c10fe9ae8757632B',
  TradeExecutor: '0x83840e612cE85E692CD950E8BD3DcB980Fe44BA2',
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Deployer:", deployer.address)
  console.log("Nonce:", await deployer.getNonce())

  // Deploy new TuringRound
  console.log("\nDeploying TuringRound...")
  const TuringRound = await hre.ethers.getContractFactory("TuringRound")
  const turingRound = await TuringRound.deploy(EXISTING.ReasoningLog, EXISTING.AgentRegistry)
  await turingRound.waitForDeployment()
  const turingRoundAddr = await turingRound.getAddress()
  console.log("TuringRound:", turingRoundAddr)

  // Authorize new TuringRound on ReasoningLog
  const ReasoningLog = await hre.ethers.getContractFactory("ReasoningLog")
  const reasoningLog = ReasoningLog.attach(EXISTING.ReasoningLog)
  console.log("\nAuthorizing TuringRound on ReasoningLog...")
  const tx1 = await reasoningLog.setAuthorised(turingRoundAddr, true)
  await tx1.wait()
  console.log("Done:", tx1.hash)

  // Authorize new TuringRound on AgentRegistry
  const AgentRegistry = await hre.ethers.getContractFactory("AgentRegistry")
  const agentRegistry = AgentRegistry.attach(EXISTING.AgentRegistry)
  console.log("Authorizing TuringRound on AgentRegistry...")
  const tx2 = await agentRegistry.setAuthorised(turingRoundAddr, true)
  await tx2.wait()
  console.log("Done:", tx2.hash)

  // Create Round #0 (min entry 0.01 MNT, starts in 1 min, lasts 48h)
  const now = Math.floor(Date.now() / 1000)
  const startTime = now + 60        // 1 minute from now
  const endTime   = now + 60 + 48 * 3600  // 48 hours
  console.log("\nCreating Round #0...")
  const tx3 = await turingRound.createRound(hre.ethers.parseEther("0.01"), startTime, endTime)
  await tx3.wait()
  console.log("Round #0 created ✓")

  // Activate round immediately (startTime is 1 min away, activate via enter instead)
  console.log("\nActivating Round #0...")
  const tx4 = await turingRound.activateRound(0)
  // This will revert if block.timestamp < startTime — that's OK, enter() auto-activates
  await tx4.wait().catch(() => console.log("  (activateRound reverted — round auto-activates on first entry)"))

  console.log("\n── Update turingtrade/src/lib/contracts.js ──────────────────")
  console.log(`  TuringRound:   '${turingRoundAddr}',`)
  console.log(`  AgentRegistry: '${EXISTING.AgentRegistry}',`)
  console.log(`  ReasoningLog:  '${EXISTING.ReasoningLog}',`)
  console.log(`  TradeExecutor: '${EXISTING.TradeExecutor}',`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
