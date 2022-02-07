// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;

import "@openzeppelin/contracts/utils/Create2.sol";

contract Create2Computer {
  function computeAddress(
    bytes32 salt,
    bytes32 bytecodeHash,
    address deployer
  ) external pure returns (address) {
    return Create2.computeAddress(salt, bytecodeHash, deployer);
  }
}
