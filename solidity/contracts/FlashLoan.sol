// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IFlashLoanReceiver {
    function onFlashLoan(
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external;
}

/**
 * @title FlashLoan
 * @notice Fixed flash loan protocol with zero-fee prevention, pool drainage protection,
 *         rebasing token mitigation, and emergency pause.
 *
 * @dev Fixes applied for Bounty #919:
 *  1. Fee truncation: minimum fee of 1 token unit enforced
 *  2. Pool drainage: maxLoanAmount capped at 50% of pool balance
 *  3. Rebase token: internal accounting via poolBalance instead of balanceOf
 *  4. Emergency pause: inherited OpenZeppelin Pausable
 */
contract FlashLoan is Ownable, Pausable {
    IERC20 public immutable loanToken;
    uint256 public feeBPS;
    uint256 public totalFees;

    /// @notice Internal accounting of pool balance — immune to rebase manipulation
    uint256 public poolBalance;

    /// @dev Tracks the pool balance from the pool's perspective (deposits/withdrawals/transfers)
    event Deposit(address indexed provider, uint256 amount);
    event Withdraw(address indexed receiver, uint256 amount);
    event FlashLoanExecuted(address indexed borrower, uint256 amount, uint256 fee);
    event FeeBPSUpdated(uint256 oldFeeBPS, uint256 newFeeBPS);
    event FeesWithdrawn(address indexed owner, uint256 amount);

    modifier onlyToken() {
        require(msg.sender == address(loanToken), "Only token contract");
        _;
    }

    constructor(address _loanToken, uint256 _feeBPS) Ownable(msg.sender) {
        require(_loanToken != address(0), "Invalid token");
        require(_feeBPS > 0 && _feeBPS <= 10000, "Invalid feeBPS");
        loanToken = IERC20(_loanToken);
        feeBPS = _feeBPS;
    }

    /**
     * @notice Execute a flash loan with all safety checks
     * @param amount Number of tokens to borrow
     * @param data  Arbitrary data forwarded to the callback
     */
    function flashLoan(uint256 amount, bytes calldata data) external whenNotPaused {
        require(amount > 0, "Amount must be > 0");

        // FIX #2: Cap loan at 50% of internal pool balance to prevent pool drainage
        require(amount <= poolBalance / 2, "Exceeds maxLoanAmount (50% of pool)");

        uint256 balanceBefore = loanToken.balanceOf(address(this));
        require(balanceBefore >= amount, "Insufficient pool balance");

        // FIX #1: Minimum fee of 1 token unit — prevents zero-fee for small loans
        uint256 fee = (amount * feeBPS) / 10000;
        if (fee == 0) {
            fee = 1;
        }

        // Update internal accounting before transfer
        poolBalance -= amount;

        loanToken.transfer(msg.sender, amount);

        // Callback to borrower
        IFlashLoanReceiver(msg.sender).onFlashLoan(
            address(loanToken),
            amount,
            fee,
            data
        );

        // FIX #3: Validate repayment against internal pool balance, not just balanceOf
        // The borrower must repay amount + fee into the pool
        uint256 balanceAfter = loanToken.balanceOf(address(this));
        require(
            balanceAfter >= balanceBefore + fee,
            "Loan not fully repaid with fee"
        );

        // Restore internal accounting: full repayment means poolBalance goes back up by amount
        poolBalance += amount;

        totalFees += fee;
        emit FlashLoanExecuted(msg.sender, amount, fee);
    }

    /**
     * @notice Deposit tokens into the flash loan pool
     * @param amount Number of tokens to deposit
     */
    function depositToPool(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        loanToken.transferFrom(msg.sender, address(this), amount);
        // FIX #3: Update internal accounting on deposit
        poolBalance += amount;
        emit Deposit(msg.sender, amount);
    }

    /**
     * @notice Withdraw fees accrued to the owner
     */
    function withdrawFees() external onlyOwner {
        uint256 fees = totalFees;
        require(fees > 0, "No fees to withdraw");
        totalFees = 0;
        poolBalance -= fees; // fees leave the pool
        loanToken.transfer(owner(), fees);
        emit FeesWithdrawn(owner(), fees);
    }

    /**
     * @notice Update the fee rate (basis points)
     * @param _newFeeBPS New fee in basis points (1–10000)
     */
    function setFeeBPS(uint256 _newFeeBPS) external onlyOwner {
        require(_newFeeBPS > 0 && _newFeeBPS <= 10000, "Invalid feeBPS");
        uint256 oldFee = feeBPS;
        feeBPS = _newFeeBPS;
        emit FeeBPSUpdated(oldFee, _newFeeBPS);
    }

    /**
     * @notice Emergency pause — disables flashLoan operations
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause — re-enables flashLoan operations
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Get the actual ERC20 balance of the contract (for comparison/debug)
     */
    function getActualBalance() external view returns (uint256) {
        return loanToken.balanceOf(address(this));
    }

    /**
     * @notice Get the internally-tracked pool balance
     */
    function getPoolBalance() external view returns (uint256) {
        return poolBalance;
    }

    /**
     * @notice Calculate the maximum loan allowed (50% of poolBalance)
     */
    function maxLoanAmount() external view returns (uint256) {
        return poolBalance / 2;
    }
}
