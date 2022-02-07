const { ethers } = require('hardhat')
const namehash = require('eth-ens-namehash')
const { generate } = require('../src/0_generateAddresses')
const ensResolverAbi = require('../test/abi/ensResolver.json')
const config = require('../config')
const { assert } = require('chai')

async function deploy({ address, bytecode, singletonFactory }) {
  const contractCode = await ethers.provider.getCode(address)
  if (contractCode !== '0x') {
    console.log(`Contract ${address} already deployed. Skipping...`)
    return
  }
  await singletonFactory.deploy(bytecode, config.salt)
}

async function main() {
  const [sender] = await ethers.getSigners()
  const ensResolver = new ethers.Contract(config.ensResolver, ensResolverAbi, sender)
  const singletonFactory = await ethers.getContractAt(
    'SingletonFactory',
    config.singletonFactoryVerboseWrapper,
  )
  const contracts = await generate()

  for (let contract of Object.values(contracts)) {
    if (contract.domain) {
      const address = contract.isProxy ? contract.proxy.address : contract.address
      const addressFromChain = await ensResolver['addr(bytes32)'](namehash.hash(contract.domain))
      assert(
        ethers.utils.getAddress(address) == addressFromChain,
        `${contract.domain} must be set to ${address}. Now it's ${addressFromChain}`,
      )
    }
  }
  console.log('All domains have correct addresses. Ready to deploy')

  for (let [name, contract] of Object.entries(contracts)) {
    const address = contract.isProxy ? contract.proxy.address : contract.address
    console.log(`\nDeploying ${address} ${name}`)

    if (contract.isProxy) {
      console.log(`Deploying its implementation ${contract.implementation.address}...`)
      await deploy({ ...contract.implementation, singletonFactory })

      console.log(`Deploying its upgradeability proxy ${contract.proxy.address}...`)
      await deploy({ ...contract.proxy, singletonFactory })
    } else {
      await deploy({ ...contract, singletonFactory })
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
