// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AgentRegistry is ERC721, Ownable {
    uint256 public nextTokenId = 1;

    struct Agent {
        string  name;
        string  strategyHash;
        address owner;
        uint256 roundsEntered;
        uint256 roundsWon;
        int256  totalRoi;       // basis points
        uint256 registeredAt;
    }

    mapping(uint256 => Agent) public agents;
    mapping(address => uint256) public ownerToAgent;
    mapping(address => bool) public authorised;

    event AgentRegistered(uint256 indexed tokenId, address indexed owner, string name);
    event StatsUpdated(uint256 indexed tokenId, int256 roundRoi, bool won);

    constructor() ERC721("TuringTrade Agent", "TTA") Ownable(msg.sender) {}

    modifier onlyAuthorised() {
        require(authorised[msg.sender] || msg.sender == owner(), "Not authorised");
        _;
    }

    function setAuthorised(address addr, bool val) external onlyOwner {
        authorised[addr] = val;
    }

    // Soulbound: block all transfers except mint (from=0) and burn (to=0)
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        require(from == address(0) || to == address(0), "Soulbound: non-transferable");
        return from;
    }

    function registerAgent(string calldata name, string calldata strategyHash) external returns (uint256) {
        require(ownerToAgent[msg.sender] == 0, "Agent already registered");
        require(bytes(name).length > 0 && bytes(name).length <= 64, "Invalid name length");
        uint256 id = nextTokenId++;
        _safeMint(msg.sender, id);
        agents[id] = Agent({
            name:          name,
            strategyHash:  strategyHash,
            owner:         msg.sender,
            roundsEntered: 0,
            roundsWon:     0,
            totalRoi:      0,
            registeredAt:  block.timestamp
        });
        ownerToAgent[msg.sender] = id;
        emit AgentRegistered(id, msg.sender, name);
        return id;
    }

    function updateStats(uint256 tokenId, int256 roundRoiBps, bool won) external onlyAuthorised {
        Agent storage a = agents[tokenId];
        a.roundsEntered++;
        a.totalRoi += roundRoiBps;
        if (won) a.roundsWon++;
        emit StatsUpdated(tokenId, roundRoiBps, won);
    }

    /// @notice Score 0-100 using fixed-point math (base 10000) to avoid truncation
    function reputationScore(uint256 tokenId) external view returns (uint256) {
        Agent memory a = agents[tokenId];
        if (a.roundsEntered == 0) return 0;

        // win rate → 0-50 pts (multiply before dividing)
        uint256 winRate = (a.roundsWon * 50 * 10000) / a.roundsEntered / 10000;

        // avg roi → 0-30 pts (capped at 3000 bps = 30%)
        int256 avgRoi = (a.totalRoi * 10000) / int256(a.roundsEntered) / 10000;
        uint256 roiPart = 0;
        if (avgRoi > 0) {
            uint256 uAvgRoi = uint256(avgRoi);
            roiPart = uAvgRoi >= 3000 ? 30 : (uAvgRoi * 30) / 3000;
        }

        // longevity → 0-20 pts (vests over 30 days)
        uint256 ageDays = (block.timestamp - a.registeredAt) / 1 days;
        uint256 agePart = ageDays >= 30 ? 20 : (ageDays * 20) / 30;

        return winRate + roiPart + agePart;
    }

    function getAgent(uint256 tokenId) external view returns (Agent memory) {
        return agents[tokenId];
    }
}
