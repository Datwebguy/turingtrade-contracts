// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ReasoningLog.sol";
import "./AgentRegistry.sol";

contract TuringRound is Ownable, ReentrancyGuard {
    ReasoningLog    public reasoningLog;
    AgentRegistry   public agentRegistry;

    uint256 public constant PROTOCOL_FEE_BPS = 500;
    uint256 public constant MAX_PARTICIPANTS  = 100;
    int256  public constant MIN_AMOUNT_BPS    = 1;
    int256  public constant MAX_AMOUNT_BPS    = 10_000;

    // Separate keeper role — limits blast radius if the keeper key is compromised
    address public keeper;

    enum RoundState { Open, Active, Finalizing, Closed }

    struct Participant {
        address addr;
        bool    isAI;
        int256  roiBps;
        uint256 tradeCount;
        bool    liquidated;
        bool    claimed;
    }

    struct Round {
        uint256    id;
        uint256    entryFee;
        uint256    prizePool;
        uint256    startTime;
        uint256    endTime;
        RoundState state;
        address[]  participantList;
        address    winner;
        int256     winnerRoiBps;
    }

    uint256 public roundCount;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Participant)) public participants;
    uint256 public pendingOwnerFees;

    event KeeperSet(address indexed keeper);
    event RoundCreated(uint256 indexed roundId, uint256 entryFee, uint256 startTime, uint256 endTime);
    event ParticipantEntered(uint256 indexed roundId, address indexed participant, bool isAI);
    event TradeSubmitted(uint256 indexed roundId, address indexed trader, string pair, int256 amountBps, bool isBuy, uint256 logEntryId);
    event RoundFinalized(uint256 indexed roundId, address indexed winner, int256 winnerRoiBps, uint256 prize);
    event PrizeClaimed(uint256 indexed roundId, address indexed winner, uint256 amount);
    event FundsRecovered(uint256 indexed roundId, uint256 amount);

    modifier onlyKeeper() {
        require(msg.sender == keeper || msg.sender == owner(), "Not keeper");
        _;
    }

    constructor(address _reasoningLog, address _agentRegistry) Ownable(msg.sender) {
        reasoningLog  = ReasoningLog(_reasoningLog);
        agentRegistry = AgentRegistry(_agentRegistry);
        keeper = msg.sender;   // deployer is keeper by default; call setKeeper to rotate
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "Zero address");
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    function createRound(
        uint256 entryFee,
        uint256 startTime,
        uint256 endTime
    ) external onlyOwner returns (uint256 roundId) {
        require(endTime > startTime, "Invalid times");
        require(startTime >= block.timestamp, "Start in past");
        roundId = roundCount++;
        Round storage r = rounds[roundId];
        r.id        = roundId;
        r.entryFee  = entryFee;
        r.startTime = startTime;
        r.endTime   = endTime;
        r.state     = RoundState.Open;
        emit RoundCreated(roundId, entryFee, startTime, endTime);
    }

    function activateRound(uint256 roundId) external onlyOwner {
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Open, "Not open");
        require(block.timestamp >= r.startTime, "Not started");
        r.state = RoundState.Active;
    }

    function topUpPrize(uint256 roundId) external payable {
        RoundState s = rounds[roundId].state;
        require(s == RoundState.Open || s == RoundState.Active, "Round not active");
        rounds[roundId].prizePool += msg.value;
    }

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = pendingOwnerFees;
        require(amount > 0, "Nothing to withdraw");
        pendingOwnerFees = 0;
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "Withdraw failed");
    }

    function recoverNoWinnerFunds(uint256 roundId) external onlyOwner nonReentrant {
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Closed, "Not closed");
        require(r.winner == address(0), "Has a winner");
        // The fee portion was already added to pendingOwnerFees in submitResults.
        // Only recover the non-fee remainder to avoid double-counting.
        uint256 fee    = (r.prizePool * PROTOCOL_FEE_BPS) / 10_000;
        uint256 amount = r.prizePool - fee;
        require(amount > 0, "Nothing to recover");
        r.prizePool = 0;
        emit FundsRecovered(roundId, amount);
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "Transfer failed");
    }

    // ── Entry ──────────────────────────────────────────────────────────────

    function enter(uint256 roundId, bool isAI) external payable nonReentrant {
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Open || r.state == RoundState.Active, "Not accepting entries");
        require(block.timestamp < r.endTime, "Round ended");
        require(msg.value >= r.entryFee, "Below minimum entry fee");
        require(participants[roundId][msg.sender].addr == address(0), "Already entered");
        require(r.participantList.length < MAX_PARTICIPANTS, "Round full");

        if (isAI) {
            require(agentRegistry.ownerToAgent(msg.sender) != 0, "No registered agent");
        }

        r.prizePool += msg.value;
        r.participantList.push(msg.sender);
        participants[roundId][msg.sender] = Participant({
            addr:       msg.sender,
            isAI:       isAI,
            roiBps:     0,
            tradeCount: 0,
            liquidated: false,
            claimed:    false
        });

        if (r.state == RoundState.Open && block.timestamp >= r.startTime) {
            r.state = RoundState.Active;
        }

        emit ParticipantEntered(roundId, msg.sender, isAI);
    }

    // ── Trading ────────────────────────────────────────────────────────────

    function submitTrade(
        uint256 roundId,
        string calldata pair,
        int256  amountBps,
        bool    isBuy,
        string calldata reasoning
    ) external returns (uint256 logEntryId) {
        require(amountBps >= MIN_AMOUNT_BPS && amountBps <= MAX_AMOUNT_BPS, "amountBps out of range");
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Active, "Round not active");
        require(block.timestamp < r.endTime, "Round ended");
        Participant storage p = participants[roundId][msg.sender];
        require(p.addr != address(0), "Not entered");
        require(!p.liquidated, "Liquidated");

        logEntryId = reasoningLog.log(roundId, reasoning, bytes32(0));
        p.tradeCount++;

        emit TradeSubmitted(roundId, msg.sender, pair, amountBps, isBuy, logEntryId);
    }

    // ── Finalisation ───────────────────────────────────────────────────────

    // onlyKeeper: does not require full owner privileges
    function submitResults(
        uint256 roundId,
        address[] calldata addrs,
        int256[]  calldata roiBpsArr,
        bool[]    calldata liquidatedArr
    ) external onlyKeeper {
        require(
            addrs.length == roiBpsArr.length && addrs.length == liquidatedArr.length,
            "Length mismatch"
        );
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Active || r.state == RoundState.Finalizing, "Wrong state");
        require(block.timestamp >= r.endTime, "Round not ended");
        r.state = RoundState.Finalizing;

        address winner;
        int256  best = type(int256).min;

        for (uint256 i; i < addrs.length; i++) {
            Participant storage p = participants[roundId][addrs[i]];
            p.roiBps     = roiBpsArr[i];
            p.liquidated = liquidatedArr[i];
            if (!liquidatedArr[i] && roiBpsArr[i] > best) {
                best   = roiBpsArr[i];
                winner = addrs[i];
            }
        }

        r.winner       = winner;
        r.winnerRoiBps = best;
        r.state        = RoundState.Closed;

        uint256 fee = (r.prizePool * PROTOCOL_FEE_BPS) / 10_000;
        pendingOwnerFees += fee;

        emit RoundFinalized(roundId, winner, best, r.prizePool - fee);
    }

    function claimPrize(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        require(r.state == RoundState.Closed, "Not closed");
        require(r.winner == msg.sender, "Not winner");
        Participant storage p = participants[roundId][msg.sender];
        require(!p.claimed, "Already claimed");
        p.claimed = true;

        uint256 fee   = (r.prizePool * PROTOCOL_FEE_BPS) / 10_000;
        uint256 prize = r.prizePool - fee;
        (bool ok,) = msg.sender.call{value: prize}("");
        require(ok, "Transfer failed");
        emit PrizeClaimed(roundId, msg.sender, prize);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function getParticipants(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].participantList;
    }

    function getParticipant(uint256 roundId, address addr) external view returns (Participant memory) {
        return participants[roundId][addr];
    }
}
