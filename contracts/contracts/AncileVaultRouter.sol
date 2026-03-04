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
        P2P_DISPATCH,
        SWEEP,
        SWAP
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

    // Allow the Vault to receive ETH liquidity for Swaps
    receive() external payable {}

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

        if (action == ActionType.REGISTER) _handleRegistration(payload);
        else if (action == ActionType.P2P_DISPATCH) _handleP2PDispatch(payload);
        else if (action == ActionType.SWEEP) _handleStealthSweep(payload);
        else if (action == ActionType.SWAP) _handleStealthSwap(payload);
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

        vaultBalances[stealthAddress][token] += amount;

        // C. Push tokens to Bob's Stealth Address
        bool success = IERC20(token).transfer(stealthAddress, amount);
        require(success, "P2P Transfer failed");

        emit Announcement(creSchemeIds[recipient], stealthAddress, pubKey, "");
    }

    function _handleStealthSweep(bytes memory payload) internal {
        (
            address token, uint256 amount, address stealthAddress, address destination, 
            uint8 v, bytes32 r, bytes32 s
        ) = abi.decode(payload, (address, uint256, address, address, uint8, bytes32, bytes32));
        
        // A. Verify stealth address has funds
        require(vaultBalances[stealthAddress][token] >= amount, "Insufficient stealth balance");

        // B. Verify the signature came from the mathematically derived Stealth Private Key
        bytes32 messageHash = keccak256(abi.encodePacked(stealthAddress, destination, amount, vaultNonces[stealthAddress]));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address recovered = ecrecover(ethSignedMessageHash, v, r, s);
        require(recovered == stealthAddress, "Invalid sweep signature");
        
        // C. Push actual tokens to Binance/Cold Wallet
        vaultNonces[stealthAddress]++;
        vaultBalances[stealthAddress][token] -= amount;

        bool success = IERC20(token).transfer(destination, amount);
        require(success, "Sweep Transfer failed");
    }

    // 🌟 THE NEW SWAP FUNCTION (Bob trades stealth USDC for native ETH)
    function _handleStealthSwap(bytes memory payload) internal {
        (
            address tokenIn,
            uint256 amountIn,
            address stealthAddress,
            uint256 ethOutputAmount,
            uint8 v,
            bytes32 r,
            bytes32 s
        ) = abi.decode(
                payload,
                (address, uint256, address, uint256, uint8, bytes32, bytes32)
            );

        // A. Verify the stealth address has the USDC in the Vault
        require(
            vaultBalances[stealthAddress][tokenIn] >= amountIn,
            "Insufficient stealth balance"
        );
        require(
            address(this).balance >= ethOutputAmount,
            "Vault lacks ETH liquidity"
        );

        // B. Verify Bob's signature using the derived Stealth Private Key
        // Hash: stealthAddress + tokenIn + amountIn + nonce
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                stealthAddress,
                tokenIn,
                amountIn,
                vaultNonces[stealthAddress]
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        address recovered = ecrecover(ethSignedMessageHash, v, r, s);
        require(recovered == stealthAddress, "Invalid swap signature");

        // C. Execute the Swap!
        vaultNonces[stealthAddress]++;

        // The Vault absorbs the USDC into its own protocol treasury
        vaultBalances[stealthAddress][tokenIn] -= amountIn;
        vaultBalances[address(this)][tokenIn] += amountIn;

        // The Vault sends native ETH directly to Bob's Stealth Address
        (bool success, ) = stealthAddress.call{value: ethOutputAmount}("");
        require(success, "ETH Transfer failed");
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
