// SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import { ImmutableGovernanceInformation } from "tornado-governance/contracts/v2-vault-and-gas/ImmutableGovernanceInformation.sol";

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { LoopbackProxy } from "tornado-governance/contracts/v1/LoopbackProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { GovernanceStakingUpgrade } from "./governance-upgrade/GovernanceStakingUpgrade.sol";
import { TornadoStakingRewards } from "./staking/TornadoStakingRewards.sol";
import { RelayerRegistry } from "./RelayerRegistry.sol";
import { TornadoRouter } from "./tornado-proxy/TornadoRouter.sol";
import { FeeManager } from "./tornado-proxy/FeeManager.sol";
import { InstanceRegistry } from "./tornado-proxy/InstanceRegistry.sol";

import { TornadoProxy, ITornadoInstance } from "tornado-anonymity-mining/contracts/TornadoProxy.sol";

contract RelayerRegistryProposal is ImmutableGovernanceInformation {
  using SafeMath for uint256;
  using Address for address;

  // from CREATE2 deploy
  TornadoRouter public immutable tornadoRouter;
  FeeManager public immutable feeManager;
  RelayerRegistry public immutable relayerRegistry;
  TornadoStakingRewards public immutable staking;
  InstanceRegistry public immutable instanceRegistry;
  address public immutable oldTornadoProxy;
  address public immutable gasCompLogic;
  address public immutable tornadoVault;

  constructor(
    address _oldTornadoProxy,
    address _gasCompLogic,
    address _tornadoVault,
    address _tornadoRouter,
    address _feeManager,
    address _relayerRegistry,
    address _staking,
    address _instanceRegistry
  ) public {
    oldTornadoProxy = _oldTornadoProxy;
    gasCompLogic = _gasCompLogic;
    tornadoVault = _tornadoVault;
    tornadoRouter = TornadoRouter(_tornadoRouter);
    feeManager = FeeManager(_feeManager);
    relayerRegistry = RelayerRegistry(_relayerRegistry);
    staking = TornadoStakingRewards(_staking);
    instanceRegistry = InstanceRegistry(_instanceRegistry);
  }

  function executeProposal() external {
    require(address(tornadoRouter).isContract(), "tornado router not deployed");
    require(address(feeManager).isContract(), "fee manager not deployed");
    require(address(staking).isContract(), "staking contract not deployed");
    require(address(relayerRegistry).isContract(), "relayer registry not deployed");
    require(address(instanceRegistry).isContract(), "instance registry not deployed");

    // Initialization
    relayerRegistry.setMinStakeAmount(300 ether);
    feeManager.setPeriodForTWAPOracle(5400);
    feeManager.setUniswapTornPoolSwappingFee(10000); // uniswap TORN/ETH pool with 1% fee
    feeManager.setUpdateFeeTimeLimit(172800); // 2 days

    LoopbackProxy(returnPayableGovernance()).upgradeTo(
      address(new GovernanceStakingUpgrade(address(staking), gasCompLogic, tornadoVault))
    );

    disableOldProxy(instanceRegistry);
  }

  function disableOldProxy(InstanceRegistry _instanceRegistry) private {
    TornadoProxy.Tornado memory currentTornado;
    InstanceRegistry.Tornado memory currentInstance;
    InstanceRegistry.Tornado[] memory instances = _instanceRegistry.getAllInstances();

    for (uint256 i = 0; i < instances.length; i++) {
      currentInstance = instances[i];
      currentTornado = TornadoProxy.Tornado(
        currentInstance.addr,
        TornadoProxy.Instance(false, IERC20(0), TornadoProxy.InstanceState.DISABLED)
      );

      TornadoProxy(oldTornadoProxy).updateInstance(currentTornado);
    }
  }
}
