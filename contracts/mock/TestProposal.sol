// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import { ImmutableGovernanceInformation } from "tornado-governance/contracts/v2-vault-and-gas/ImmutableGovernanceInformation.sol";
import { LoopbackProxy } from "tornado-governance/contracts/v1/LoopbackProxy.sol";
import { TestGovernanceUpgrade } from "./TestGovernanceUpgrade.sol";

contract TestProposal is ImmutableGovernanceInformation {
  address public immutable staking;
  address public immutable gasCompLogic;
  address public immutable tornadoVault;

  constructor(
    address _gasCompLogic,
    address _tornadoVault,
    address _staking
  ) public {
    gasCompLogic = _gasCompLogic;
    tornadoVault = _tornadoVault;
    staking = _staking;
  }

  function executeProposal() external {
    LoopbackProxy(returnPayableGovernance()).upgradeTo(address(new TestGovernanceUpgrade(staking, gasCompLogic, tornadoVault)));
  }
}
