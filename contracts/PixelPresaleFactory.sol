// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PixelPresale} from "./PixelPresale.sol";
import {PixelTokenFactory} from "./PixelTokenFactory.sol";
import {PixelTokenWrapper} from "./PixelTokenWrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract PixelPresaleFactory {
    using SafeERC20 for IERC20;

    address private zweth;
    address private tokenFactory;
    address[] public allPresales;
    mapping(address creator => address[] presales) private presalesByCreator;

    event PixelPresaleCreated(address indexed creator, address presale, address token, address ztoken, address zweth);

    constructor(address _zweth, address _tokenFactory) {
        require(_zweth != address(0), "Invalid zweth address");
        require(_tokenFactory != address(0), "Invalid token factory address");
        zweth = _zweth;
        tokenFactory = _tokenFactory;
    }

    function createPixelPresale(
        address _token,
        address _ztoken,
        PixelPresale.PresaleOptions memory _options
    ) external returns (address presale) {
        PixelPresale newPresale = new PixelPresale(msg.sender, zweth, _token, _ztoken, _options);

        IERC20(_token).safeTransferFrom(msg.sender, address(newPresale), _options.tokenPresale);

        allPresales.push(address(newPresale));
        presalesByCreator[msg.sender].push(address(newPresale));

        emit PixelPresaleCreated(msg.sender, address(newPresale), _token, _ztoken, zweth);

        return address(newPresale);
    }

    function createPixelPresaleWithNewToken(
        string memory _name,
        string memory _symbol,
        uint256 _totalSupply,
        PixelPresale.PresaleOptions memory _options
    ) external returns (address presale) {
        // Create new token using PixelTokenFactory
        PixelTokenFactory factory = PixelTokenFactory(tokenFactory);
        address tokenAddress = factory.createToken(_name, _symbol, 18, _totalSupply, "");

        // Create PixelTokenWrapper for the token
        PixelTokenWrapper ztoken = new PixelTokenWrapper(
            string(abi.encodePacked("z", _name)),
            string(abi.encodePacked("z", _symbol)),
            "",
            IERC20(tokenAddress)
        );

        // Create presale with the new token and wrapper
        PixelPresale newPresale = new PixelPresale(msg.sender, zweth, tokenAddress, address(ztoken), _options);

        // Transfer tokens from caller to presale (tokens were minted to msg.sender by token factory)
        // We use transfer instead of safeTransferFrom because we can't approve a token that doesn't exist yet
        // The caller must ensure they have the tokens (which they do, since they were just minted to them)
        IERC20 token = IERC20(tokenAddress);
        require(token.transfer(address(newPresale), _options.tokenPresale), "Token transfer failed");

        allPresales.push(address(newPresale));
        presalesByCreator[msg.sender].push(address(newPresale));

        emit PixelPresaleCreated(msg.sender, address(newPresale), tokenAddress, address(ztoken), zweth);

        return address(newPresale);
    }

    function getPresalesByCreator(address creator) external view returns (address[] memory) {
        return presalesByCreator[creator];
    }
}
