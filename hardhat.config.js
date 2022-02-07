/* eslint-disable indent, no-undef */
require('dotenv').config()
require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-etherscan')
require('@nomiclabs/hardhat-waffle')
require('@openzeppelin/hardhat-upgrades')
require('hardhat-spdx-license-identifier')
require('hardhat-storage-layout')
require('hardhat-log-remover')
require('hardhat-contract-sizer')
require('solidity-coverage')
/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    compilers: [
      {
        version: '0.6.2',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          outputSelection: {
            '*': {
              '*': ['storageLayout'],
            },
          },
        },
      },
      {
        version: '0.6.12',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          outputSelection: {
            '*': {
              '*': ['storageLayout'],
            },
          },
        },
      },
      {
        version: '0.8.7',
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          outputSelection: {
            '*': {
              '*': ['storageLayout'],
            },
          },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      forking: {
        url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_KEY}`,
        blockNumber: 13685625,
      },
      chainId: 1,
      initialBaseFeePerGas: 5,
      loggingEnabled: false,
      allowUnlimitedContractSize: false,
      blockGasLimit: 50000000,
    },
    localhost: {
      forking: {
        url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_KEY}`,
        blockNumber: 13685625,
      },
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
    },
    mainnet: {
      url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_KEY}`,
      accounts: process.env.PRIVATE_KEY
        ? [process.env.PRIVATE_KEY]
        : {
            mnemonic: 'test test test test test test test test test test test junk',
          },
      timeout: 2147483647,
    },
  },
  mocha: { timeout: 9999999999 },
  spdxLicenseIdentifier: {
    overwrite: true,
    runOnCompile: true,
  },
  etherscan: {
    apiKey: `${process.env.ETHERSCAN_KEY}`,
  },
}
