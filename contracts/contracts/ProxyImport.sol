// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Force Hardhat to compile and generate artifact for ERC1967Proxy
contract ProxyImport is ERC1967Proxy {
    constructor(address impl, bytes memory data) ERC1967Proxy(impl, data) {}
}
