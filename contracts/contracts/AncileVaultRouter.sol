// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

contract AncileVaultRouter is IReceiver {
    address public immutable forwarder;
    address public immutable registry;
    address public owner;

    enum ActionType {
        DEFAULT,
        REGISTER,
        P2P_DISPATCH
    }
    enum ComplianceRule {
        DEFAULT,
        WORLD_ID_REQUIRED
    }

    mapping(address => uint256) public creSchemeIds;
    mapping(address => ComplianceRule) public stealthRules; // Bob's Rules

    // Vault Accounting
    mapping(address => mapping(address => uint256)) public vaultBalances; // user -> token -> balance
    mapping(address => uint256) public vaultNonces; // For Alice's signatures

    event Deposited(
        address indexed user,
        address indexed token,
        uint256 amount
    );
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        bytes ephemeralPubKey,
        bytes metadata
    );

    error OnlyForwarder();
    error OnlyOwner();

    constructor(address _forwarder, address _registry, address _owner) {
        if (_forwarder == address(0)) revert OnlyForwarder();
        forwarder = _forwarder;
        registry = _registry;
        owner = _owner;
    }

    // 🌟 1. ALICE DEPOSITS FUNDS NATIVELY
    function deposit(address token, uint256 amount) external {
        bool success = IERC20(token).transferFrom(
            msg.sender,
            address(this),
            amount
        );
        require(success, "Deposit failed");
        vaultBalances[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    function onReport(
        bytes calldata /* metadata */,
        bytes calldata report
    ) external override {
        if (msg.sender != forwarder) revert OnlyForwarder();

        (ActionType action, bytes memory payload) = abi.decode(
            report,
            (ActionType, bytes)
        );

        if (action == ActionType.REGISTER) {
            _handleRegistration(payload);
        } else if (action == ActionType.P2P_DISPATCH) {
            _handleP2PDispatch(payload);
        }
    }

    // 🌟 2. BOB REGISTERS HIS KEYS & COMPLIANCE RULE
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
        stealthRules[registrant] = rule; // Save Bob's rule!

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

    // 🌟 3. DON EXECUTIONS THE PRIVATE TRANSFER
    function _handleP2PDispatch(bytes memory payload) internal {
        (
            address token,
            uint256 amount,
            address sender,
            address recipient,
            address stealthAddress,
            bytes memory pubKey,
            uint8 v,
            bytes32 r,
            bytes32 s
        ) = abi.decode(
                payload,
                (
                    address,
                    uint256,
                    address,
                    address,
                    address,
                    bytes,
                    uint8,
                    bytes32,
                    bytes32
                )
            );

        // A. Verify Alice has the funds in the Vault
        require(
            vaultBalances[sender][token] >= amount,
            "Insufficient vault balance"
        );

        // B. Verify Alice's Custom Vault Signature (Bug-proof because we control the hash!)
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                sender,
                stealthAddress,
                amount,
                vaultNonces[sender]
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        address recovered = ecrecover(ethSignedMessageHash, v, r, s);
        require(recovered == sender, "Invalid authorization signature");

        vaultNonces[sender]++; // Prevent replay attacks
        vaultBalances[sender][token] -= amount; // Deduct funds

        // C. Push tokens to Bob's Stealth Address
        bool success = IERC20(token).transfer(stealthAddress, amount);
        require(success, "P2P Transfer failed");

        emit Announcement(creSchemeIds[recipient], stealthAddress, pubKey, "");
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    function bobSetup(address registrant, uint256 schemeId, ComplianceRule rule) external {
        if (msg.sender != owner) revert OnlyOwner();
        stealthRules[registrant] = rule;
        creSchemeIds[registrant] = schemeId;
    }
}
