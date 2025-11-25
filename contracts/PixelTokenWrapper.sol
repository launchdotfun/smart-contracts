// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {
    ERC7984ERC20Wrapper
} from "@openzeppelin/contracts-confidential/contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ERC7984} from "@openzeppelin/contracts-confidential/contracts/token/ERC7984/ERC7984.sol";

contract PixelTokenWrapper is ZamaEthereumConfig, ERC7984ERC20Wrapper {
    constructor(
        string memory name_,
        string memory symbol_,
        string memory tokenURI_,
        IERC20 underlying_
    ) ERC7984ERC20Wrapper(underlying_) ERC7984(name_, symbol_, tokenURI_) {}
}
