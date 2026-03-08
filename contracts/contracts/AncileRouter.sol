// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title AncileRouter
 * @author @mujahid002
 * @notice A stateless, privacy-preserving router that leverages Chainlink CRE to facilitate
 * gasless stealth transfers, sharded OTC settlements, private swaps and more
 * @dev This contract acts as the on-chain executor for off-chain intents matched within a TEE.
 */
contract AncileRouter is Initializable, UUPSUpgradeable, IReceiver {
    /// @notice The trusted Chainlink Forwarder address that is allowed to call onReport.
    address public forwarder;

    /// @notice The ERC-5564 Stealth Address Registry called meta addresses by ERC-6538
    address public registry;

    address public owner;

    /// @notice Defines the specific execution route the Chainlink CRE will trigger.
    enum ActionType {
        DEFAULT,
        REGISTER, // Register user after World Id verification
        P2P_DISPATCH, // Standard p2p stealth transfer
        SWEEP, // Single gasless sweep
        SWAP, // Gasless private swap
        OTC_SWAP, // 1-to-1 OTC trade
        MEGA_BATCH_OTC, // Sharded & multi-output OTC trades
        BATCH_SWEEP // Gasless multi wallet sweep
    }

    /// @notice Defines compliance requirements for receiving stealth funds.
    enum ComplianceRule {
        DEFAULT,
        WORLD_ID_REQUIRED // Enforces proof of humanity
    }

    /// @notice Maps a user's standard address to their chosen ERC-5564 scheme ID.
    mapping(address => uint256) public creSchemeIds;

    /// @notice Maps a user's address to their required compliance rule to get funds from verified human
    mapping(address => ComplianceRule) public stealthRules;

    /// @notice Nonces for off-chain intent signatures to prevent replay attacks.
    mapping(address => uint256) public routerNonces;

    /// @notice Standard ERC-5564 Announcement event emitted when a stealth address receives funds.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        bytes ephemeralPubKey,
        bytes metadata
    );

    error OnlyForwarder();
    error InvalidAction();
    error UnauthorizedUpgrade();
    error OnlyOwner();

    // ==========================================
    // STRUCTS (PAYLOAD DECODING)
    // ==========================================

    /// @dev EIP-2612 Permit data for pulling tokens gaslessly.
    struct PermitData {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Ancile-specific off-chain intent signature to verify user execution requests.
    struct IntentData {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Payload for standard P2P stealth transfers (ActionType 2).
    struct P2PPayload {
        address token;
        uint256 amount;
        address sender;
        address recipientRegistrant;
        address stealthAddress;
        bytes pubKey;
        PermitData permit;
        IntentData intent;
    }

    /// @dev Payload for single stealth address gasless sweeps (ActionType 3).
    struct SweepPayload {
        address token;
        uint256 amount;
        address stealthAddress;
        address destination;
        PermitData permit;
        IntentData intent;
    }

    /// @dev Payload for gasless token-to-ETH swaps from a stealth address (ActionType 4).
    struct SwapPayload {
        address token;
        uint256 amount;
        address stealthAddress;
        uint256 ethOutputAmount;
        PermitData permit;
        IntentData intent;
    }

    /// @dev Payload for standard 1-to-1 OTC swaps (ActionType 5).
    struct OTCPayload {
        address tokenA;
        address ownerA;
        uint256 amountA;
        uint256 deadlineA;
        uint8 vA;
        bytes32 rA;
        bytes32 sA;
        address stealthAddressB;
        bytes ephemeralPubKeyB;
        address tokenB;
        address ownerB;
        uint256 amountB;
        uint256 deadlineB;
        uint8 vB;
        bytes32 rB;
        bytes32 sB;
        address stealthAddressA;
        bytes ephemeralPubKeyA;
    }

    /// @dev Input chunk for the Sharded OTC Mega-Batch. Represents one user's funds being pulled.
    struct PermitPull {
        address token;
        address owner;
        uint256 amount;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Output chunk for the Sharded OTC Mega-Batch. Represents a fraction of funds sent to a ghost wallet.
    struct ShardPush {
        address token;
        address to;
        uint256 amount;
    }

    // ==========================================
    // UUPS INITIALIZATION
    // ==========================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the proxy contract state. Replaces standard constructor.
    /// @param _forwarder The trusted Chainlink CRE Forwarder address.
    /// @param _registry The official ERC-5564 Stealth Address Registry.
    /// @param _initialOwner The admin capable of upgrading the contract.
    function initialize(
        address _forwarder,
        address _registry,
        address _initialOwner
    ) public initializer {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        owner = _initialOwner;
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert UnauthorizedUpgrade();
    }

    /// @notice Fallback to accept native ETH for router liquidity (used in private SWAPs).
    receive() external payable {}

    // ==========================================
    // MAIN CRE ROUTER DECODER
    // ==========================================

    /// @notice The main entry point triggered exclusively by the Chainlink Forwarder.
    /// @dev Acts as a switchboard routing the encoded payload to the correct internal handler.
    /// @dev metadata Unused in this implementation, reserved for CCIP/CRE standard.
    /// @param report The ABI encoded payload containing the ActionType and nested logic data.
    function onReport(
        bytes calldata /* metadata */,
        bytes calldata report
    ) external override {
        if (msg.sender != forwarder) revert OnlyForwarder();

        (ActionType action, bytes memory payload) = abi.decode(
            report,
            (ActionType, bytes)
        );

        if (action == ActionType.REGISTER) _handleRegistration(payload);
        else if (action == ActionType.P2P_DISPATCH) _handleP2PDispatch(payload);
        else if (action == ActionType.SWEEP) _handleStealthSweep(payload);
        else if (action == ActionType.SWAP) _handleStealthSwap(payload);
        else if (action == ActionType.OTC_SWAP) _handleOTC(payload);
        else if (action == ActionType.MEGA_BATCH_OTC)
            _handleMegaBatchOTC(payload);
        else if (action == ActionType.BATCH_SWEEP) _handleBatchSweep(payload);
        else revert InvalidAction();
    }

    /// @notice Registers a user to the ERC-5564 registry via the CRE relayer.
    function _handleRegistration(bytes memory payload) internal {
        (
            address registrant,
            uint256 schemeId,
            bytes memory signature,
            bytes memory stealthMeta,
            ComplianceRule rule
        ) = abi.decode(
                payload,
                (address, uint256, bytes, bytes, ComplianceRule)
            );

        creSchemeIds[registrant] = schemeId;
        stealthRules[registrant] = rule;

        (bool success, ) = registry.call(
            abi.encodeWithSignature(
                "registerKeysOnBehalf(address,uint256,bytes,bytes)",
                registrant,
                schemeId,
                signature,
                stealthMeta
            )
        );
        require(success, "Registry failed");
    }

    /// @notice Handles a gasless P2P stealth transfer.
    /// @dev Validates the user's intent, consumes their EIP-2612 permit, and forwards to the stealth address.
    function _handleP2PDispatch(bytes memory payload) internal {
        P2PPayload memory data = abi.decode(payload, (P2PPayload));

        // Verify User Intent
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                data.sender,
                data.stealthAddress,
                data.amount,
                routerNonces[data.sender]
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        require(
            ecrecover(
                ethSignedMessageHash,
                data.intent.v,
                data.intent.r,
                data.intent.s
            ) == data.sender,
            "Invalid intent signature"
        );

        routerNonces[data.sender]++;

        // Consume ERC20 Permit
        IERC20Permit(data.token).permit(
            data.sender,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );

        // Transfer Funds
        require(
            IERC20Permit(data.token).transferFrom(
                data.sender,
                data.stealthAddress,
                data.amount
            ),
            "Token transfer failed"
        );

        // Emit ERC-5564 Announcement
        emit Announcement(
            creSchemeIds[data.recipientRegistrant],
            data.stealthAddress,
            data.pubKey,
            ""
        );
    }

    /// @notice Gaslessly sweeps funds from a stealth address to a final destination (e.g., CEX).
    function _handleStealthSweep(bytes memory payload) internal {
        SweepPayload memory data = abi.decode(payload, (SweepPayload));

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                data.stealthAddress,
                data.destination,
                data.amount,
                routerNonces[data.stealthAddress]
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        require(
            ecrecover(
                ethSignedMessageHash,
                data.intent.v,
                data.intent.r,
                data.intent.s
            ) == data.stealthAddress,
            "Invalid intent signature"
        );

        routerNonces[data.stealthAddress]++;

        IERC20Permit(data.token).permit(
            data.stealthAddress,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );
        require(
            IERC20Permit(data.token).transferFrom(
                data.stealthAddress,
                data.destination,
                data.amount
            ),
            "Sweep Transfer failed"
        );
    }

    /// @notice Swaps tokens holding in a stealth address for native ETH gaslessly.
    function _handleStealthSwap(bytes memory payload) internal {
        SwapPayload memory data = abi.decode(payload, (SwapPayload));
        require(
            address(this).balance >= data.ethOutputAmount,
            "Router lacks ETH liquidity"
        );

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                data.stealthAddress,
                data.token,
                data.amount,
                routerNonces[data.stealthAddress]
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        require(
            ecrecover(
                ethSignedMessageHash,
                data.intent.v,
                data.intent.r,
                data.intent.s
            ) == data.stealthAddress,
            "Invalid intent signature"
        );

        routerNonces[data.stealthAddress]++;

        IERC20Permit(data.token).permit(
            data.stealthAddress,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );
        require(
            IERC20Permit(data.token).transferFrom(
                data.stealthAddress,
                address(this),
                data.amount
            ),
            "Token pull failed"
        );

        (bool ethSuccess, ) = data.stealthAddress.call{
            value: data.ethOutputAmount
        }("");
        require(ethSuccess, "ETH Transfer failed");
    }

    /// @notice Executes a standard 1-to-1 OTC trade between two stealth addresses.
    function _handleOTC(bytes memory payload) internal {
        OTCPayload memory data = abi.decode(payload, (OTCPayload));

        IERC20Permit(data.tokenA).permit(
            data.ownerA,
            address(this),
            data.amountA,
            data.deadlineA,
            data.vA,
            data.rA,
            data.sA
        );
        IERC20Permit(data.tokenB).permit(
            data.ownerB,
            address(this),
            data.amountB,
            data.deadlineB,
            data.vB,
            data.rB,
            data.sB
        );

        require(
            IERC20Permit(data.tokenA).transferFrom(
                data.ownerA,
                data.stealthAddressB,
                data.amountA
            ),
            "Ancile: Token A transfer failed"
        );
        require(
            IERC20Permit(data.tokenB).transferFrom(
                data.ownerB,
                data.stealthAddressA,
                data.amountB
            ),
            "Ancile: Token B transfer failed"
        );

        emit Announcement(1, data.stealthAddressB, data.ephemeralPubKeyB, "");
        emit Announcement(1, data.stealthAddressA, data.ephemeralPubKeyA, "");
    }

    /// @notice Executes a Sharded OTC Darkpool match.
    /// @dev Shatters the on-chain graph by taking aggregated inputs (pulls) and distributing to many ghost wallets (pushes).
    /// Prevents MEV front-running as intents are matched entirely off-chain by the CRE.
    function _handleMegaBatchOTC(bytes memory payload) internal {
        (PermitPull[] memory pulls, ShardPush[] memory pushes) = abi.decode(
            payload,
            (PermitPull[], ShardPush[])
        );

        // Consume all permits and pull tokens into the Router's Vault
        for (uint i = 0; i < pulls.length; i++) {
            IERC20Permit(pulls[i].token).permit(
                pulls[i].owner,
                address(this),
                pulls[i].amount,
                pulls[i].deadline,
                pulls[i].v,
                pulls[i].r,
                pulls[i].s
            );

            require(
                IERC20Permit(pulls[i].token).transferFrom(
                    pulls[i].owner,
                    address(this),
                    pulls[i].amount
                ),
                "Ancile MegaBatch: Pull failed"
            );
        }

        // Distribute all shards to the generated ghost addresses
        for (uint j = 0; j < pushes.length; j++) {
            require(
                IERC20Permit(pushes[j].token).transfer(
                    pushes[j].to,
                    pushes[j].amount
                ),
                "Ancile MegaBatch: Push failed"
            );
        }
    }

    /// @notice Gaslessly sweeps multiple stealth shards to a single CEX destination.
    /// @dev Saves massive gas compared to individual sweeps and keeps the master wallet hidden.
    function _handleBatchSweep(bytes memory payload) internal {
        SweepPayload[] memory sweeps = abi.decode(payload, (SweepPayload[]));

        for (uint i = 0; i < sweeps.length; i++) {
            SweepPayload memory data = sweeps[i];

            // Verify the Ghost Wallet's intent to sweep
            bytes32 messageHash = keccak256(
                abi.encodePacked(
                    data.stealthAddress,
                    data.destination,
                    data.amount,
                    routerNonces[data.stealthAddress]
                )
            );
            bytes32 ethSignedMessageHash = keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32",
                    messageHash
                )
            );
            require(
                ecrecover(
                    ethSignedMessageHash,
                    data.intent.v,
                    data.intent.r,
                    data.intent.s
                ) == data.stealthAddress,
                "Invalid intent signature"
            );

            routerNonces[data.stealthAddress]++;

            // Consume the Ghost Wallet's EIP-2612 Permit
            IERC20Permit(data.token).permit(
                data.stealthAddress,
                address(this),
                data.amount,
                data.permit.deadline,
                data.permit.v,
                data.permit.r,
                data.permit.s
            );

            // Sweep the tokens to the CEX address
            require(
                IERC20Permit(data.token).transferFrom(
                    data.stealthAddress,
                    data.destination,
                    data.amount
                ),
                "Sweep Transfer failed"
            );
        }
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
