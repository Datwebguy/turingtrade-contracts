// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

contract ReasoningLog is Ownable {
    uint256 public constant MAX_REASONING_LENGTH = 2048;

    struct LogEntry {
        address agent;
        uint256 roundId;
        string  reasoning;
        bytes32 dataHash;
        uint256 timestamp;
        uint256 blockNumber;
    }

    uint256 public entryCount;
    mapping(uint256 => LogEntry) public entries;
    mapping(address => mapping(uint256 => uint256[])) public agentRoundEntries;
    mapping(address => bool) public authorised;

    event ReasoningLogged(
        uint256 indexed entryId,
        address indexed agent,
        uint256 indexed roundId,
        string  reasoning,
        bytes32 dataHash,
        uint256 timestamp
    );

    constructor() Ownable(msg.sender) {}

    modifier onlyAuthorised() {
        require(authorised[msg.sender] || msg.sender == owner(), "Not authorised");
        _;
    }

    function setAuthorised(address addr, bool val) external onlyOwner {
        authorised[addr] = val;
    }

    function log(
        uint256 roundId,
        string calldata reasoning,
        bytes32 dataHash
    ) external onlyAuthorised returns (uint256 entryId) {
        uint256 len = bytes(reasoning).length;
        require(len > 0, "Empty reasoning");
        require(len <= MAX_REASONING_LENGTH, "Reasoning too long");

        entryId = entryCount++;
        entries[entryId] = LogEntry({
            agent:       msg.sender,
            roundId:     roundId,
            reasoning:   reasoning,
            dataHash:    dataHash,
            timestamp:   block.timestamp,
            blockNumber: block.number
        });
        agentRoundEntries[msg.sender][roundId].push(entryId);
        emit ReasoningLogged(entryId, msg.sender, roundId, reasoning, dataHash, block.timestamp);
    }

    function getEntry(uint256 entryId) external view returns (LogEntry memory) {
        return entries[entryId];
    }

    function getAgentRoundEntries(address agent, uint256 roundId)
        external view returns (uint256[] memory)
    {
        return agentRoundEntries[agent][roundId];
    }
}
