// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import { GovernanceStakingUpgrade } from "../governance-upgrade/GovernanceStakingUpgrade.sol";

contract TestGovernanceUpgrade is GovernanceStakingUpgrade {
  constructor(
    address stakingRewardsAddress,
    address gasCompLogic,
    address userVaultAddress
  ) public GovernanceStakingUpgrade(stakingRewardsAddress, gasCompLogic, userVaultAddress) {}

  function test() public pure returns (int256) {
    return 231;
  }
}
