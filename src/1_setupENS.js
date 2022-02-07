const { ethers } = require('hardhat')
const namehash = require('eth-ens-namehash')
const config = require('../config.json')

async function setupENS({ contracts, ensRegistry, ensResolver }) {
  for (let contract of Object.values(contracts)) {
    if (!contract.domain) continue

    const recordExists = await ensRegistry.recordExists(namehash.hash(contract.domain))
    if (!recordExists) {
      const [label] = contract.domain.split('.')
      await ensRegistry.setSubnodeRecord(
        namehash.hash('contract.tornadocash.eth'),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label)),
        config.ensController,
        ensResolver.address,
        0,
      )
    } else {
      console.log(`ENS record for ${contract.domain} already exists`)
    }

    const address = contract.address ? contract.address : contract.proxy.address
    const existingAddress = await ensResolver['addr(bytes32)'](namehash.hash(contract.domain))
    if (ethers.utils.getAddress(existingAddress) !== ethers.utils.getAddress(address)) {
      await ensResolver['setAddr(bytes32,address)'](namehash.hash(contract.domain), address)
    } else {
      console.log(`ENS resolver for ${contract.domain} already set to ${address}`)
    }
  }
}

module.exports = {
  setupENS,
}
