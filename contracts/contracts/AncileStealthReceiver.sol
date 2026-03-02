// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract AncileStealthReceiver is IReceiver {
    address public immutable forwarder;
    address public immutable registry;

    enum ComplianceRule { DEFAULT, WORLD_ID_VERIFICATION }

    // Maps the hash of the stealth meta-address to the user's required rule 
    mapping(bytes32 metaAddressHash => ComplianceRule rule) public stealthRules;

    error InvalidForwarder();
    error InvalidRegistry();
    error OnlyForwarder();
    error ForwardCallFailed();

    event RuleStored(bytes32 indexed metaAddressHash, ComplianceRule rule);

    constructor(address _forwarder, address _registry) {
        if (_forwarder == address(0)) revert InvalidForwarder();
        if (_registry == address(0)) revert InvalidRegistry();
        forwarder = _forwarder;
        registry = _registry;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        if (msg.sender != forwarder) revert OnlyForwarder();

        // 1. Decode the custom payload from Chainlink CRE
        (
            address registrant,
            uint256 schemeId,
            bytes memory signature,
            bytes memory stealthMetaAddress,
            ComplianceRule rule
        ) = abi.decode(report, (address, uint256, bytes, bytes, ComplianceRule));

        // 2. Store Bob's compliance rules permanently on-chain
        bytes32 metaHash = keccak256(stealthMetaAddress);
        stealthRules[metaHash] = rule;
        emit RuleStored(metaHash, rule);

        // 3. Re-encode the data specifically for the standard ERC-6538 Registry
        bytes memory registryCalldata = abi.encodeWithSignature(
            "registerKeysOnBehalf(address,uint256,bytes,bytes)",
            registrant,
            schemeId,
            signature,
            stealthMetaAddress
        );

        // 4. Forward to the ScopeLift Registry
        (bool success, ) = registry.call(registryCalldata);
        if (!success) revert ForwardCallFailed();
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
