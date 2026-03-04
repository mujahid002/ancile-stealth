// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Thin wrapper so Hardhat compiles and we can deploy proxy via getContractFactory("ERC1967ProxyDeployer")
contract ERC1967ProxyDeployer is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
