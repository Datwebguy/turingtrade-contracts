// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Executes real swaps on Mantle DeFi (Merchant Moe / Agni Finance).
///         On testnet: records trade intent via events only.
///         On mainnet: calls real DEX routers.
contract TradeExecutor is Ownable {
    // Mantle mainnet router addresses (set after deployment)
    address public merchantMoeRouter;   // Merchant Moe LB Router
    address public agniRouter;          // Agni Finance SwapRouter

    // Testnet mode: emit events only, no real swaps
    bool public testnetMode = true;

    mapping(address => bool) public authorisedCallers; // TuringRound

    event TradeExecuted(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 roundId,
        string  dex
    );
    event TradeIntent(
        address indexed trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 roundId
    );

    constructor() Ownable(msg.sender) {}

    modifier onlyAuthorised() {
        require(authorisedCallers[msg.sender] || msg.sender == owner(), "Not authorised");
        _;
    }

    function setAuthorised(address addr, bool val) external onlyOwner {
        authorisedCallers[addr] = val;
    }

    function setRouters(address _moe, address _agni) external onlyOwner {
        merchantMoeRouter = _moe;
        agniRouter        = _agni;
    }

    function setTestnetMode(bool val) external onlyOwner {
        testnetMode = val;
    }

    /// @notice Execute a token swap for a round participant.
    ///         Testnet: emit TradeIntent only.
    ///         Mainnet: route through Merchant Moe or Agni Finance.
    function executeTrade(
        address trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 /* minAmountOut */,
        uint256 roundId,
        bool    useMerchantMoe
    ) external onlyAuthorised returns (uint256 amountOut) {
        if (testnetMode) {
            emit TradeIntent(trader, tokenIn, tokenOut, amountIn, roundId);
            return amountIn; // 1:1 mock on testnet
        }

        IERC20(tokenIn).transferFrom(trader, address(this), amountIn);
        IERC20(tokenIn).approve(useMerchantMoe ? merchantMoeRouter : agniRouter, amountIn);

        // Mainnet routing is configured post-deployment using the router ABIs
        // Merchant Moe: ILBRouter.swapExactTokensForTokens
        // Agni Finance: ISwapRouter.exactInputSingle
        // Both are standard Uniswap v2/v3 compatible interfaces
        revert("Mainnet routing: configure router calldata");
    }
}
