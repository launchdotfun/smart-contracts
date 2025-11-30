// SPDX-License-Identifier: MIT

pragma solidity ^0.8.26;

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHE, externalEuint64, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC7984} from "@openzeppelin/contracts-confidential/contracts/token/ERC7984/ERC7984.sol";

contract LaunchDotFunWETH is ERC7984, ZamaEthereumConfig {
    uint8 private immutable DECIMALS;
    uint256 private immutable RATE;

    constructor() ERC7984("Confidential Zama Wrapped ETH", "zWETH", "https://zweth.com") {
        DECIMALS = 9;
        RATE = 10 ** 9;
    }

    function decimals() public view virtual override returns (uint8) {
        return DECIMALS;
    }

    function rate() public view returns (uint256) {
        return RATE;
    }

    function deposit(address to) public payable {
        uint256 amount = msg.value;
        require(amount > rate(), "Amount must be greater than rate");
        payable(msg.sender).transfer(amount % rate());
        uint64 mintAmount = SafeCast.toUint64(amount / rate());
        _mint(to, FHE.asEuint64(mintAmount));
    }

    function withdrawAndFinalize(address from, address to, euint64 encryptedAmount, uint64 decryptedAmount) public {
        require(
            FHE.isAllowed(encryptedAmount, msg.sender),
            ERC7984UnauthorizedUseOfEncryptedAmount(encryptedAmount, msg.sender)
        );
        require(to != address(0), ERC7984InvalidReceiver(to));
        require(from == msg.sender || isOperator(from, msg.sender), ERC7984UnauthorizedSpender(from, msg.sender));

        _burn(from, encryptedAmount);
        payable(to).transfer(decryptedAmount * rate());
    }

    function withdrawAndFinalize(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        uint64 decryptedAmount
    ) public virtual {
        withdrawAndFinalize(from, to, FHE.fromExternal(encryptedAmount, inputProof), decryptedAmount);
    }
}
