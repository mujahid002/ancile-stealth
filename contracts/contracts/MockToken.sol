// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockToken
/// @notice A mock ERC20 token with mint capability and ERC-2612 permit support.
contract MockToken is ERC20, ERC20Permit, Ownable {
    constructor(
        string memory name_,
        string memory symbol_,
        address owner_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(owner_) payable {
        _mint(owner_, 10_000_000 * 10 ** 6); // 10M tokens when decimals = 6
    }

    /// @notice Mint tokens to a specified address. Only the owner can mint.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6; // 6 decimals for USDC-style token
    }
}
