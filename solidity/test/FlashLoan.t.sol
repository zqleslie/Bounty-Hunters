// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../FlashLoan.sol";

/**
 * @title MockERC20
 * @notice Minimal ERC20 mock for testing
 */
contract MockERC20 is IERC20 {
    string public name = "Mock Token";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_balances[msg.sender] >= amount, "Insufficient balance");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(_allowances[from][msg.sender] >= amount, "Insufficient allowance");
        require(_balances[from] >= amount, "Insufficient balance");
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner_, address spender) external view returns (uint256) {
        return _allowances[owner_][spender];
    }
}

/**
 * @title RebaseToken
 * @notice Mock rebase token that inflates all balances by a multiplier
 */
contract RebaseToken is IERC20 {
    string public name = "Rebase Token";
    string public symbol = "RBT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) private _rawBalances;
    mapping(address => mapping(address => uint256)) private _allowances;

    /// @notice 1000 = 1x multiplier, 2000 = 2x, etc. (basis points)
    uint256 public rebaseMultiplierBPS = 1000;

    function mint(address to, uint256 amount) external {
        _rawBalances[to] += amount;
        totalSupply += amount;
    }

    function setRebaseMultiplier(uint256 _multiplier) external {
        rebaseMultiplierBPS = _multiplier;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_adjusted(msg.sender) >= amount, "Insufficient balance");
        _rawBalances[msg.sender] -= amount;
        _rawBalances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(_allowances[from][msg.sender] >= amount, "Insufficient allowance");
        require(_adjusted(from) >= amount, "Insufficient balance");
        _allowances[from][msg.sender] -= amount;
        _rawBalances[from] -= amount;
        _rawBalances[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _adjusted(address account) internal view returns (uint256) {
        return (_rawBalances[account] * rebaseMultiplierBPS) / 1000;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _adjusted(account);
    }
}

/**
 * @title FlashLoanReceiver
 * @notice Receiver contract that repays loan + fee from its own balance.
 *         Can be configured to NOT repay (for negative testing).
 */
contract FlashLoanReceiver is IFlashLoanReceiver {
    IERC20 public token;
    FlashLoan public flashLoan;
    bool public shouldRepay = true;
    address public expectedCaller;

    constructor(FlashLoan _flashLoan, IERC20 _token) {
        flashLoan = _flashLoan;
        token = _token;
        expectedCaller = msg.sender;
    }

    function setRepay(bool _repay) external {
        shouldRepay = _repay;
    }

    function onFlashLoan(
        address _token,
        uint256 amount,
        uint256 fee,
        bytes calldata /* data */
    ) external override {
        require(msg.sender == address(flashLoan), "Unauthorized callback");

        if (shouldRepay) {
            // Repay the loan + fee back to the pool
            token.transfer(address(flashLoan), amount + fee);
        }
        // If shouldRepay is false, intentionally don't repay
    }
}

/**
 * @title FlashLoanTest
 * @notice Comprehensive test suite for Bounty #919 fixes
 *
 * All flashLoan calls go through FlashLoanReceiver so the callback
 * properly handles repayment.
 */
contract FlashLoanTest is Test {
    FlashLoan public flashLoan;
    MockERC20 public token;
    FlashLoanReceiver public receiver;

    address public owner;
    address public borrower;
    address public liquidityProvider;

    uint256 public constant FEE_BPS = 30; // 0.30%
    uint256 public constant POOL_INITIAL = 1_000_000 * 1e18;

    function setUp() public {
        owner = address(this);
        borrower = makeAddr("borrower");
        liquidityProvider = makeAddr("lp");

        token = new MockERC20();
        flashLoan = new FlashLoan(address(token), FEE_BPS);
        receiver = new FlashLoanReceiver(flashLoan, token);

        // Fund liquidity provider and deposit to pool
        token.mint(liquidityProvider, POOL_INITIAL);
        vm.prank(liquidityProvider);
        token.approve(address(flashLoan), POOL_INITIAL);
        flashLoan.depositToPool(POOL_INITIAL);

        // Fund receiver for fees (it needs tokens to pay the fee)
        token.mint(address(receiver), 100_000 * 1e18);

        // Verify setup
        assertEq(flashLoan.getPoolBalance(), POOL_INITIAL);
        assertEq(token.balanceOf(address(flashLoan)), POOL_INITIAL);
    }

    // ========================================
    // FIX #1: Zero-fee prevention (min fee = 1)
    // ========================================

    function test_FeeTruncation_SmallLoan_MinFee1() public {
        // loanAmount = 100, feeBPS = 30
        // fee = 100 * 30 / 10000 = 0 (truncates)
        // Fix: minimum fee = 1
        uint256 smallAmount = 100;

        uint256 receiverBalBefore = token.balanceOf(address(receiver));
        uint256 poolBalBefore = token.balanceOf(address(flashLoan));

        flashLoan.flashLoan(smallAmount, "");

        uint256 receiverBalAfter = token.balanceOf(address(receiver));
        uint256 poolBalAfter = token.balanceOf(address(flashLoan));

        // Receiver paid amount + fee = 100 + 1 = 101
        assertEq(receiverBalBefore - receiverBalAfter, smallAmount + 1);
        // Pool gained 1 fee token
        assertEq(poolBalAfter, poolBalBefore + 1);
        assertEq(flashLoan.totalFees(), 1);
    }

    function test_FeeTruncation_VerySmallAmount() public {
        // Even with amount = 1, fee should be 1
        uint256 tinyAmount = 1;
        flashLoan.flashLoan(tinyAmount, "");
        assertEq(flashLoan.totalFees(), 1);
    }

    function test_FeeCalculation_NormalLoan() public {
        // fee = 10000 * 30 / 10000 = 30 (no truncation)
        uint256 loanAmount = 10_000 * 1e18;
        uint256 expectedFee = (loanAmount * FEE_BPS) / 10000;
        assertGe(expectedFee, 1, "fee should not truncate for large loan");

        uint256 receiverBalBefore = token.balanceOf(address(receiver));
        flashLoan.flashLoan(loanAmount, "");
        uint256 receiverBalAfter = token.balanceOf(address(receiver));

        assertEq(receiverBalBefore - receiverBalAfter, loanAmount + expectedFee);
        assertEq(flashLoan.totalFees(), expectedFee);
    }

    function test_Revert_ZeroAmount() public {
        vm.expectRevert("Amount must be > 0");
        flashLoan.flashLoan(0, "");
    }

    // ========================================
    // FIX #2: Max loan amount (50% of pool)
    // ========================================

    function test_MaxLoanAmount_Exact50Percent() public {
        uint256 maxAllowed = flashLoan.maxLoanAmount();
        assertEq(maxAllowed, POOL_INITIAL / 2);

        // Should succeed at exactly 50%
        flashLoan.flashLoan(maxAllowed, "");
    }

    function test_Revert_Exceeds50Percent() public {
        uint256 tooMuch = (POOL_INITIAL / 2) + 1;
        vm.expectRevert("Exceeds maxLoanAmount (50% of pool)");
        flashLoan.flashLoan(tooMuch, "");
    }

    function test_MaxLoanAmount_View() public {
        assertEq(flashLoan.maxLoanAmount(), POOL_INITIAL / 2);
    }

    // ========================================
    // FIX #3: Rebase token protection
    // ========================================

    function test_RebaseToken_InternalAccountingUnaffected() public {
        RebaseToken rebaseToken = new RebaseToken();
        FlashLoan rebaseFlashLoan = new FlashLoan(address(rebaseToken), FEE_BPS);

        // Deposit
        rebaseToken.mint(liquidityProvider, POOL_INITIAL);
        vm.prank(liquidityProvider);
        rebaseToken.approve(address(rebaseFlashLoan), POOL_INITIAL);
        rebaseFlashLoan.depositToPool(POOL_INITIAL);

        // poolBalance tracks raw deposit
        assertEq(rebaseFlashLoan.getPoolBalance(), POOL_INITIAL);

        // Inflate the rebase (2x)
        rebaseToken.setRebaseMultiplier(2000);

        // balanceOf shows 2x, but poolBalance is unchanged
        assertEq(rebaseToken.balanceOf(address(rebaseFlashLoan)), POOL_INITIAL * 2);
        assertEq(rebaseFlashLoan.getPoolBalance(), POOL_INITIAL);

        // maxLoanAmount is based on poolBalance (raw), not inflated balanceOf
        uint256 maxLoan = rebaseFlashLoan.maxLoanAmount();
        assertEq(maxLoan, POOL_INITIAL / 2);

        // Create receiver for rebase token
        FlashLoanReceiver rebaseReceiver = new FlashLoanReceiver(rebaseFlashLoan, rebaseToken);
        rebaseToken.mint(address(rebaseReceiver), 100_000 * 1e18);

        // Execute loan
        uint256 fee = (maxLoan * FEE_BPS) / 10000;
        // We need to call through the rebaseReceiver
        vm.prank(address(rebaseReceiver));
        // Actually, receiver calls itself. Let's just call directly:
        rebaseFlashLoan.flashLoan(maxLoan, "");

        assertEq(rebaseFlashLoan.totalFees(), fee);
        // poolBalance restored
        assertEq(rebaseFlashLoan.getPoolBalance(), POOL_INITIAL);
    }

    function test_RepayValidation_InsufficientRepayment() public {
        // Create a receiver that does NOT repay
        FlashLoanReceiver maliciousReceiver = new FlashLoanReceiver(flashLoan, token);
        maliciousReceiver.setRepay(false);

        uint256 loanAmount = 1_000 * 1e18;

        // Call through the malicious receiver — it won't repay
        vm.prank(address(maliciousReceiver));
        vm.expectRevert("Loan not fully repaid with fee");
        flashLoan.flashLoan(loanAmount, "");
    }

    // ========================================
    // FIX #4: Emergency pause
    // ========================================

    function test_Pause_DisablesFlashLoan() public {
        flashLoan.pause();
        vm.expectRevert();
        flashLoan.flashLoan(1_000, "");
    }

    function test_Unpause_ReEnablesFlashLoan() public {
        flashLoan.pause();
        flashLoan.unpause();

        uint256 loanAmount = 1_000 * 1e18;
        flashLoan.flashLoan(loanAmount, "");
        // Should succeed
    }

    function test_Revert_NonOwnerPause() public {
        vm.prank(borrower);
        vm.expectRevert();
        flashLoan.pause();
    }

    function test_Revert_NonOwnerUnpause() public {
        flashLoan.pause();
        vm.prank(borrower);
        vm.expectRevert();
        flashLoan.unpause();
    }

    // ========================================
    // Fee accrual, withdrawal, settings
    // ========================================

    function test_FeeAccrual_MultipleLoans() public {
        uint256 loanAmount = 10_000 * 1e18;
        uint256 expectedFee = (loanAmount * FEE_BPS) / 10000;

        // First loan
        flashLoan.flashLoan(loanAmount, "");
        assertEq(flashLoan.totalFees(), expectedFee);

        // Second loan
        flashLoan.flashLoan(loanAmount, "");
        assertEq(flashLoan.totalFees(), expectedFee * 2);
    }

    function test_WithdrawFees_OwnerOnly() public {
        uint256 loanAmount = 10_000 * 1e18;
        uint256 fee = (loanAmount * FEE_BPS) / 10000;
        flashLoan.flashLoan(loanAmount, "");

        uint256 ownerBalBefore = token.balanceOf(owner);
        uint256 poolBalBefore = token.balanceOf(address(flashLoan));
        uint256 poolBalanceBefore = flashLoan.getPoolBalance();

        flashLoan.withdrawFees();

        assertEq(token.balanceOf(owner), ownerBalBefore + fee);
        assertEq(flashLoan.totalFees(), 0);
        assertEq(flashLoan.getPoolBalance(), poolBalanceBefore - fee);
    }

    function test_Revert_WithdrawFees_NoFees() public {
        vm.expectRevert("No fees to withdraw");
        flashLoan.withdrawFees();
    }

    function test_SetFeeBPS() public {
        assertEq(flashLoan.feeBPS(), FEE_BPS);
        flashLoan.setFeeBPS(50);
        assertEq(flashLoan.feeBPS(), 50);
    }

    function test_Revert_SetFeeBPS_NonOwner() public {
        vm.prank(borrower);
        vm.expectRevert();
        flashLoan.setFeeBPS(50);
    }

    function test_Revert_SetFeeBPS_Zero() public {
        vm.expectRevert("Invalid feeBPS");
        flashLoan.setFeeBPS(0);
    }

    function test_Revert_SetFeeBPS_TooHigh() public {
        vm.expectRevert("Invalid feeBPS");
        flashLoan.setFeeBPS(10001);
    }

    function test_DepositIncreasesPoolBalance() public {
        uint256 depositAmount = 50_000 * 1e18;
        token.mint(liquidityProvider, depositAmount);
        vm.prank(liquidityProvider);
        token.approve(address(flashLoan), depositAmount);

        uint256 poolBefore = flashLoan.getPoolBalance();
        flashLoan.depositToPool(depositAmount);
        uint256 poolAfter = flashLoan.getPoolBalance();

        assertEq(poolAfter, poolBefore + depositAmount);
    }

    function test_maxLoanAmount_RestoredAfterRepayment() public {
        uint256 maxBefore = flashLoan.maxLoanAmount();
        assertEq(maxBefore, POOL_INITIAL / 2);

        // Execute and repay a loan
        uint256 loanAmount = POOL_INITIAL / 4;
        flashLoan.flashLoan(loanAmount, "");

        uint256 maxAfter = flashLoan.maxLoanAmount();
        assertEq(maxAfter, POOL_INITIAL / 2); // restored after repayment
    }

    function test_EventEmitted_FlashLoanExecuted() public {
        uint256 loanAmount = 1_000 * 1e18;
        uint256 fee = (loanAmount * FEE_BPS) / 10000;

        vm.expectEmit(true, false, false, true);
        emit FlashLoanExecuted(address(receiver), loanAmount, fee);
        flashLoan.flashLoan(loanAmount, "");
    }

    function test_EventEmitted_FeeBPSUpdated() public {
        vm.expectEmit(false, false, false, true);
        emit FeeBPSUpdated(FEE_BPS, 50);
        flashLoan.setFeeBPS(50);
    }

    function test_EventEmitted_Deposit() public {
        uint256 depositAmount = 10_000 * 1e18;
        token.mint(liquidityProvider, depositAmount);
        vm.prank(liquidityProvider);
        token.approve(address(flashLoan), depositAmount);

        vm.expectEmit(true, false, false, true);
        emit Deposit(liquidityProvider, depositAmount);
        flashLoan.depositToPool(depositAmount);
    }

    function test_getActualBalance() public {
        assertEq(flashLoan.getActualBalance(), POOL_INITIAL);
    }

    function test_Constructor_RevertsOnZeroToken() public {
        vm.expectRevert("Invalid token");
        new FlashLoan(address(0), FEE_BPS);
    }

    function test_Constructor_RevertsOnZeroFee() public {
        vm.expectRevert("Invalid feeBPS");
        new FlashLoan(address(token), 0);
    }

    function test_PoolBalance_DepositThenLoan() public {
        uint256 loanAmount = 10_000 * 1e18;
        flashLoan.flashLoan(loanAmount, "");
        // After full repayment, poolBalance unchanged
        assertEq(flashLoan.getPoolBalance(), POOL_INITIAL);
    }
}
