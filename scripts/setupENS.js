const { ethers } = require('hardhat')

const { generate } = require('../src/0_generateAddresses')
const { setupENS } = require('../src/1_setupENS')

const ensResolverAbi = require('../test/abi/ensResolver.json')
const ensRegistryAbi = require('../test/abi/ensRegistry.json')

const config = require('../config')

async function main() {
  const contracts = await generate()
  const [sender] = await ethers.getSigners()

  const ensResolver = new ethers.Contract(config.ensResolver, ensResolverAbi, sender)
  const ensRegistry = new ethers.Contract(config.ensRegistry, ensRegistryAbi, sender)

  await setupENS({ contracts, ensResolver, ensRegistry })
  console.log('ENS setup complete')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
