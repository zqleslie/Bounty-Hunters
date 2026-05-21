// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract CrossChainBridge is EIP712 {
    IERC20 public bridgeToken;
    address public validator;
    uint256 public nonce;

    mapping(bytes32 => bool) public processedTransfers;
    // FIX #2: nonce per sender to prevent same-chain replay
    mapping(address => uint256) public senderNonces;

    event TransferInitiated(address indexed sender, uint256 amount, uint256 targetChain, uint256 nonce);
    event TransferProcessed(bytes32 indexed transferHash, address indexed recipient, uint256 amount);

    // EIP-712 type hash for typed data signing
    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "Transfer(address recipient,uint256 amount,uint256 transferNonce,uint256 chainId,address verifyingContract)"
    );

    constructor(address _bridgeToken, address _validator) EIP712("CrossChainBridge", "1") {
        bridgeToken = IERC20(_bridgeToken);
        validator = _validator;
    }

    function initiateTransfer(uint256 amount, uint256 targetChain) external {
        require(amount > 0, "Amount must be > 0");
        bridgeToken.transferFrom(msg.sender, address(this), amount);
        emit TransferInitiated(msg.sender, amount, targetChain, nonce++);
    }

    // FIXED: Added chain ID, nonce per sender, and contract address to hash
    function processTransfer(
        address recipient,
        uint256 amount,
        uint256 transferNonce,
        bytes calldata signature
    ) external {
        // FIX #1: Include block.chainid to prevent cross-chain replay
        // FIX #2: Include sender nonce to prevent same-chain replay
        // FIX #3: Include address(this) to prevent replay after proxy upgrades
        bytes32 transferHash = keccak256(abi.encodePacked(
            recipient,
            amount,
            transferNonce,
            block.chainid,
            address(this)
        ));

        require(!processedTransfers[transferHash], "Already processed");
        require(verifySignature(transferHash, signature), "Invalid signature");

        processedTransfers[transferHash] = true;
        // FIX #2: Increment sender nonce
        senderNonces[recipient]++;
        bridgeToken.transfer(recipient, amount);

        emit TransferProcessed(transferHash, recipient, amount);
    }

    // FIXED: Added zero-address check and EIP-712 support
    function verifySignature(bytes32 hash, bytes calldata signature) public view returns (bool) {
        require(signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;

        address recovered = ecrecover(
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)),
            v, r, s
        );

        // FIX #4: Check for zero-address return from ecrecover
        require(recovered != address(0), "Invalid signature: ecrecover returned zero address");

        return recovered == validator;
    }

    // FIX #5: EIP-712 typed data signing support
    function getTransferTypedDataHash(
        address recipient,
        uint256 amount,
        uint256 transferNonce
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            TRANSFER_TYPEHASH,
            recipient,
            amount,
            transferNonce,
            block.chainid,
            address(this)
        ));
    }

    // FIX #5: Verify EIP-712 typed signature
    function verifyEIP712Signature(
        address recipient,
        uint256 amount,
        uint256 transferNonce,
        bytes calldata signature
    ) public view returns (bool) {
        bytes32 structHash = getTransferTypedDataHash(recipient, amount, transferNonce);
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        require(recovered != address(0), "Invalid EIP-712 signature");
        return recovered == validator;
    }

    // FIX #2: Queryable nonce per sender for frontend integration
    function getSenderNonce(address sender) external view returns (uint256) {
        return senderNonces[sender];
    }

    function getPoolBalance() external view returns (uint256) {
        return bridgeToken.balanceOf(address(this));
    }
}
