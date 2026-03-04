// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract AncileRouterWithUUPS is Initializable, UUPSUpgradeable, IReceiver {
    address public forwarder;
    address public registry;
    address public upgradeAdmin;

    enum ActionType { DEFAULT, REGISTER, TRANSFER }
    enum ComplianceRule { DEFAULT, WORLD_ID_VERIFICATION }

    mapping(address registrant => ComplianceRule rule) public stealthRules;
    mapping(address registrant => uint256 creSchemeId) public creSchemeIds;

    event RuleStored(address indexed registrant, ComplianceRule rule);
    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, bytes ephemeralPubKey, bytes metadata);

    error OnlyForwarder();
    error ForwardCallFailed();
    error InvalidAction();
    error UnauthorizedUpgrade();
    error RecipientNotRegistered(address registrant);
    error InsufficientAllowance(address token, address owner, address spender, uint256 have, uint256 need);

    struct TransferPayload {
        address token;
        uint256 amount;
        address sender;
        address recipientRegistrant;
        address stealthAddress;
        bytes ephemeralPubKey;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _forwarder,
        address _registry,
        address _upgradeAdmin
    ) public initializer {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        upgradeAdmin = _upgradeAdmin;
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != upgradeAdmin) revert UnauthorizedUpgrade();
    }

    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        if (msg.sender != forwarder) revert OnlyForwarder();

        (ActionType action, bytes memory payload) = abi.decode(report, (ActionType, bytes));

        if (action == ActionType.REGISTER) {
            _handleRegistration(payload);
        } else if (action == ActionType.TRANSFER) {
            _handlePrivateTransfer(payload);
        } else {
            revert InvalidAction();
        }
    }

    // ==========================================
    // PHASE 1: REGISTRATION LOGIC
    // ==========================================
    function _handleRegistration(bytes memory payload) internal {
        (
            address registrant,
            uint256 schemeId,
            bytes memory signature,
            bytes memory stealthMetaAddress,
            ComplianceRule rule
        ) = abi.decode(payload, (address, uint256, bytes, bytes, ComplianceRule));

        stealthRules[registrant] = rule;
        creSchemeIds[registrant] = schemeId;
        emit RuleStored(registrant, rule);

        bytes memory registryCalldata = abi.encodeWithSignature(
            "registerKeysOnBehalf(address,uint256,bytes,bytes)",
            registrant,
            schemeId,
            signature,
            stealthMetaAddress
        );

        (bool success, ) = registry.call(registryCalldata);
        if (!success) revert ForwardCallFailed();
    }

    // ==========================================
    // PHASE 2: TRANSFER LOGIC
    // ==========================================
    // Forwarder calls this contract's onReport(); so msg.sender = forwarder, address(this) = router (receiver).
    // Token allowance is checked for (sender, address(this)) and transferFrom is called by this contract.
    // So the spender that must have allowance is THIS contract (the receiver). Alice must approve this address.
    function _handlePrivateTransfer(bytes memory payload) internal {
        TransferPayload memory data = abi.decode(payload, (TransferPayload));

        uint256 activeSchemeId = creSchemeIds[data.recipientRegistrant];
        if (activeSchemeId == 0) revert RecipientNotRegistered(data.recipientRegistrant);

        // Spender = address(this) = router (CRE receiver). Must match the address Alice approved.
        uint256 allowed = IERC20(data.token).allowance(data.sender, address(this));
        if (allowed < data.amount) {
            revert InsufficientAllowance(data.token, data.sender, address(this), allowed, data.amount);
        }

        // Caller is this contract, so token uses allowance(data.sender, address(this)).
        bool success = IERC20(data.token).transferFrom(data.sender, data.stealthAddress, data.amount);
        require(success, "Token transfer failed");

        emit Announcement(activeSchemeId, data.stealthAddress, data.ephemeralPubKey, "");
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
