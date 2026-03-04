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

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IWorldID {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external;
}

contract AncileRouterWithWorldId is Initializable, UUPSUpgradeable, IReceiver {
    address public forwarder;
    address public registry;
    address public worldId;
    uint256 public externalNullifierHash;
    address public upgradeAdmin;

    enum ActionType { DEFAULT, REGISTER, TRANSFER }
    enum ComplianceRule { DEFAULT, WORLD_ID_VERIFICATION }

    // Mapped to Bob's Public Address (Registrant)
    mapping(address registrant => ComplianceRule rule) public stealthRules;
    mapping(address registrant => uint256 creSchemeId) public creSchemeIds;
    mapping(uint256 nullifierHash => bool) public usedNullifiers;

    event RuleStored(address indexed registrant, ComplianceRule rule);
    event Announcement(uint256 indexed schemeId, address indexed stealthAddress, bytes ephemeralPubKey, bytes metadata);

    error OnlyForwarder(); // 0xa73d3741
    error ForwardCallFailed(); // 0x30c8edd7
    error InvalidAction(); // 0x4a7f394f
    error DuplicateNullifier(); // 0xe1200f1d
    error UnauthorizedUpgrade(); // 0x3a617a54
    error InvalidSchemeId(); // 0xb6edd0be

    /// @dev EIP-55 checksummed "0x" + 40 hex chars. World ID staging hashes signal as this UTF-8 string.
    function _addressToHexString(address a) internal pure returns (string memory) {
        bytes memory hexCharsLower = "0123456789abcdef";
        bytes memory hexCharsUpper = "0123456789ABCDEF";
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(uint160(a) >> (8 * (19 - i)));
            s[2 + i * 2] = hexCharsLower[b >> 4];
            s[3 + i * 2] = hexCharsLower[b & 0x0f];
        }
        bytes32 h = keccak256(abi.encodePacked(string(s)));
        for (uint256 i = 0; i < 40; i++) {
            uint8 c = uint8(s[2 + i]);
            if (c >= 0x61 && c <= 0x66) {
                uint256 nibble = (uint256(h) >> (4 * (63 - i))) & 0xf;
                s[2 + i] = nibble >= 8 ? hexCharsUpper[c - 0x57] : hexCharsLower[c - 0x57];
            }
        }
        return string(s);
    }

    struct TransferPayload {
        address token;
        uint256 amount;
        address sender;             // Alice's public address
        address recipientRegistrant;// Bob's public address (used to look up rules)
        address stealthAddress;     // 1-Time address where funds actually go
        bytes ephemeralPubKey;
        uint256 permitDeadline;
        uint8 permitV;
        bytes32 permitR;
        bytes32 permitS;
        uint256 wldRoot;
        uint256 wldNullifierHash;
        uint256[8] wldProof;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _forwarder,
        address _registry,
        address _worldId,
        string calldata _appId,
        string calldata _actionId,
        address _upgradeAdmin
    ) public initializer {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        worldId = _worldId;
        upgradeAdmin = _upgradeAdmin;
        // World ID legacy spec: hashToField twice — (1) appId, (2) encode(appIdField, action)
        uint256 appIdField = uint256(keccak256(abi.encodePacked(_appId))) >> 8;
        externalNullifierHash = uint256(keccak256(abi.encodePacked(appIdField, _actionId))) >> 8;
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

        // 1. Store rules and scheme using the registrant address
        stealthRules[registrant] = rule;
        creSchemeIds[registrant] = schemeId;
        emit RuleStored(registrant, rule);

        // 2. Re-encode and Forward to ScopeLift Registry
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
    function _handlePrivateTransfer(bytes memory payload) internal {
        TransferPayload memory data = abi.decode(payload, (TransferPayload));

        // 1. Check Rules using Bob's public address
        ComplianceRule rule = stealthRules[data.recipientRegistrant];
        
        if (rule == ComplianceRule.WORLD_ID_VERIFICATION) {
            if (usedNullifiers[data.wldNullifierHash]) revert DuplicateNullifier();
            usedNullifiers[data.wldNullifierHash] = true;

            // Signal: World ID staging/simulator often hashes signal as UTF-8 string (e.g. "0x8a52..."). Match that.
            string memory signalString = _addressToHexString(data.sender);
            uint256 signalHash = uint256(keccak256(abi.encodePacked(signalString))) >> 8;

            IWorldID(worldId).verifyProof(
                data.wldRoot,
                1, // groupId = 1 (Orb)
                signalHash,
                data.wldNullifierHash,
                externalNullifierHash,
                data.wldProof
            );
        }

        // 3. Execute ERC-20 Permit (Gasless Authorization)
        IERC20Permit(data.token).permit(
            data.sender,
            address(this),
            data.amount,
            data.permitDeadline,
            data.permitV,
            data.permitR,
            data.permitS
        );

        // 4. Transfer funds to Stealth Address
        bool success = IERC20Permit(data.token).transferFrom(data.sender, data.stealthAddress, data.amount);
        require(success, "Token transfer failed");

        // 5. Emit Announcement using Bob's registered schemeId
        uint256 activeSchemeId = creSchemeIds[data.recipientRegistrant];
        if (activeSchemeId == 0) revert InvalidSchemeId();

        emit Announcement(activeSchemeId, data.stealthAddress, data.ephemeralPubKey, "");
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
