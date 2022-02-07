const { ethers } = require('hardhat')
const namehash = require('eth-ens-namehash')
const mainnet = require('../config.json')

async function upgradableContract({ contractName, implConstructorArgs, proxyConstructorArgs, salt }) {
  const Implementation = await ethers.getContractFactory(contractName)

  const implementationBytecode =
    Implementation.bytecode + Implementation.interface.encodeDeploy(implConstructorArgs).slice(2)

  const implementationAddress = ethers.utils.getCreate2Address(
    mainnet.singletonFactory,
    salt,
    ethers.utils.keccak256(implementationBytecode),
  )

  const AdminUpgradeableProxy = await ethers.getContractFactory('AdminUpgradeableProxy')
  const proxyConst = [implementationAddress, ...proxyConstructorArgs]
  const proxyBytecode =
    AdminUpgradeableProxy.bytecode + AdminUpgradeableProxy.interface.encodeDeploy(proxyConst).slice(2)

  const proxyAddress = ethers.utils.getCreate2Address(
    mainnet.singletonFactory,
    salt,
    ethers.utils.keccak256(proxyBytecode),
  )

  return {
    implementation: { address: implementationAddress, bytecode: implementationBytecode },
    proxy: { address: proxyAddress, bytecode: proxyBytecode },
    domain: mainnet.ens[contractName].domain,
    isProxy: true,
  }
}

async function generate() {
  const singletonFactory = await ethers.getContractAt('SingletonFactory', mainnet.singletonFactory)
  const TornadoRouter = await ethers.getContractFactory('TornadoRouter')
  let governance = mainnet.governance
  const deploymentBytecodeRouter =
    TornadoRouter.bytecode +
    TornadoRouter.interface
      .encodeDeploy([
        governance,
        namehash.hash(mainnet.ens.InstanceRegistry.domain),
        namehash.hash(mainnet.ens.RelayerRegistry.domain),
      ])
      .slice(2)

  const tornadoRouterAddress = ethers.utils.getCreate2Address(
    singletonFactory.address,
    mainnet.salt,
    ethers.utils.keccak256(deploymentBytecodeRouter),
  )

  const feeManagerContract = await upgradableContract({
    contractName: 'FeeManager',
    implConstructorArgs: [
      mainnet.tokenAddresses.torn,
      governance,
      namehash.hash(mainnet.ens.InstanceRegistry.domain),
    ],
    proxyConstructorArgs: [governance, []],
    salt: mainnet.salt,
  })

  /////////////// RELAYER REGISTRY
  const relayerRegistryFactory = await ethers.getContractFactory('RelayerRegistry')
  const relayerProxyInitData = relayerRegistryFactory.interface.encodeFunctionData('initialize', [
    namehash.hash(mainnet.ens.TornadoRouter.domain),
  ])
  const relayerRegistryContract = await upgradableContract({
    contractName: 'RelayerRegistry',
    implConstructorArgs: [
      mainnet.tokenAddresses.torn,
      governance,
      mainnet.ensRegistry,
      namehash.hash(mainnet.ens.TornadoStakingRewards.domain),
      namehash.hash(mainnet.ens.FeeManager.domain),
    ],
    proxyConstructorArgs: [governance, relayerProxyInitData],
    salt: mainnet.salt,
  })

  const stakingContract = await upgradableContract({
    contractName: 'TornadoStakingRewards',
    implConstructorArgs: [
      governance,
      mainnet.tokenAddresses.torn,
      namehash.hash(mainnet.ens.RelayerRegistry.domain),
    ],
    proxyConstructorArgs: [governance, []],
    salt: mainnet.salt,
  })

  const instanceRegistryFactory = await ethers.getContractFactory('InstanceRegistry')
  const instanceRegistryInitData = instanceRegistryFactory.interface.encodeFunctionData('initialize', [
    mainnet.instances,
    namehash.hash(mainnet.ens.TornadoRouter.domain),
  ])
  const instanceRegistryContract = await upgradableContract({
    contractName: 'InstanceRegistry',
    implConstructorArgs: [governance],
    proxyConstructorArgs: [governance, instanceRegistryInitData],
    salt: mainnet.salt,
  })

  const ProposalFactory = await ethers.getContractFactory('RelayerRegistryProposal')
  const deploymentBytecodeProposal =
    ProposalFactory.bytecode +
    ProposalFactory.interface
      .encodeDeploy([
        mainnet.tornadoProxy,
        mainnet.gasCompLogic,
        mainnet.tornadoVault,
        tornadoRouterAddress,
        feeManagerContract.proxy.address,
        relayerRegistryContract.proxy.address,
        stakingContract.proxy.address,
        instanceRegistryContract.proxy.address,
      ])
      .slice(2)

  const proposalAddress = ethers.utils.getCreate2Address(
    singletonFactory.address,
    mainnet.salt,
    ethers.utils.keccak256(deploymentBytecodeProposal),
  )

  const result = {
    tornadoRouter: {
      address: tornadoRouterAddress,
      bytecode: deploymentBytecodeRouter,
      domain: mainnet.ens.TornadoRouter.domain,
      isProxy: false,
    },
    feeManagerContract,
    relayerRegistryContract,
    stakingContract,
    instanceRegistryContract,
    proposalContract: {
      address: proposalAddress,
      bytecode: deploymentBytecodeProposal,
      isProxy: false,
    },
  }

  return result
}

module.exports = {
  generate,
}
