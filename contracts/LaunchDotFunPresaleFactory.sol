// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchDotFunPresale} from "./LaunchDotFunPresale.sol";
import {LaunchDotFunTokenFactory} from "./LaunchDotFunTokenFactory.sol";
import {LaunchDotFunTokenWrapper} from "./LaunchDotFunTokenWrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LaunchDotFunPresaleFactory {
    using SafeERC20 for IERC20;

    address private zweth;
    address private tokenFactory;
    address[] public allPresales;
    mapping(address creator => address[] presales) private presalesByCreator;

    event LaunchDotFunPresaleCreated(
        address indexed creator,
        address presale,
        address token,
        address ztoken,
        address zweth
    );

    constructor(address _zweth, address _tokenFactory) {
        require(_zweth != address(0), "Invalid zweth address");
        require(_tokenFactory != address(0), "Invalid token factory address");
        zweth = _zweth;
        tokenFactory = _tokenFactory;
    }

    function createLaunchDotFunPresale(
        address _token,
        LaunchDotFunPresale.PresaleOptions memory _options
    ) external returns (address presale) {
        LaunchDotFunTokenWrapper ztoken = new LaunchDotFunTokenWrapper(
            string(abi.encodePacked("Confidential ", IERC20Metadata(_token).name())),
            string(abi.encodePacked("c", IERC20Metadata(_token).symbol())),
            "",
            IERC20(_token)
        );

        LaunchDotFunPresale newPresale = new LaunchDotFunPresale(msg.sender, zweth, _token, address(ztoken), _options);

        IERC20(_token).safeTransferFrom(msg.sender, address(newPresale), _options.tokenPresale);

        allPresales.push(address(newPresale));
        presalesByCreator[msg.sender].push(address(newPresale));

        emit LaunchDotFunPresaleCreated(msg.sender, address(newPresale), _token, address(ztoken), zweth);

        return address(newPresale);
    }

    function getPresalesByCreator(address creator) external view returns (address[] memory) {
        return presalesByCreator[creator];
    }
}
