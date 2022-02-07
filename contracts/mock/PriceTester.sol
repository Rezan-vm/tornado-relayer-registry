// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;

import { UniswapV3OracleHelper } from "../libraries/UniswapV3OracleHelper.sol";

contract PriceTester {
  mapping(address => uint256) public lastPriceOfToken;
  uint256 public lastPriceOfATokenInToken;

  function getPriceOfTokenInToken(
    address[2] memory tokens,
    uint24[2] memory fees,
    uint32 period
  ) public returns (uint256) {
    lastPriceOfATokenInToken = UniswapV3OracleHelper.getPriceRatioOfTokens(tokens, fees, period);
    return lastPriceOfATokenInToken;
  }

  function getPriceOfTokenInETH(
    address token,
    uint24 fee,
    uint32 period
  ) public returns (uint256) {
    lastPriceOfToken[token] = UniswapV3OracleHelper.getPriceOfTokenInWETH(token, fee, period);
    return lastPriceOfToken[token];
  }

  function getPriceOfWETHInToken(
    address token,
    uint24 fee,
    uint32 period
  ) public returns (uint256) {
    lastPriceOfToken[token] = UniswapV3OracleHelper.getPriceOfWETHInToken(token, fee, period);
    return lastPriceOfToken[token];
  }
}
