const { ethers } = require('hardhat')

const config = require('../config.json')
const WETH = config.tokenAddresses.weth

const pools = new Set()

async function addTWAPSlots() {
  const uniFactory = await ethers.getContractAt(
    'IUniswapV3Factory',
    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  )
  const tornUnipoolAddress = await uniFactory.getPool(config.tokenAddresses.torn, WETH, 10000)
  pools.add(tornUnipoolAddress)

  for (let { instance } of config.instances) {
    const { token, uniswapPoolSwappingFee, isERC20 } = instance
    if (!isERC20) continue

    const unipoolAddress = await uniFactory.getPool(token, WETH, uniswapPoolSwappingFee)
    pools.add(unipoolAddress)
  }

  // console.log(`Setting TWAP observation cardinality to ${config.TWAPSlots} for each whitelisted token`)
  for (let pool of pools) {
    const unipool = await ethers.getContractAt('IUniswapV3Pool', pool)
    const { observationCardinalityNext } = await unipool.slot0()
    // console.log(`current observationCardinality for ${pool} is ${observationCardinalityNext}`)

    if (observationCardinalityNext < config.TWAPSlots) {
      await unipool.increaseObservationCardinalityNext(config.TWAPSlots)
      // const reciept = await tx.wait()
      // console.log('gas used', reciept.cumulativeGasUsed.toString())
    }
  }
}

module.exports = { addTWAPSlots }
