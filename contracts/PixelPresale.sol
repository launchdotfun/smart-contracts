// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {PixelTokenWrapper} from "./PixelTokenWrapper.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {PixelWETH} from "./PixelWETH.sol";

interface IPixelPresale {
    error InvalidState(uint8 currentState);
    error NotInPurchasePeriod();
    error NotRefundable();
    error InvalidCapValue();
    error InvalidTimestampValue();
    event PoolInitialized(
        address indexed creator,
        uint256 amount,
        uint256 liquidityTokens,
        uint256 presaleTokens,
        uint256 timestamp
    );
}

contract PixelPresale is ZamaEthereumConfig, IPixelPresale, Ownable {
    using SafeERC20 for IERC20;
    using Address for address payable;

    struct PresaleOptions {
        uint256 tokenPresale;
        uint64 hardCap;
        uint64 softCap;
        uint128 start;
        uint128 end;
    }

    struct Pool {
        IERC20 token;
        PixelTokenWrapper ztoken;
        uint256 tokenBalance;
        uint256 tokensSold;
        uint256 weiRaised;
        euint64 ethRaisedEncrypted;
        uint64 tokenPerEthWithDecimals;
        address zweth;
        uint8 state;
        PresaleOptions options;
    }

    mapping(address user => euint64 contribution) public contributions;
    mapping(address user => euint64 claimableTokens) public claimableTokens;
    mapping(address user => bool claimed) public claimed;
    mapping(address user => bool refunded) public refunded;
    uint64 public fillNumerator;
    uint64 public fillDenominator;
    mapping(address user => bool settled) public settled;

    Pool public pool;

    constructor(
        address _owner,
        address _zweth,
        address _token,
        address _ztoken,
        PresaleOptions memory _options
    ) Ownable(_owner) {
        _prevalidatePool(_options);

        pool.token = IERC20(_token);
        pool.ztoken = PixelTokenWrapper(_ztoken);
        pool.zweth = _zweth;
        pool.options = _options;

        uint256 rate = PixelTokenWrapper(_ztoken).rate();

        pool.state = 1;

        pool.tokenBalance = _options.tokenPresale;

        pool.ethRaisedEncrypted = FHE.asEuint64(0);
        FHE.allowThis(pool.ethRaisedEncrypted);
        require(_options.hardCap > 0, "Hard cap zero");

        uint256 presaleUnits = _options.tokenPresale / rate;
        require(presaleUnits >= _options.hardCap, "Rate too low");

        uint256 tpe = presaleUnits / _options.hardCap;
        require(tpe <= type(uint64).max, "Rate overflow");
        pool.tokenPerEthWithDecimals = SafeCast.toUint64(tpe);
        emit PoolInitialized(_owner, _options.tokenPresale, 0, _options.tokenPresale, block.timestamp);
    }

    receive() external payable {}

    function placeBid(address beneficiary, externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        require(pool.state == 1, "Invalid state");
        require(block.timestamp >= pool.options.start && block.timestamp <= pool.options.end, "Not in bid period");

        _handleBid(beneficiary, encryptedAmount, inputProof);
    }

    function claimTokens(address beneficiary) external {
        require(pool.state == 4, "Invalid state");
        require(!claimed[beneficiary], "Already claimed");
        claimed[beneficiary] = true;

        euint64 claimableToken = claimableTokens[beneficiary];

        FHE.allowTransient(claimableToken, address(pool.ztoken));
        FHE.allowTransient(claimableToken, address(this));
        pool.ztoken.confidentialTransfer(beneficiary, claimableToken);
    }

    function refund() external {
        address beneficiary = msg.sender;

        require(pool.state == 3, "Invalid state");
        require(!refunded[beneficiary], "Already refunded");

        euint64 amount = contributions[beneficiary];
        require(euint64.unwrap(amount) != bytes32(0), "No bid");

        refunded[beneficiary] = true;

        FHE.allowTransient(amount, address(pool.zweth));
        FHE.allowTransient(amount, address(this));
        PixelWETH(pool.zweth).confidentialTransfer(beneficiary, amount);
    }

    function _prevalidatePool(PresaleOptions memory _options) internal pure returns (bool) {
        if (_options.softCap == 0) revert InvalidCapValue();
        if (_options.softCap > _options.hardCap) revert InvalidCapValue();
        if (_options.end < _options.start) revert InvalidTimestampValue();
        return true;
    }

    function finalizePreSale(
        uint64 ethRaised,
        uint64 tokensSold,
        uint64 _fillNumerator,
        uint64 _fillDenominator
    ) external virtual onlyOwner {
        uint8 currentState = pool.state;
        uint128 endTime = pool.options.end;

        require(currentState == 1 || currentState == 2, "Presale is not active");
        require(block.timestamp >= endTime, "Presale is not ended");
        require(_fillDenominator != 0, "Invalid fill ratio");

        pool.state = 2;

        fillNumerator = _fillNumerator;
        fillDenominator = _fillDenominator;

        _handleFinalizePreSale(ethRaised, tokensSold);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _handleBid(address beneficiary, externalEuint64 encryptedAmount, bytes calldata inputProof) internal {
        address zweth = pool.zweth;

        euint64 userBid = contributions[beneficiary];
        if (euint64.unwrap(userBid) == bytes32(0)) {
            userBid = FHE.asEuint64(0);
        }

        euint64 bidAmount = FHE.fromExternal(encryptedAmount, inputProof);

        euint64 newUserBid = FHE.add(userBid, bidAmount);

        FHE.allowTransient(bidAmount, zweth);
        euint64 transferred = PixelWETH(zweth).confidentialTransferFrom(beneficiary, address(this), bidAmount);

        euint64 currentEthRaised = pool.ethRaisedEncrypted;

        euint64 newEthRaised = FHE.add(currentEthRaised, transferred);

        pool.ethRaisedEncrypted = newEthRaised;
        contributions[beneficiary] = newUserBid;

        FHE.allowThis(pool.ethRaisedEncrypted);
        FHE.allowThis(newUserBid);
        FHE.allow(newUserBid, beneficiary);
        FHE.allowTransient(transferred, address(this));
        FHE.allowTransient(bidAmount, address(this));
    }

    function _handleFinalizePreSale(uint64 zwethRaised, uint64 tokensSold) internal {
        uint256 rate = pool.ztoken.rate();
        uint256 tokenPresale = pool.options.tokenPresale;
        uint64 softCap = pool.options.softCap;
        euint64 ethRaisedEncrypted = pool.ethRaisedEncrypted;
        euint64 ethUsedEncrypted = FHE.div(FHE.mul(ethRaisedEncrypted, fillNumerator), fillDenominator);

        uint256 weiRaised = zwethRaised * 1e9;
        uint256 tokensSoldValue = tokensSold * rate;

        pool.weiRaised = weiRaised;
        pool.tokensSold = tokensSoldValue;

        require(pool.state == 2, "Invalid pool state");

        if (zwethRaised < softCap) {
            pool.state = 3;
            pool.token.safeTransfer(owner(), tokenPresale);
        } else {
            pool.state = 4;

            if (tokenPresale > tokensSoldValue) {
                uint256 unsoldToken = tokenPresale - tokensSoldValue;
                pool.token.safeTransfer(owner(), unsoldToken);
            }

            IERC20 token = pool.token;
            token.forceApprove(address(pool.ztoken), tokensSoldValue);
            pool.ztoken.wrap(address(this), tokensSoldValue);

            FHE.allowTransient(ethUsedEncrypted, address(pool.zweth));
            FHE.allowTransient(ethUsedEncrypted, address(this));
            PixelWETH(pool.zweth).withdrawAndFinalize(address(this), owner(), ethUsedEncrypted, zwethRaised);
        }
    }

    function settleBid(address beneficiary) external {
        require(pool.state == 4, "Presale not successful");
        require(!settled[beneficiary], "Already settled");
        require(fillDenominator != 0, "Fill ratio not set");

        euint64 userBid = contributions[beneficiary];
        require(euint64.unwrap(userBid) != bytes32(0), "No bid");

        // used = userBid * fillNumerator / fillDenominator
        euint64 used = FHE.div(FHE.mul(userBid, fillNumerator), fillDenominator);

        euint64 refundAmount = FHE.sub(userBid, used);

        // allocatedTokens = used * tokenPerEthWithDecimals
        euint64 allocatedTokens = FHE.mul(used, pool.tokenPerEthWithDecimals);

        // Lưu claimableTokens để user claim zToken
        claimableTokens[beneficiary] = allocatedTokens;
        FHE.allowThis(allocatedTokens);
        FHE.allow(allocatedTokens, beneficiary);
        FHE.allowTransient(refundAmount, address(this));
        // Refund phần dư zWETH
        FHE.allowTransient(refundAmount, pool.zweth);
        PixelWETH(pool.zweth).confidentialTransfer(beneficiary, refundAmount);

        settled[beneficiary] = true;
    }
}
