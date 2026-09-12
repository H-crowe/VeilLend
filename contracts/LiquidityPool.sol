// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LiquidityPool
 * @notice MVP liquidity vault for ONE debt asset of VeilLend. One pool per
 * debt asset — pools are fully independent and never share accounting.
 * UUPS-upgradeable so lender funds and shares never get stranded in an old
 * implementation if a bug needs fixing; upgrades are owner-authorized only.
 *
 * Lenders deposit the pool's single asset and receive ERC4626-style shares
 * representing a proportional claim on pool assets. VeilLend (the wired
 * `lend` contract) is the ONLY account that can pull liquidity out for
 * borrows or push repayments back in; all other accounting (positions,
 * commitments, LTV, liquidations) stays in VeilLend.
 *
 * MVP accounting model:
 *   totalAssets  = idle token balance (availableLiquidity) + totalBorrows
 *   totalBorrows = principal pulled by VeilLend and not yet returned
 *   Interest is implicitly repaid on top of principal, so it stays in the
 *   pool as idle balance and raises totalAssets — lenders' share value
 *   appreciates without any separate interest index.
 * Direct token transfers to the pool are NOT part of accounting (they only
 * raise the idle balance and thus dilute nothing, but they earn no shares
 * claim beyond the existing share price — do not rely on them).
 *
 * Upgrade safety: the contract holds NO owner custody path — there is no
 * function anywhere that lets the owner (or an upgraded implementation)
 * drain depositor assets or shares. Upgrades only swap implementation code;
 * depositor balances, shares and `totalBorrows` live in the proxy's storage
 * and are preserved across upgrades. New state in future versions must be
 * appended AFTER `totalBorrows` (append-only layout).
 */
