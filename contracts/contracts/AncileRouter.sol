// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

// 🌟 Upgraded to include the EIP-2612 Permit function
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

contract AncileRouter is IReceiver {
    address public immutable forwarder;
    address public immutable registry;
    address public owner;

    enum ActionType {
        DEFAULT,
        REGISTER,
        P2P_DISPATCH,
        SWEEP,
        SWAP
    }
    enum ComplianceRule {
        DEFAULT,
        WORLD_ID_REQUIRED
    }

    mapping(address => uint256) public creSchemeIds;
    mapping(address => ComplianceRule) public stealthRules;
    mapping(address => uint256) public routerNonces; // Prevents replay attacks on intents

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        bytes ephemeralPubKey,
        bytes metadata
    );

    error OnlyForwarder();
    error OnlyOwner();

    // ==========================================
    // STRUCTS (Prevents "Stack Too Deep" errors)
    // ==========================================
    struct PermitData {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct IntentData {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

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

    struct SweepPayload {
        address token;
        uint256 amount;
        address stealthAddress;
        address destination;
        PermitData permit;
        IntentData intent;
    }

    struct SwapPayload {
        address token;
        uint256 amount;
        address stealthAddress;
        uint256 ethOutputAmount;
        PermitData permit;
        IntentData intent;
    }

    constructor(address _forwarder, address _registry, address _owner) {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        owner = _owner;
    }

    // Allow the Router to receive ETH liquidity for Swaps
    receive() external payable {}

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
    }

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

    // ==========================================
    // ROUTE 1: ALICE -> STEALTH ADDRESS
    // ==========================================
    function _handleP2PDispatch(bytes memory payload) internal {
        P2PPayload memory data = abi.decode(payload, (P2PPayload));

        // 1. Verify Alice's Intent (Where does she want it to go?)
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

        // 2. Execute ERC-20 Permit (Allows Router to pull funds)
        IERC20Permit(data.token).permit(
            data.sender,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );

        // 3. Move Physical Tokens Directly to Stealth Address
        bool success = IERC20Permit(data.token).transferFrom(
            data.sender,
            data.stealthAddress,
            data.amount
        );
        require(success, "Token transfer failed");

        emit Announcement(
            creSchemeIds[data.recipientRegistrant],
            data.stealthAddress,
            data.pubKey,
            ""
        );
    }

    // ==========================================
    // ROUTE 2: STEALTH ADDRESS -> FINAL DESTINATION
    // ==========================================
    function _handleStealthSweep(bytes memory payload) internal {
        SweepPayload memory data = abi.decode(payload, (SweepPayload));

        // 1. Verify Bob's Intent using derived Stealth Key
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

        // 2. Execute ERC-20 Permit (Allows Router to pull from Stealth Address)
        IERC20Permit(data.token).permit(
            data.stealthAddress,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );

        // 3. Move Physical Tokens to Binance/Cold Wallet
        bool success = IERC20Permit(data.token).transferFrom(
            data.stealthAddress,
            data.destination,
            data.amount
        );
        require(success, "Sweep Transfer failed");
    }

    // ==========================================
    // ROUTE 3: STEALTH ADDRESS -> SWAP FOR ETH
    // ==========================================
    function _handleStealthSwap(bytes memory payload) internal {
        SwapPayload memory data = abi.decode(payload, (SwapPayload));
        require(
            address(this).balance >= data.ethOutputAmount,
            "Router lacks ETH liquidity"
        );

        // 1. Verify Bob's Intent
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

        // 2. Execute ERC-20 Permit
        IERC20Permit(data.token).permit(
            data.stealthAddress,
            address(this),
            data.amount,
            data.permit.deadline,
            data.permit.v,
            data.permit.r,
            data.permit.s
        );

        // 3. Router pulls USDC to its own treasury
        bool success = IERC20Permit(data.token).transferFrom(
            data.stealthAddress,
            address(this),
            data.amount
        );
        require(success, "USDC pull failed");

        // 4. Router sends Native ETH to the Stealth Address!
        (bool ethSuccess, ) = data.stealthAddress.call{
            value: data.ethOutputAmount
        }("");
        require(ethSuccess, "ETH Transfer failed");
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function bobSetup(
        address registrant,
        uint256 schemeId,
        ComplianceRule rule
    ) external {
        if (msg.sender != owner) revert OnlyOwner();
        stealthRules[registrant] = rule;
        creSchemeIds[registrant] = schemeId;
    }
}
