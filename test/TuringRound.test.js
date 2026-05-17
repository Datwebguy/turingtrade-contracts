const { expect }       = require('chai')
const { ethers }       = require('hardhat')
const { time }         = require('@nomicfoundation/hardhat-network-helpers')

describe('TuringRound', function () {
  let owner, keeper, alice, bob, aiWallet
  let turingRound, reasoningLog, agentRegistry

  const ENTRY_FEE    = ethers.parseEther('0.01')
  const PROTOCOL_FEE = 500n   // 5% in bps

  async function deployAll() {
    ;[owner, keeper, alice, bob, aiWallet] = await ethers.getSigners()

    const ReasoningLog  = await ethers.getContractFactory('ReasoningLog')
    const AgentRegistry = await ethers.getContractFactory('AgentRegistry')
    const TuringRound   = await ethers.getContractFactory('TuringRound')

    reasoningLog  = await ReasoningLog.deploy()
    agentRegistry = await AgentRegistry.deploy()
    turingRound   = await TuringRound.deploy(
      await reasoningLog.getAddress(),
      await agentRegistry.getAddress(),
    )

    // Wire up authorisations
    await reasoningLog.setAuthorised(await turingRound.getAddress(), true)
    await agentRegistry.setAuthorised(await turingRound.getAddress(), true)
    await turingRound.setKeeper(keeper.address)
  }

  async function createRound(durationSecs = 3600) {
    const now   = await time.latest()
    const start = now + 10
    const end   = start + durationSecs
    await turingRound.createRound(ENTRY_FEE, start, end)
    return { start, end, roundId: 0n }
  }

  // ── Deployment ──────────────────────────────────────────────────────────

  describe('deployment', function () {
    before(deployAll)

    it('sets keeper to the address passed to setKeeper', async function () {
      expect(await turingRound.keeper()).to.equal(keeper.address)
    })

    it('sets owner correctly', async function () {
      expect(await turingRound.owner()).to.equal(owner.address)
    })
  })

  // ── createRound ─────────────────────────────────────────────────────────

  describe('createRound', function () {
    before(deployAll)

    it('reverts when start is in the past', async function () {
      const now = await time.latest()
      await expect(
        turingRound.createRound(ENTRY_FEE, now - 1, now + 3600)
      ).to.be.revertedWith('Start in past')
    })

    it('reverts when end <= start', async function () {
      const now = await time.latest()
      await expect(
        turingRound.createRound(ENTRY_FEE, now + 100, now + 100)
      ).to.be.revertedWith('Invalid times')
    })

    it('creates a round and emits RoundCreated', async function () {
      const now = await time.latest()
      await expect(
        turingRound.createRound(ENTRY_FEE, now + 10, now + 3610)
      ).to.emit(turingRound, 'RoundCreated')
      expect(await turingRound.roundCount()).to.equal(1n)
    })

    it('rejects non-owner', async function () {
      const now = await time.latest()
      await expect(
        turingRound.connect(alice).createRound(ENTRY_FEE, now + 10, now + 3610)
      ).to.be.reverted
    })
  })

  // ── enter ────────────────────────────────────────────────────────────────

  describe('enter', function () {
    before(async function () {
      await deployAll()
      await createRound()
      await time.increase(15)   // past startTime so round can auto-activate
    })

    it('allows entry with correct fee', async function () {
      await expect(
        turingRound.connect(alice).enter(0n, false, { value: ENTRY_FEE })
      ).to.emit(turingRound, 'ParticipantEntered')
    })

    it('rejects duplicate entry', async function () {
      await expect(
        turingRound.connect(alice).enter(0n, false, { value: ENTRY_FEE })
      ).to.be.revertedWith('Already entered')
    })

    it('rejects entry below minimum fee', async function () {
      await expect(
        turingRound.connect(bob).enter(0n, false, { value: ENTRY_FEE - 1n })
      ).to.be.revertedWith('Below minimum entry fee')
    })

    it('rejects AI entry without a registered agent', async function () {
      await expect(
        turingRound.connect(bob).enter(0n, true, { value: ENTRY_FEE })
      ).to.be.revertedWith('No registered agent')
    })

    it('accepts AI entry with a registered agent', async function () {
      await agentRegistry.connect(aiWallet).registerAgent('TestBot', 'momentum')
      await expect(
        turingRound.connect(aiWallet).enter(0n, true, { value: ENTRY_FEE })
      ).to.emit(turingRound, 'ParticipantEntered')
    })

    it('adds entry fee to prize pool', async function () {
      const round = await turingRound.getRound(0n)
      // alice + aiWallet entered; bob did not
      expect(round.prizePool).to.equal(ENTRY_FEE * 2n)
    })
  })

  // ── submitTrade ──────────────────────────────────────────────────────────

  describe('submitTrade', function () {
    before(async function () {
      await deployAll()
      await createRound()
      await time.increase(15)
      await turingRound.connect(alice).enter(0n, false, { value: ENTRY_FEE })
    })

    it('accepts a valid trade', async function () {
      await expect(
        turingRound.connect(alice).submitTrade(0n, 'ETH/USDT', 500n, true, 'Bullish ETH.')
      ).to.emit(turingRound, 'TradeSubmitted')
    })

    it('increments tradeCount', async function () {
      const p = await turingRound.getParticipant(0n, alice.address)
      expect(p.tradeCount).to.equal(1n)
    })

    it('rejects amountBps = 0', async function () {
      await expect(
        turingRound.connect(alice).submitTrade(0n, 'ETH/USDT', 0n, true, 'test')
      ).to.be.revertedWith('amountBps out of range')
    })

    it('rejects amountBps > MAX_AMOUNT_BPS', async function () {
      await expect(
        turingRound.connect(alice).submitTrade(0n, 'ETH/USDT', 10_001n, true, 'test')
      ).to.be.revertedWith('amountBps out of range')
    })

    it('rejects trade from non-participant', async function () {
      await expect(
        turingRound.connect(bob).submitTrade(0n, 'ETH/USDT', 500n, true, 'test')
      ).to.be.revertedWith('Not entered')
    })

    it('rejects reasoning that exceeds 2048 bytes', async function () {
      const long = 'x'.repeat(2049)
      await expect(
        turingRound.connect(alice).submitTrade(0n, 'ETH/USDT', 500n, true, long)
      ).to.be.reverted
    })
  })

  // ── submitResults / claimPrize ────────────────────────────────────────────

  describe('submitResults & claimPrize', function () {
    let prizePool
    before(async function () {
      await deployAll()
      const { end } = await createRound()
      await time.increase(15)
      await turingRound.connect(alice).enter(0n, false, { value: ENTRY_FEE })
      await turingRound.connect(bob).enter(0n, false, { value: ENTRY_FEE })
      prizePool = ENTRY_FEE * 2n
      await time.increaseTo(end + 1)
    })

    it('rejects submitResults from non-keeper', async function () {
      await expect(
        turingRound.connect(alice).submitResults(
          0n, [alice.address, bob.address], [1000n, 500n], [false, false]
        )
      ).to.be.revertedWith('Not keeper')
    })

    it('keeper can submit results', async function () {
      await expect(
        turingRound.connect(keeper).submitResults(
          0n, [alice.address, bob.address], [1000n, 500n], [false, false]
        )
      ).to.emit(turingRound, 'RoundFinalized')
    })

    it('sets winner to highest ROI participant', async function () {
      const round = await turingRound.getRound(0n)
      expect(round.winner.toLowerCase()).to.equal(alice.address.toLowerCase())
    })

    it('accumulates correct fee in pendingOwnerFees', async function () {
      const expectedFee = (prizePool * PROTOCOL_FEE) / 10_000n
      expect(await turingRound.pendingOwnerFees()).to.equal(expectedFee)
    })

    it('winner can claim prize (prizePool minus fee)', async function () {
      const fee   = (prizePool * PROTOCOL_FEE) / 10_000n
      const prize = prizePool - fee
      await expect(
        turingRound.connect(alice).claimPrize(0n)
      ).to.emit(turingRound, 'PrizeClaimed').withArgs(0n, alice.address, prize)
    })

    it('winner cannot claim twice', async function () {
      await expect(
        turingRound.connect(alice).claimPrize(0n)
      ).to.be.revertedWith('Already claimed')
    })
  })

  // ── recoverNoWinnerFunds — double-fee regression ──────────────────────────

  describe('recoverNoWinnerFunds (no-winner path)', function () {
    let prizePool, end
    before(async function () {
      await deployAll()
      ;({ end } = await createRound())
      await time.increase(15)
      await turingRound.connect(alice).enter(0n, false, { value: ENTRY_FEE })
      prizePool = ENTRY_FEE
      await time.increaseTo(end + 1)
      // Submit results with alice liquidated so there is no winner
      await turingRound.connect(keeper).submitResults(
        0n, [alice.address], [-100n], [true]
      )
    })

    it('contract holds exactly prizePool after submitResults', async function () {
      const bal = await ethers.provider.getBalance(await turingRound.getAddress())
      expect(bal).to.equal(prizePool)
    })

    it('recover sends prizePool - fee (not full prizePool)', async function () {
      const fee        = (prizePool * PROTOCOL_FEE) / 10_000n
      const expected   = prizePool - fee
      const before     = await ethers.provider.getBalance(owner.address)
      const tx         = await turingRound.recoverNoWinnerFunds(0n)
      const receipt    = await tx.wait()
      const gasUsed    = receipt.gasUsed * tx.gasPrice
      const after      = await ethers.provider.getBalance(owner.address)
      expect(after - before + gasUsed).to.equal(expected)
    })

    it('withdrawFees succeeds without draining contract (no double-spend)', async function () {
      // After recoverNoWinnerFunds, the fee is still in pendingOwnerFees
      // and should be withdrawable without reverting
      await expect(turingRound.withdrawFees()).to.not.be.reverted
    })
  })

  // ── setKeeper ─────────────────────────────────────────────────────────────

  describe('setKeeper', function () {
    before(deployAll)

    it('owner can change keeper', async function () {
      await expect(
        turingRound.setKeeper(alice.address)
      ).to.emit(turingRound, 'KeeperSet').withArgs(alice.address)
      expect(await turingRound.keeper()).to.equal(alice.address)
    })

    it('non-owner cannot change keeper', async function () {
      await expect(
        turingRound.connect(bob).setKeeper(bob.address)
      ).to.be.reverted
    })
  })
})