contract LiquidityPool is
    Initializable,
    ERC4626Upgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Errors / events
    // ------------------------------------------------------------------

    error OnlyLend();
    error ZeroAddress();
    error InsufficientPoolLiquidity();
    error InvalidLend();
    error InvalidParameter();
    error NothingToClaim();

    event LendSet(address indexed lend);
    event LiquidityPulled(address indexed to, uint256 amount);
    event RepaymentReceived(uint256 principalRepaid, uint256 interestPaid);
    event BorrowsWrittenOff(uint256 amount);
    event PoolConfigured(uint256 rateBps, uint256 feeBps, address indexed feeRecipient);
    event InterestAccrued(uint256 projectedInterest, uint64 lastAccrual);
    event FeesClaimed(address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // State (append-only: new variables go BELOW this line, never between)
    // ------------------------------------------------------------------

    /// @notice The VeilLend contract authorized to pull liquidity and push
    /// repayments. Set in `initialize` or via owner `setLend`.
    address public lend;

    /// @notice Principal outstanding against VeilLend (pulled for borrows,
    /// reduced by repayments). Interest is NOT tracked here — it accrues
    /// implicitly as excess idle balance.
    uint256 public totalBorrows;

    // ---- pool economics (append-only below this line) ----

    /// @notice Annual borrower interest rate, in bps. Kept in sync by the
    /// wired VeilLend contract (`updateRateBps`) with the borrower accrual
    /// rate actually used by the debt index (`rateConfigs[asset].baseRateBps`
    /// — public configuration, never private position state), so the pool's
    /// projections reflect the real economic borrower rate. Realized yield
    /// for lenders comes exclusively from interest actually repaid.
    uint256 public rateBps;

    /// @notice Protocol performance fee on REALIZED interest, in bps.
    uint256 public feeBps;

    /// @notice Maximum allowed fee on interest: 2000 bps = 20%.
    uint256 public constant MAX_FEE_BPS = 2_000;

    /// @notice Address that can claim accrued protocol fees (owner-set).
    address public feeRecipient;

    /// @notice Unclaimed protocol fees, ring-fenced: excluded from
    /// totalAssets (lender shares never earn on them) and from
    /// availableLiquidity (they can never be lent out). Claimable only to
    /// `feeRecipient` — there is NO path for the owner to touch principal.
    uint256 public accruedFees;

    /// @notice Cumulative interest projected by the fixed rate model on
    /// outstanding principal since pool inception (informational checkpoint,
    /// updated by permissionless `accrueInterest`).
    uint256 public projectedInterest;

    /// @notice Last accrual checkpoint for the rate model.
    uint64 public lastAccrual;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice UUPS initialization: replaces the former constructor. Wires the
     * pool's single asset, its owner, the authorized VeilLend contract and
     * the share token metadata. Call exactly once, through the proxy.
     */
    function initialize(IERC20 asset_, address owner_, address lend_, string calldata name_, string calldata symbol_)
        external
        initializer
    {
        if (asset_ == IERC20(address(0)) || owner_ == address(0) || lend_ == address(0)) revert ZeroAddress();
        __ERC20_init(name_, symbol_);
        __ERC4626_init(asset_);
        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        lend = lend_;
        rateBps = 0;
        feeBps = 0;
        lastAccrual = uint64(block.timestamp);
    }

    /// @notice UUPS upgrade authorization: owner-only. Upgrading swaps
    /// implementation code only — depositor assets/shares live in proxy
    /// storage and no owner custody path exists to reach them.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    modifier onlyLend() {
        if (msg.sender != lend) revert OnlyLend();
        _;
    }

    // ------------------------------------------------------------------
    // Pool views
    // ------------------------------------------------------------------

    /// @notice Lendable idle tokens: the actual balance minus the
    /// ring-fenced fee reserve. Borrow funding can never consume fees.
    function availableLiquidity() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - accruedFees;
    }

    /// @notice Total pool assets BACKING SHARES = lendable idle + principal
    /// out on loan. Realized interest minus the protocol fee lands in the
    /// idle balance and therefore share value; accrued (unclaimed) fees are
    /// excluded so lenders never earn on them. Direct donations ARE part of
    /// totalAssets by ERC4626 semantics (they raise every share's value).
    function totalAssets() public view override returns (uint256) {
        return availableLiquidity() + totalBorrows;
    }

    /// @notice Borrowed principal as a fraction of total assets, 1e18-scaled.
    function utilization() public view returns (uint256) {
        uint256 total = totalAssets();
        return total == 0 ? 0 : (totalBorrows * 1e18) / total;
    }

    // ------------------------------------------------------------------
    // VeilLend-only funding paths
    // ------------------------------------------------------------------

    /**
     * @notice Moves idle liquidity out of the pool to fund a borrow. Called
     * exclusively by VeilLend after its own ZK proof + LTV cap checks; the
     * recipient is the borrower bound by the proof (F5), never chosen here.
     */
    function pullLiquidity(address to, uint256 amount) external onlyLend whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > availableLiquidity()) revert InsufficientPoolLiquidity();
        totalBorrows += amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit LiquidityPulled(to, amount);
    }

    /**
     * @notice Records a repayment returned by VeilLend with an EXPLICIT
     * principal/interest split. The tokens must have been transferred to the
     * pool by VeilLend in the same transaction BEFORE this call. VeilLend
     * derives the split from its own per-position ledger (borrowOutstanding
     * vs the repaid amount) — the aggregate totalBorrows is never used to
     * infer interest, so one borrower's repayment cannot be swallowed by
     * another borrower's outstanding principal.
     * @param principal portion that reduces totalBorrows.
     * @param interest realized interest: stays as idle balance (lender yield
     * via totalAssets) minus the protocol fee ring-fenced in accruedFees.
     */
    function onRepayment(uint256 principal, uint256 interest) external onlyLend {
        if (principal > totalBorrows) revert InvalidParameter();
        totalBorrows -= principal;
        if (interest > 0 && feeBps > 0) {
            uint256 fee = (interest * feeBps) / BPS_DENOMINATOR;
            accruedFees += fee; // ring-fenced: excluded from shares and lending below
        }
        emit RepaymentReceived(principal, interest);
    }

    /**
     * @notice Realizes bad debt: removes unrecoverable principal from
     * totalBorrows WITHOUT any token movement. Called by VeilLend when a
     * liquidation cannot recover a position's pool principal — the loss is
     * socialized: totalAssets (and therefore every share's value) drops by
     * exactly the written-off amount, proportionally across lenders. No
     * forgiveness path exists outside the wired VeilLend contract.
     */
    function writeOffBorrows(uint256 amount) external onlyLend {
        if (amount > totalBorrows) revert InvalidParameter();
        totalBorrows -= amount;
        emit BorrowsWrittenOff(amount);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Configures pool economics (owner-only): the fee on realized
    /// interest (bps, capped at MAX_FEE_BPS) and the fee recipient. Fees
    /// apply ONLY to interest actually received; principal and lender
    /// deposits are never feeable. The interest RATE is not set here — it
    /// is synced from VeilLend's borrower accrual config via `updateRateBps`
    /// so the pool's model can never drift from the real borrower rate.
    function configurePool(uint256 feeBps_, address feeRecipient_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParameter();
        if (feeBps_ > 0 && feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit PoolConfigured(rateBps, feeBps_, feeRecipient_);
    }

    /// @notice Syncs the borrower accrual rate from the wired VeilLend
    /// contract (onlyLend). Called by VeilLend whenever the borrower rate
    /// config changes or a pool gets wired, keeping the pool's interest
    /// model equal to the actual economic borrower rate at all times.
    function updateRateBps(uint256 rateBps_) external onlyLend {
        rateBps = rateBps_;
        emit PoolConfigured(rateBps_, feeBps, feeRecipient);
    }

    /// @notice Permissionless rate-model checkpoint: projects interest on
    /// outstanding principal at `rateBps` since the last checkpoint.
    /// Informational only — projected interest is NOT added to totalAssets
    /// and cannot back shares or withdrawals until it is actually repaid.
    function accrueInterest() external {
        uint64 checkpoint = lastAccrual;
        if (checkpoint == 0) revert InvalidParameter();
        uint256 dt = block.timestamp - checkpoint;
        if (dt > 0 && totalBorrows > 0 && rateBps > 0) {
            projectedInterest += (totalBorrows * rateBps * dt) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        }
        if (dt > 0) {
            lastAccrual = uint64(block.timestamp);
            emit InterestAccrued(projectedInterest, lastAccrual);
        }
    }

    /// @notice Owner-only claim of accrued protocol fees to the configured
    /// recipient. Only fees — never lender principal or interest shares.
    function claimFees() external onlyOwner {
        if (accruedFees == 0) revert NothingToClaim();
        uint256 amount = accruedFees;
        accruedFees = 0;
        IERC20(asset()).safeTransfer(feeRecipient, amount);
        emit FeesClaimed(feeRecipient, amount);
    }

    /// @notice Rewires the authorized VeilLend contract (owner-only).
    function setLend(address lend_) external onlyOwner {
        if (lend_ == address(0)) revert ZeroAddress();
        lend = lend_;
        emit LendSet(lend_);
    }

    /// @notice Emergency pause: freezes lender deposits/withdrawals and new
    /// borrow funding. Repayment recording stays open so in-flight borrows
    /// can always be settled back into the pool.
    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    // ------------------------------------------------------------------
    // ERC4626 — pause the lender entry/exit paths
    // ------------------------------------------------------------------

    function deposit(uint256 assets, address receiver)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override whenNotPaused nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner_);
    }

    // ------------------------------------------------------------------
    // ERC4626 withdrawability bounds
    //
    // Lender withdrawal behavior with liquidity locked in outstanding
    // loans: claims are ALWAYS honored up to the pool's idle balance and
    // NEVER beyond it. While borrows are outstanding, a lender can exit
    // only partially (up to `availableLiquidity`); the remainder becomes
    // withdrawable automatically as VeilLend repays. These overrides make
    // the ERC4626 `max*` views honest — the OZ defaults advertise claims
    // backed by lent-out principal, which would revert when executed.
    //
    // `onRepayment` is intentionally NOT reentrancy-guarded: it performs
    // no external call (the tokens arrive via VeilLend's transfer first).
    // ------------------------------------------------------------------

    /// @notice Largest amount of assets `owner` can withdraw RIGHT NOW:
    /// the smaller of the owner's claim and the pool's idle balance.
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 claim = convertToAssets(balanceOf(owner));
        uint256 idle = availableLiquidity();
        uint256 assets = claim <= idle ? claim : idle;
        if (assets == 0) return 0;
        // withdraw() burns ceil-rounded shares; ensure they fit the balance
        if (previewWithdraw(assets) > balanceOf(owner)) assets -= 1;
        return assets;
    }

    /// @notice Largest amount of shares `owner` can redeem RIGHT NOW.
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 shares = balanceOf(owner);
        uint256 maxByLiquidity = convertToShares(availableLiquidity());
        return shares <= maxByLiquidity ? shares : maxByLiquidity;
    }

    /// @notice 3 virtual decimals of inflation protection against the
    /// first-depositor share-price attack (standard ERC4626 offset hook).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }
}
