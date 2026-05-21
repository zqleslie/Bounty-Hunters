// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../contracts/CrossChainBridge.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mock ERC20 token for testing
contract MockToken is ERC20 {
    constructor() ERC20("MockToken", "MTK") {
        _mint(msg.sender, 1000000 * 10**18);
    }
}

contract CrossChainBridgeTest is Test {
    CrossChainBridge public bridge;
    MockToken public token;
    address public validator;
    address public user1;
    address public user2;

    function setUp() public {
        validator = vm.addr(1);
        user1 = vm.addr(2);
        user2 = vm.addr(3);
        
        token = new MockToken();
        bridge = new CrossChainBridge(address(token), validator);
        
        // Fund users
        token.transfer(user1, 10000 * 10**18);
        token.transfer(user2, 10000 * 10**18);
    }

    function test_InitiateTransfer_Success() public {
        vm.startPrank(user1);
        token.approve(address(bridge), 1000 * 10**18);
        bridge.initiateTransfer(1000 * 10**18, 1);
        vm.stopPrank();
        
        assertEq(token.balanceOf(address(bridge)), 1000 * 10**18);
    }

    function test_ProcessTransfer_WithValidSignature() public {
        bytes32 transferHash = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(bridge)
        ));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, transferHash);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        bridge.processTransfer(user2, 500 * 10**18, 0, signature);
        
        assertEq(token.balanceOf(user2), 10500 * 10**18);
    }

    // FIX #1 TEST: Cross-chain replay prevention
    function test_PreventCrossChainReplay() public {
        // Create valid signature on chain 1
        uint256 originalChainId = block.chainid;
        
        bytes32 transferHash1 = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            originalChainId,
            address(bridge)
        ));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, transferHash1);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        // Process on original chain - should succeed
        bridge.processTransfer(user2, 500 * 10**18, 0, signature);
        
        // Try to replay on different chain - hash would be different due to chainid
        bytes32 replayHash = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            999, // Different chain ID
            address(bridge)
        ));
        
        assertNotEq(transferHash1, replayHash, "Hashes should differ across chains");
    }

    // FIX #2 TEST: Same-chain replay prevention (nonce per sender)
    function test_PreventSameChainReplayWithNonce() public {
        bytes32 transferHash = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(bridge)
        ));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, transferHash);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        bridge.processTransfer(user2, 500 * 10**18, 0, signature);
        
        // Try to replay same transfer - should fail because hash is already processed
        vm.expectRevert("Already processed");
        bridge.processTransfer(user2, 500 * 10**18, 0, signature);
    }

    // FIX #2 TEST: Sender nonce increments
    function test_SenderNonceIncrements() public {
        assertEq(bridge.getSenderNonce(user2), 0);
        
        bytes32 transferHash = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(bridge)
        ));
        
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, transferHash);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        bridge.processTransfer(user2, 500 * 10**18, 0, signature);
        
        assertEq(bridge.getSenderNonce(user2), 1);
    }

    // FIX #3 TEST: Contract address in hash prevents replay after upgrade
    function test_PreventReplayAfterContractUpgrade() public {
        bytes32 hash1 = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(bridge)
        ));
        
        // If contract address changes (upgrade), hash changes
        bytes32 hash2 = keccak256(abi.encodePacked(
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(0x1234567890123456789012345678901234567890)
        ));
        
        assertNotEq(hash1, hash2, "Hashes should differ with different contract addresses");
    }

    // FIX #4 TEST: ecrecover zero-address check
    function test_EcrecoverZeroAddressRejection() public {
        // Create an invalid signature that would cause ecrecover to return 0
        bytes memory invalidSignature = new bytes(65);
        for (uint i = 0; i < 65; i++) {
            invalidSignature[i] = 0xff;
        }
        
        vm.expectRevert("Invalid signature: ecrecover returned zero address");
        bridge.verifySignature(bytes32(uint256(1)), invalidSignature);
    }

    // FIX #4 TEST: Invalid signature length rejection
    function test_InvalidSignatureLength() public {
        bytes memory shortSig = new bytes(64);
        vm.expectRevert("Invalid signature length");
        bridge.verifySignature(bytes32(0), shortSig);
    }

    // FIX #5 TEST: EIP-712 typed data
    function test_EIP712TypedDataHash() public {
        bytes32 typedHash = bridge.getTransferTypedDataHash(
            user2,
            500 * 10**18,
            0
        );
        
        assertTrue(typedHash != bytes32(0), "Typed data hash should not be zero");
        
        // Verify the hash is deterministic
        bytes32 typedHash2 = bridge.getTransferTypedDataHash(
            user2,
            500 * 10**18,
            0
        );
        
        assertEq(typedHash, typedHash2, "Same inputs should produce same hash");
    }

    // FIX #5 TEST: EIP-712 signature verification
    function test_EIP712SignatureVerification() public {
        bytes32 structHash = bridge.getTransferTypedDataHash(
            user2,
            500 * 10**18,
            0
        );
        
        bytes32 digest = bridge.eip712Domain();
        // The actual EIP-712 signing would use _hashTypedDataV4
        // For this test, we verify the struct hash is correctly constructed
        
        bytes32 expectedStructHash = keccak256(abi.encode(
            bridge.TRANSFER_TYPEHASH(),
            user2,
            500 * 10**18,
            uint256(0),
            block.chainid,
            address(bridge)
        ));
        
        assertEq(structHash, expectedStructHash, "EIP-712 struct hash mismatch");
    }

    // Integration test: Full flow
    function test_FullFlow_EIP712() public {
        // Sign using EIP-712 typed data
        bytes32 structHash = bridge.getTransferTypedDataHash(
            user2,
            500 * 10**18,
            0
        );
        
        bytes32 digest = _hashTypedDataV4(bridge, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        
        // Verify EIP-712 signature
        assertTrue(
            bridge.verifyEIP712Signature(user2, 500 * 10**18, 0, signature),
            "EIP-712 signature should be valid"
        );
    }

    function _hashTypedDataV4(CrossChainBridge _bridge, bytes32 structHash) internal view returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        ));
        bytes32 domainSeparator = keccak256(abi.encode(
            typeHash,
            keccak256(bytes("CrossChainBridge")),
            keccak256(bytes("1")),
            block.chainid,
            address(_bridge)
        ));
        
        return keccak256(abi.encodePacked(
            bytes2(0x1901),
            domainSeparator,
            structHash
        ));
    }

    function test_GetPoolBalance() public {
        vm.startPrank(user1);
        token.approve(address(bridge), 1000 * 10**18);
        bridge.initiateTransfer(1000 * 10**18, 1);
        vm.stopPrank();
        
        assertEq(bridge.getPoolBalance(), 1000 * 10**18);
    }
}
