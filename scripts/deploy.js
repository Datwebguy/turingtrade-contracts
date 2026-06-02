const hre  = require("hardhat")
const fs   = require("fs")
const path = require("path")

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  console.log("Deploying with:", deployer.address)
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "MNT\n")

  const ReasoningLog  = await hre.ethers.getContractFactory("ReasoningLog")
  const AgentRegistry = await hre.ethers.getContractFactory("AgentRegistry")
  const TradeExecutor = await hre.ethers.getContractFactory("TradeExecutor")
  const TuringRound   = await hre.ethers.getContractFactory("TuringRound")

  const reasoningLog  = await ReasoningLog.deploy();  await reasoningLog.waitForDeployment()
  const agentRegistry = await AgentRegistry.deploy(); await agentRegistry.waitForDeployment()
  const tradeExecutor = await TradeExecutor.deploy(); await tradeExecutor.waitForDeployment()
  const turingRound   = await TuringRound.deploy(await reasoningLog.getAddress(), await agentRegistry.getAddress())
  await turingRound.waitForDeployment()

  const rlAddr = await reasoningLog.getAddress()
  const arAddr = await agentRegistry.getAddress()
  const teAddr = await tradeExecutor.getAddress()
  const trAddr = await turingRound.getAddress()

  console.log("ReasoningLog:  ", rlAddr)
  console.log("AgentRegistry: ", arAddr)
  console.log("TradeExecutor: ", teAddr)
  console.log("TuringRound:   ", trAddr)

  // Wire permissions
  await reasoningLog.setAuthorised(trAddr, true)
  console.log("\nReasoningLog: authorised TuringRound")
  await agentRegistry.setAuthorised(trAddr, true)
  console.log("AgentRegistry: authorised TuringRound")

  // Create first round: starts in 5 min, runs 24h, entry = 0.01 MNT
  const now = Math.floor(Date.now() / 1000)
  const entryFee = hre.ethers.parseEther("0.01")
  await turingRound.createRound(entryFee, now + 300, now + 300 + 86400)
  console.log("Round #0 created: entry=0.01 MNT, starts in 5 min, duration=24h")

  // Write addresses to .env so bot scripts pick them up without manual copy-paste
  const envPath = path.join(__dirname, '../.env')
  let envContent = ''
  try { envContent = fs.readFileSync(envPath, 'utf8') } catch { /* no .env yet */ }

  const pairs = [
    ['TURING_ROUND_ADDRESS',   trAddr],
    ['AGENT_REGISTRY_ADDRESS', arAddr],
    ['REASONING_LOG_ADDRESS',  rlAddr],
    ['TRADE_EXECUTOR_ADDRESS', teAddr],
  ]
  for (const [key, val] of pairs) {
    const re = new RegExp(`^${key}=.*$`, 'm')
    const line = `${key}=${val}`
    envContent = re.test(envContent) ? envContent.replace(re, line) : envContent + `\n${line}`
  }
  fs.writeFileSync(envPath, envContent.trimStart())
  console.log('\n── Addresses written to .env ────────────────────────────────')
  for (const [key, val] of pairs) console.log(`  ${key}=${val}`)

  console.log("\n── Paste into turingtrade/src/lib/contracts.js ──────────────")
  console.log(`  TuringRound:   '${trAddr}',`)
  console.log(`  AgentRegistry: '${arAddr}',`)
  console.log(`  ReasoningLog:  '${rlAddr}',`)
  console.log(`  TradeExecutor: '${teAddr}',`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
