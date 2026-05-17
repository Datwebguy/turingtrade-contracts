const hre = require("hardhat")

// Addresses from the successful deployment run
const ADDRESSES = {
  ReasoningLog:  '0x41AAb6A7B02D19ED30B49408C98648BBd34E032F',
  AgentRegistry: '0xff08093DC2bBFde8a08F05C9c10fe9ae8757632B',
  TradeExecutor: '0x83840e612cE85E692CD950E8BD3DcB980Fe44BA2',
  TuringRound:   '0xb5605cAc85c79a98679A743b8E077a21bC652b92',
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Setup with:", deployer.address)
  console.log("Nonce:", await deployer.getNonce())

  const ReasoningLog  = await hre.ethers.getContractFactory("ReasoningLog")
  const AgentRegistry = await hre.ethers.getContractFactory("AgentRegistry")
  const TuringRound   = await hre.ethers.getContractFactory("TuringRound")

  const reasoningLog  = ReasoningLog.attach(ADDRESSES.ReasoningLog)
  const agentRegistry = AgentRegistry.attach(ADDRESSES.AgentRegistry)
  const turingRound   = TuringRound.attach(ADDRESSES.TuringRound)

  // Authorise TuringRound on ReasoningLog
  const rlAuth = await reasoningLog.authorised(ADDRESSES.TuringRound)
  if (!rlAuth) {
    console.log("Setting TuringRound as authorised on ReasoningLog...")
    const tx = await reasoningLog.setAuthorised(ADDRESSES.TuringRound, true)
    await tx.wait()
    console.log("Done:", tx.hash)
  } else {
    console.log("ReasoningLog: TuringRound already authorised ✓")
  }

  // Authorise TuringRound on AgentRegistry
  const arAuth = await agentRegistry.authorised(ADDRESSES.TuringRound)
  if (!arAuth) {
    console.log("Setting TuringRound as authorised on AgentRegistry...")
    const tx = await agentRegistry.setAuthorised(ADDRESSES.TuringRound, true)
    await tx.wait()
    console.log("Done:", tx.hash)
  } else {
    console.log("AgentRegistry: TuringRound already authorised ✓")
  }

  // Check round count
  const roundCount = await turingRound.roundCount()
  if (roundCount === 0n) {
    console.log("Creating round #0...")
    const now = Math.floor(Date.now() / 1000)
    const entryFee = hre.ethers.parseEther("0.01")
    const tx2 = await turingRound.createRound(entryFee, now + 300, now + 300 + 86400)
    await tx2.wait()
    console.log("Round #0 created ✓")
  } else {
    console.log(`Round count already ${roundCount} ✓`)
  }

  console.log("\n── Paste into turingtrade/src/lib/contracts.js ──────────────")
  console.log(`  TuringRound:   '${ADDRESSES.TuringRound}',`)
  console.log(`  AgentRegistry: '${ADDRESSES.AgentRegistry}',`)
  console.log(`  ReasoningLog:  '${ADDRESSES.ReasoningLog}',`)
  console.log(`  TradeExecutor: '${ADDRESSES.TradeExecutor}',`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
