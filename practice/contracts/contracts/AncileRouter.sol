// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

// Full interface to support EIP-2612 Permit and transferFrom
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract AncileRouter is IReceiver {
    address public immutable forwarder;
    address public immutable registry;
    address public immutable owner;

    enum ActionType { DEFAULT, REGISTER, TRANSFER }
    enum ComplianceRule { DEFAULT, WORLD_ID_VERIFICATION }

    mapping(address => ComplianceRule) public stealthRules;
    mapping(address => uint256) public creSchemeIds;

    event RuleStored(address indexed registrant, ComplianceRule rule);
    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, bytes ephemeralPubKey, bytes metadata);

    error OnlyForwarder();
    error ForwardCallFailed();
    error InvalidAction();
    error InvalidSchemeId();
    error OnlyOwner();

    struct TransferPayload {
        address token;
        uint256 amount;
        address sender;
        address recipientRegistrant;
        address stealthAddress;
        bytes ephemeralPubKey;
        uint256 permitDeadline;
        uint8 permitV;
        bytes32 permitR;
        bytes32 permitS;
    }

    // 🌟 Standard Constructor replacing the Initializable Proxy logic
    constructor(address _forwarder, address _registry, address _owner) {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        owner = _owner;
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

    function _handlePrivateTransfer(bytes memory payload) internal {
        TransferPayload memory data = abi.decode(payload, (TransferPayload));

        // 1. Execute ERC-20 Permit to grant this EXACT contract an allowance
        IERC20Permit(data.token).permit(
            data.sender,
            address(this), 
            data.amount,
            data.permitDeadline,
            data.permitV,
            data.permitR,
            data.permitS
        );

        // 2. Transfer funds to Bob's Stealth Address
        bool success = IERC20Permit(data.token).transferFrom(data.sender, data.stealthAddress, data.amount);
        require(success, "Token transfer failed");

        uint256 activeSchemeId = creSchemeIds[data.recipientRegistrant];
        if (activeSchemeId == 0) revert InvalidSchemeId();

        emit Announcement(activeSchemeId, data.stealthAddress, data.ephemeralPubKey, "");
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function bobSetup(address registrant, uint256 schemeId, ComplianceRule rule) external {
        if (msg.sender != owner) revert OnlyOwner();
        stealthRules[registrant] = rule;
        creSchemeIds[registrant] = schemeId;
        emit RuleStored(registrant, rule);
    }
}
