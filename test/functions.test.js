const { ethers } = require('hardhat')
const { expect } = require('chai')
const fs = require('fs')

const config = require('../config.json')
const { createDeposit, toHex, generateProof, initialize } = require('tornado-cli')
const { Note } = require('tornado-anonymity-mining')
const { getSignerFromAddress, takeSnapshot, revertSnapshot } = require('./utils')
const tornadoWithdrawalsCache = require('./proofsCache/tornadoWithdrawalsCache.json')
const { generate } = require('../src/0_generateAddresses')
const { setupENS } = require('../src/1_setupENS')
const { addTWAPSlots } = require('../src/2_addTWAPSlots')
const { PermitSigner } = require('../scripts/permit.js')

const namehash = require('eth-ens-namehash')
const ensResolverAbi = require('./abi/ensResolver.json')
const ensRegistryAbi = require('./abi/ensRegistry.json')
const uniswapRouterAbi = require('./abi/uniswapRouter.json')

const tornadoProxyPath = 'tornado-anonymity-mining/contracts/TornadoProxy.sol:TornadoProxy'

const ProposalState = {
  Pending: 0,
  Active: 1,
  Defeated: 2,
  Timelocked: 3,
  AwaitingExecution: 4,
  Executed: 5,
  Expired: 6,
}

const oneEthInstance = config.instances[1].addr
const notes = [
  'tornado-eth-1-1-0xbe568184f43156cc775668d83ae219164dcf51457f736391e67f187365b506d4f0633f18404a2c0c8c01d5c5e3f645eaea386b7386916dcc56374d91989d',
  'tornado-eth-1-1-0x4aeb2bda78b90b87a28bac0c722e2e462d91b4d476a9370e285e04d484137cae196f365eafa7d9f95f0cdf726fd9108a4eea520089d9831db4210dbcae0f',
  'tornado-eth-1-1-0xe542511cd578d38730d9d8b72322b1fe22644156c474f026301aede057935b29f087bab87b6db362816aef736c99c3f35489f8e2f0c01a2d103f47b32810',
  'tornado-dai-1000-1-0x6b185ead6eb3ca02fed42dfc87059faced8b2df91f984b7498262977f4f8cdb57a20110a44fd2a77203069ad2b06d0389149d57ae00fe919aaef636fb136',
  'tornado-cdai-50000-1-0x144601b47abde67c8e6ccc5dec25926bafc7ecbb71389fc87b5610fea7bdee4e9dfc8639c48ef04327bcc39cc8d9be2708af8f56e2266ada8367dde72292',
  'tornado-wbtc-0.1-1-0xd9f956fc90bab2cf6d7176c5eb262aac8f2ce82c4b9976d8386a68d4a3339650c4a2ec2abd255207bbd21abe79301e3513cc85d8e5073e4b862ac0b7f',
  'tornado-usdt-1000-1-0xb348dcaf0994381ab820288c720dd1afffe7277a1d99006fb20fe5404222e07de64ad5d7db2200f71d1bf62713f89f4732eac5dc361df62aea62ec4f9202',
  'tornado-usdc-1000-1-0xa13464fc97d171d85a4431d79a2418d165dd1809bce3a86e8a56bb0fc7826d5ecf38d701edcef8fff69c74738884115fc1fd7851a33bf20fdd92d964edda',
]

async function makeDeposit({ note, proxy, instanceAddr }) {
  const noteObject = Note.fromString(note, instanceAddr, 1, 1)
  let valueETH = 0
  if (noteObject.currency == 'eth') {
    valueETH = ethers.utils.parseEther(noteObject.amount)
  }
  const receipt = await proxy.deposit(instanceAddr, toHex(noteObject.commitment), [], {
    value: valueETH,
  })
  return receipt
}

async function makeWithdraw({ note, proxy, recipient, relayerSigner, fee, instanceAddr }) {
  let cache = tornadoWithdrawalsCache[note]
  let proof, args
  if (!cache) {
    // await initEventsCache({ note: note, startBlock: 0, instanceAddr: instanceAddr })
    const noteObject = Note.fromString(note, instanceAddr, 1, 1)
    const deposit = createDeposit({ nullifier: noteObject.nullifier, secret: noteObject.secret })
    const instanceContract = await ethers.getContractAt(require('./abi/tornado.json'), instanceAddr)
    const filter = instanceContract.filters.Deposit()
    const eventsCache = require('./events/deposits_' +
      noteObject.currency +
      '_' +
      noteObject.amount +
      '.json')

    const depositEvents = await instanceContract.queryFilter(filter, config.snapshotBlockNumber + 1)

    ;({ proof, args } = await generateProof({
      deposit,
      recipient,
      events: eventsCache.concat(depositEvents),
      relayerAddress: relayerSigner._address || relayerSigner.address,
      fee,
    }))
    tornadoWithdrawalsCache[note] = { proof, args }
    fs.writeFileSync(
      './test/proofsCache/tornadoWithdrawalsCache.json',
      JSON.stringify(tornadoWithdrawalsCache, null, 2),
    )
  } else {
    ;({ proof, args } = cache)
  }
  const _proxy = proxy.connect(relayerSigner)
  const receipt = await _proxy.withdraw(instanceAddr, proof, ...args)
  return receipt
}

describe('General functionality tests', () => {
  // uncomment this line to run tests against node on localhost
  // ethers.provider = new ethers.providers.JsonRpcProvider(ethers.provider.connection.url)
  let snapshotId
  let proof
  let args

  //// CONTRACTS
  let torn = config.tokenAddresses.torn
  let dai = config.tokenAddresses.dai
  let gov
  let ensResolver
  let ensRegistry

  let feeManager
  let relayerRegistry
  let instanceRegistry
  let stakingRewards
  let tornadoRouter

  //// IMPERSONATED ACCOUNTS
  let tornWhale
  let daiWhale
  let cdaiWhale
  let usdtWhale
  let usdcWhale
  let wbtcWhale

  //// HELPER FN
  let getToken = async (tokenAddress) => {
    return await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20', tokenAddress)
  }

  let minewait = async (time) => {
    await ethers.provider.send('evm_increaseTime', [time])
    await ethers.provider.send('evm_mine', [])
  }

  before(async function () {
    //// INIT
    tornWhale = await getSignerFromAddress(config.whales.torn)
    daiWhale = await getSignerFromAddress(config.whales.dai)
    cdaiWhale = await getSignerFromAddress(config.whales.cdai)
    usdtWhale = await getSignerFromAddress(config.whales.usdt)
    usdcWhale = await getSignerFromAddress(config.whales.usdc)
    wbtcWhale = await getSignerFromAddress(config.whales.wbtc)

    ensResolver = new ethers.Contract(config.ensResolver, ensResolverAbi)
    const ensSigner = await getSignerFromAddress(config.ensController)
    ensResolver = ensResolver.connect(ensSigner)

    ensRegistry = new ethers.Contract(config.ensRegistry, ensRegistryAbi)
    ensRegistry = ensRegistry.connect(ensSigner)

    await initialize({ merkleTreeHeight: 20 })

    ///// CREATE2 BLOCK /////////////////////////////////////////////////////////////////////////
    const singletonFactory = await ethers.getContractAt(
      'SingletonFactory',
      config.singletonFactoryVerboseWrapper,
    )

    const contracts = await generate()
    await setupENS({ contracts, ensRegistry, ensResolver })

    await singletonFactory.deploy(contracts.tornadoRouter.bytecode, config.salt)
    tornadoRouter = await ethers.getContractAt('TornadoRouter', contracts.tornadoRouter.address)
    // receipt = await tx.wait()
    // console.log('receipt: ', receipt.events)

    await singletonFactory.deploy(contracts.feeManagerContract.implementation.bytecode, config.salt)
    await singletonFactory.deploy(contracts.feeManagerContract.proxy.bytecode, config.salt)
    feeManager = await ethers.getContractAt('FeeManager', contracts.feeManagerContract.proxy.address)

    await singletonFactory.deploy(contracts.relayerRegistryContract.implementation.bytecode, config.salt)
    await singletonFactory.deploy(contracts.relayerRegistryContract.proxy.bytecode, config.salt)
    relayerRegistry = await ethers.getContractAt(
      'RelayerRegistry',
      contracts.relayerRegistryContract.proxy.address,
    )

    await singletonFactory.deploy(contracts.stakingContract.implementation.bytecode, config.salt)
    await singletonFactory.deploy(contracts.stakingContract.proxy.bytecode, config.salt)
    stakingRewards = await ethers.getContractAt(
      'TornadoStakingRewards',
      contracts.stakingContract.proxy.address,
    )

    await singletonFactory.deploy(contracts.instanceRegistryContract.implementation.bytecode, config.salt)
    await singletonFactory.deploy(contracts.instanceRegistryContract.proxy.bytecode, config.salt)
    instanceRegistry = await ethers.getContractAt(
      'InstanceRegistry',
      contracts.instanceRegistryContract.proxy.address,
    )

    await singletonFactory.deploy(contracts.proposalContract.bytecode, config.salt, { gasLimit: 50000000 })
    const proposal = await ethers.getContractAt('RelayerRegistryProposal', contracts.proposalContract.address)

    //////////////////////////////////////////////////////////////////////////////////////////

    let response, id, state
    gov = (
      await ethers.getContractAt(
        'tornado-governance/contracts/v2-vault-and-gas/gas/GovernanceGasUpgrade.sol:GovernanceGasUpgrade',
        config.governance,
      )
    ).connect(tornWhale)

    await (
      await (await getToken(torn)).connect(tornWhale)
    ).approve(gov.address, ethers.utils.parseEther('1000000'))

    await gov.lockWithApproval(ethers.utils.parseEther('26000'))

    response = await gov.propose(proposal.address, 'Relayer Registry Proposal')
    id = await gov.latestProposalIds(tornWhale.address)
    state = await gov.state(id)

    const { events } = await response.wait()
    const args = events.find(({ event }) => event == 'ProposalCreated').args
    expect(args.id).to.be.equal(id)
    expect(args.proposer).to.be.equal(tornWhale.address)
    expect(args.target).to.be.equal(proposal.address)
    expect(args.description).to.be.equal('Relayer Registry Proposal')
    expect(state).to.be.equal(ProposalState.Pending)

    await minewait((await gov.VOTING_DELAY()).add(1).toNumber())
    await expect(gov.castVote(id, true)).to.not.be.reverted
    state = await gov.state(id)
    expect(state).to.be.equal(ProposalState.Active)
    await minewait(
      (
        await gov.VOTING_PERIOD()
      )
        .add(await gov.EXECUTION_DELAY())
        .add(96400)
        .toNumber(),
    )
    state = await gov.state(id)
    expect(state).to.be.equal(ProposalState.AwaitingExecution)

    await gov.execute(id)

    state = await gov.state(id)
    expect(state).to.be.equal(ProposalState.Executed)

    await addTWAPSlots()

    await feeManager.updateAllFees()
    snapshotId = await takeSnapshot()
  })

  describe('Instance functionality', () => {
    it('should allow to withdraw for whitelisted ETH instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1')
      const note = notes[1]

      const balanceBeforeDep = await ethers.provider.getBalance(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterDep = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterDep).to.be.equal(balanceBeforeDep.sub(txFee).sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: oneEthInstance,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterWith = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterWith).to.be.equal(balanceAfterDep.sub(txFee).add(value))
    })

    it('should allow to withdraw for whitelisted DAI instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1000')
      const note = notes[3]

      const daiToken = await (await getToken(dai)).connect(daiWhale)
      await daiToken.transfer(sender.address, value)
      await daiToken.connect(sender).approve(tornadoRouter.address, value)

      const ethBalanceBeforeDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeDep = await daiToken.balanceOf(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: config.instances[5].addr })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterDep = await daiToken.balanceOf(sender.address)
      expect(ethBalanceAfterDep).to.be.equal(ethBalanceBeforeDep.sub(txFee))
      expect(tokenBalanceAfterDep).to.be.equal(tokenBalanceBeforeDep.sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: config.instances[5].addr,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterWith = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterWith = await daiToken.balanceOf(sender.address)
      expect(ethBalanceAfterWith).to.be.equal(ethBalanceAfterDep.sub(txFee))
      expect(tokenBalanceAfterWith).to.be.equal(tokenBalanceBeforeDep)
    })

    it('should allow to withdraw for whitelisted cDAI instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.BigNumber.from('5000000000000')
      const note = notes[4]
      const instanceAddr = config.instances[9].addr

      const cdaiToken = await (await getToken(config.tokenAddresses.cdai)).connect(cdaiWhale)
      await cdaiToken.transfer(sender.address, value)
      await cdaiToken.connect(sender).approve(tornadoRouter.address, value)

      const ethBalanceBeforeDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeDep = await cdaiToken.balanceOf(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: instanceAddr })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterDep = await cdaiToken.balanceOf(sender.address)
      expect(ethBalanceAfterDep).to.be.equal(ethBalanceBeforeDep.sub(txFee))
      expect(tokenBalanceAfterDep).to.be.equal(tokenBalanceBeforeDep.sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: instanceAddr,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterWith = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterWith = await cdaiToken.balanceOf(sender.address)
      expect(ethBalanceAfterWith).to.be.equal(ethBalanceAfterDep.sub(txFee))
      expect(tokenBalanceAfterWith).to.be.equal(tokenBalanceBeforeDep)
    })

    it('should allow to withdraw for whitelisted USDT instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.BigNumber.from('1000000000')
      const note = notes[6]
      const instanceAddr = config.instances[15].addr

      const usdtToken = await (await getToken(config.tokenAddresses.usdt)).connect(usdtWhale)
      await usdtToken.transfer(sender.address, value)
      await usdtToken.connect(sender).approve(tornadoRouter.address, value)

      const ethBalanceBeforeDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeDep = await usdtToken.balanceOf(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: instanceAddr })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterDep = await usdtToken.balanceOf(sender.address)
      expect(ethBalanceAfterDep).to.be.equal(ethBalanceBeforeDep.sub(txFee))
      expect(tokenBalanceAfterDep).to.be.equal(tokenBalanceBeforeDep.sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: instanceAddr,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterWith = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterWith = await usdtToken.balanceOf(sender.address)
      expect(ethBalanceAfterWith).to.be.equal(ethBalanceAfterDep.sub(txFee))
      expect(tokenBalanceAfterWith).to.be.equal(tokenBalanceBeforeDep)
    })

    it('should allow to withdraw for whitelisted USDC instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.BigNumber.from('1000000000')
      const note = notes[7]
      const instanceAddr = config.instances[13].addr

      const usdcToken = await (await getToken(config.tokenAddresses.usdc)).connect(usdcWhale)
      await usdcToken.transfer(sender.address, value)
      await usdcToken.connect(sender).approve(tornadoRouter.address, value)

      const ethBalanceBeforeDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeDep = await usdcToken.balanceOf(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: instanceAddr })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterDep = await usdcToken.balanceOf(sender.address)
      expect(ethBalanceAfterDep).to.be.equal(ethBalanceBeforeDep.sub(txFee))
      expect(tokenBalanceAfterDep).to.be.equal(tokenBalanceBeforeDep.sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: instanceAddr,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterWith = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterWith = await usdcToken.balanceOf(sender.address)
      expect(ethBalanceAfterWith).to.be.equal(ethBalanceAfterDep.sub(txFee))
      expect(tokenBalanceAfterWith).to.be.equal(tokenBalanceBeforeDep)
    })

    it('should allow to withdraw for whitelisted WBTC instance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.BigNumber.from('10000000')
      const note = notes[5]
      const instanceAddr = config.instances[16].addr

      const wbtcToken = await (await getToken(config.tokenAddresses.wbtc)).connect(wbtcWhale)
      await wbtcToken.transfer(sender.address, value)
      await wbtcToken.connect(sender).approve(tornadoRouter.address, value)

      const ethBalanceBeforeDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeDep = await wbtcToken.balanceOf(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: instanceAddr })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterDep = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterDep = await wbtcToken.balanceOf(sender.address)
      expect(ethBalanceAfterDep).to.be.equal(ethBalanceBeforeDep.sub(txFee))
      expect(tokenBalanceAfterDep).to.be.equal(tokenBalanceBeforeDep.sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: instanceAddr,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterWith = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterWith = await wbtcToken.balanceOf(sender.address)
      expect(ethBalanceAfterWith).to.be.equal(ethBalanceAfterDep.sub(txFee))
      expect(tokenBalanceAfterWith).to.be.equal(tokenBalanceBeforeDep)
    })

    it('anonymity mining feature should work for instances with MINEABLE state', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1000')
      const note = notes[3]

      const daiToken = await (await getToken(dai)).connect(daiWhale)
      await daiToken.transfer(sender.address, value)
      await daiToken.connect(sender).approve(tornadoRouter.address, value)

      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: config.instances[5].addr })

      // router should call tornadoTrees contract which emits DepositData event
      let receipt = await tx.wait()
      expect(receipt.events[3].topics[0]).to.be.equal(
        '0xc711bd1d2cdd9c8978324cc83ce34c17f6ada898f8273efeb9585c1312d4ef67',
      )

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: config.instances[5].addr,
      })

      // WithdrawalData event in tornadoTrees contract
      receipt = await tx.wait()
      expect(receipt.events[2].topics[0]).to.be.equal(
        '0x5d3e96213d4520bdc95a25d628a39768f1a90a2b939894355479596910d179df',
      )
    })
  })

  describe('Governance functionality', () => {
    it('should be able to lock/unlock torn in governance', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1000')

      const tornToken = await (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(sender.address, value)
      await tornToken.connect(sender).approve(gov.address, value)

      const ethBalanceBeforeLock = await ethers.provider.getBalance(sender.address)
      const tokenBalanceBeforeLock = await tornToken.balanceOf(sender.address)
      let tx = await gov.connect(sender).lockWithApproval(value)

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterLock = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterLock = await tornToken.balanceOf(sender.address)
      expect(ethBalanceAfterLock).to.be.equal(ethBalanceBeforeLock.sub(txFee))
      expect(tokenBalanceAfterLock).to.be.equal(tokenBalanceBeforeLock.sub(value))

      const lockedBalanceAfterLock = await gov.lockedBalance(sender.address)
      expect(lockedBalanceAfterLock).to.be.equal(value)

      tx = await gov.connect(sender).unlock(value)

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const ethBalanceAfterUnlock = await ethers.provider.getBalance(sender.address)
      const tokenBalanceAfterUnlock = await tornToken.balanceOf(sender.address)
      expect(ethBalanceAfterUnlock).to.be.equal(ethBalanceAfterLock.sub(txFee))
      expect(tokenBalanceAfterUnlock).to.be.equal(tokenBalanceBeforeLock)

      const lockedBalanceAfterUnlock = await gov.lockedBalance(sender.address)
      expect(lockedBalanceAfterUnlock).to.be.equal(0)
    })

    it('should be able to propose a new proposal and works as expected', async () => {
      // add some dummy function the gov implementation and call it after the proposal passed
      const singletonFactory = await ethers.getContractAt(
        'SingletonFactory',
        config.singletonFactoryVerboseWrapper,
      )
      const ProposalFactory = await ethers.getContractFactory('TestProposal')
      const bytecode =
        ProposalFactory.bytecode +
        ProposalFactory.interface
          .encodeDeploy([config.gasCompLogic, config.tornadoVault, stakingRewards.address])
          .slice(2)
      let proposalAddress = ethers.utils.getCreate2Address(
        config.singletonFactory,
        config.salt,
        ethers.utils.keccak256(bytecode),
      )

      await singletonFactory.deploy(bytecode, config.salt, { gasLimit: 50000000 })
      const proposal = await ethers.getContractAt('TestProposal', proposalAddress)

      await (
        await (await getToken(torn)).connect(tornWhale)
      ).approve(gov.address, ethers.utils.parseEther('1000000'))

      await gov.lockWithApproval(ethers.utils.parseEther('26000'))
      const tx = await gov.propose(proposalAddress, 'Test Proposal')
      const id = await gov.latestProposalIds(tornWhale.address)
      let state = await gov.state(id)

      const { events } = await tx.wait()
      const args = events.find(({ event }) => event == 'ProposalCreated').args
      expect(args.id).to.be.equal(id)
      expect(args.proposer).to.be.equal(tornWhale.address)
      expect(args.target).to.be.equal(proposal.address)
      expect(args.description).to.be.equal('Test Proposal')
      expect(state).to.be.equal(ProposalState.Pending)

      await minewait((await gov.VOTING_DELAY()).add(1).toNumber())
      await expect(gov.castVote(id, true)).to.not.be.reverted
      state = await gov.state(id)
      expect(state).to.be.equal(ProposalState.Active)
      await minewait(
        (
          await gov.VOTING_PERIOD()
        )
          .add(await gov.EXECUTION_DELAY())
          .add(96400)
          .toNumber(),
      )
      state = await gov.state(id)
      expect(state).to.be.equal(ProposalState.AwaitingExecution)

      await gov.execute(id)

      state = await gov.state(id)
      expect(state).to.be.equal(ProposalState.Executed)

      const newGov = (await ethers.getContractAt('TestGovernanceUpgrade', config.governance)).connect(
        tornWhale,
      )

      expect(await newGov.test()).to.be.equal(231)
    })

    it('the old tornado proxy should be really disabled after proposal execution', async () => {
      const tornadoProxy = await ethers.getContractAt(tornadoProxyPath, config.tornadoProxy)

      for (const instance of config.instances) {
        const instanceData = await tornadoProxy.instances(instance.addr)
        expect(instanceData.isERC20).to.be.equal(false)
        expect(instanceData.token).to.be.equal('0x0000000000000000000000000000000000000000')
        expect(instanceData.state).to.be.equal(0)
      }
    })
  })

  describe('RelayerRegistry contract', () => {
    it('constructor', async () => {
      expect(await relayerRegistry.torn()).to.be.equal(torn)
      expect(await relayerRegistry.governance()).to.be.equal(config.governance)
      expect(await relayerRegistry.feeManager()).to.be.equal(feeManager.address)
      expect(await relayerRegistry.tornadoRouter()).to.be.equal(tornadoRouter.address)
      expect(await relayerRegistry.staking()).to.be.equal(stakingRewards.address)
    })

    it('should allow to register', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)
      const tokenBalanceBeforeRegister = await tornToken.balanceOf(relayerAddress)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      const tokenBalanceAfterRegister = await tornToken.balanceOf(relayerAddress)
      expect(tokenBalanceAfterRegister).to.be.equal(tokenBalanceBeforeRegister.sub(stake))

      const relayerState = await relayerRegistry.relayers(relayerAddress)
      expect(await relayerState.balance).to.be.equal(stake)
      expect(await relayerState.ensHash).to.be.equal(namehash.hash(relayerENS))

      expect(await relayerRegistry.workers(worker.address)).to.be.equal(relayerAddress)
    })

    it('should allow to register with permit', async () => {
      const privateKey = '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3'
      const publicKey = '0x' + ethers.utils.computeAddress(Buffer.from(privateKey.slice(2), 'hex'))
      const relayer = await ethers.getSigner(publicKey.slice(2))
      const relayerAddress = relayer.address
      const relayerENS = 'relayer.contract.tornadocash.eth'

      const [sender, worker] = await ethers.getSigners()
      const stake = ethers.utils.parseEther('300')

      // register new relayer in ENS
      const [label] = relayerENS.split('.')
      await ensRegistry.setSubnodeRecord(
        namehash.hash('contract.tornadocash.eth'),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label)),
        relayerAddress,
        ensResolver.address,
        0,
      )

      await sender.sendTransaction({ to: relayerAddress, value: ethers.utils.parseEther('1.0') })
      await ensResolver
        .connect(await getSignerFromAddress(relayerAddress))
        ['setAddr(bytes32,address)'](namehash.hash(relayerENS), relayerAddress)
      expect(await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))).to.be.equal(relayerAddress)

      // send TORN to relayer
      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayerAddress, stake)
      const tokenBalanceBeforeRegister = await tornToken.balanceOf(relayerAddress)

      // prepare permit data
      const domain = {
        name: await tornToken.name(),
        version: '1',
        chainId: 1,
        verifyingContract: tornToken.address,
      }

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        owner: relayer,
        spender: relayerRegistry.address,
        value: stake,
        nonce: 0,
        deadline: curTimestamp + 1000,
      }

      const permitSigner = new PermitSigner(domain, args)
      const signature = await permitSigner.getSignature(privateKey)
      const signer = await permitSigner.getSignerAddress(args, signature.hex)
      expect(signer).to.equal(relayerAddress)

      // call registration
      await relayerRegistry
        .connect(sender)
        .registerPermit(
          relayerENS,
          stake,
          [worker.address],
          args.owner,
          args.deadline.toString(),
          signature.v,
          signature.r,
          signature.s,
        )

      // check registration
      const tokenBalanceAfterRegister = await tornToken.balanceOf(relayerAddress)
      expect(tokenBalanceAfterRegister).to.be.equal(tokenBalanceBeforeRegister.sub(stake))

      const relayerState = await relayerRegistry.relayers(relayerAddress)
      expect(await relayerState.balance).to.be.equal(stake)
      expect(await relayerState.ensHash).to.be.equal(namehash.hash(relayerENS))

      expect(await relayerRegistry.workers(worker.address)).to.be.equal(relayerAddress)
    })

    it('should be able to withdraw using registered relayer', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)

      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      const relayerStateBefore = await relayerRegistry.relayers(relayer._address)
      const protocolFee = await feeManager.instanceFee(oneEthInstance)

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const relayerStateAfter = await relayerRegistry.relayers(relayer._address)
      expect(relayerStateAfter.balance).to.be.equal(relayerStateBefore.balance.sub(protocolFee))

      const tornadoVaultBalance = await tornToken.balanceOf(config.tornadoVault)
      const lockedBalance = await gov.lockedBalance(tornWhale.address)
      const whaleBalanceBefore = await tornToken.balanceOf(tornWhale.address)
      const unlockTimestamp = await gov.canWithdrawAfter(tornWhale.address)
      await minewait(unlockTimestamp.toNumber())
      await gov.unlock(lockedBalance)
      const whaleBalanceAfter = await tornToken.balanceOf(tornWhale.address)
      expect(whaleBalanceAfter).to.be.equal(whaleBalanceBefore.add(lockedBalance))

      const balanceBeforeReward = await tornToken.balanceOf(tornWhale.address)
      await stakingRewards.connect(tornWhale).getReward()
      const balanceAfterReward = await tornToken.balanceOf(tornWhale.address)
      const whaleReward = protocolFee.mul(lockedBalance).div(tornadoVaultBalance)
      expect(balanceAfterReward).to.be.equal(balanceBeforeReward.add(whaleReward))
    })

    it('should be able to register a worker and withdraw using it', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      const relayerStateBefore = await relayerRegistry.relayers(relayer._address)
      const protocolFee = await feeManager.instanceFee(oneEthInstance)

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: worker,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const relayerStateAfter = await relayerRegistry.relayers(relayer._address)
      expect(relayerStateAfter.balance).to.be.equal(relayerStateBefore.balance.sub(protocolFee))

      const tornadoVaultBalance = await tornToken.balanceOf(config.tornadoVault)
      const lockedBalance = await gov.lockedBalance(tornWhale.address)
      const whaleBalanceBefore = await tornToken.balanceOf(tornWhale.address)
      const unlockTimestamp = await gov.canWithdrawAfter(tornWhale.address)
      await minewait(unlockTimestamp.toNumber())
      await gov.unlock(lockedBalance)
      const whaleBalanceAfter = await tornToken.balanceOf(tornWhale.address)
      expect(whaleBalanceAfter).to.be.equal(whaleBalanceBefore.add(lockedBalance))

      const balanceBeforeReward = await tornToken.balanceOf(tornWhale.address)
      await stakingRewards.connect(tornWhale).getReward()
      const balanceAfterReward = await tornToken.balanceOf(tornWhale.address)
      const whaleReward = protocolFee.mul(lockedBalance).div(tornadoVaultBalance)
      expect(balanceAfterReward).to.be.equal(balanceBeforeReward.add(whaleReward))
    })

    it('should be able to register a worker after initial registration', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [worker1, worker2] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker1.address])

      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker1.address)).to.be.true
      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker2.address)).to.be.false

      await relayerRegistry.connect(relayer).registerWorker(relayerAddress, worker2.address)

      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker1.address)).to.be.true
      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker2.address)).to.be.true
    })

    it('should be able to unregister a worker', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker.address)).to.be.true

      await relayerRegistry.connect(relayer).unregisterWorker(worker.address)

      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, worker.address)).to.be.false
    })

    it('should be able to withdraw without relayer', async () => {
      const [sender] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1')
      const note = notes[1]

      const balanceBeforeDep = await ethers.provider.getBalance(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterDep = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterDep).to.be.equal(balanceBeforeDep.sub(txFee).sub(value))

      // no relayer
      sender._address = '0x0000000000000000000000000000000000000000'

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: sender,
        fee: 0,
        instanceAddr: oneEthInstance,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterWith = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterWith).to.be.equal(balanceAfterDep.sub(txFee).add(value))
    })

    it('should revert for insufficient relayer stake', async () => {
      // set low min stake
      const govSigner = await getSignerFromAddress(config.governance)
      await relayerRegistry.connect(govSigner).setMinStakeAmount(1) // 1 wei

      const relayerENS = 'defidevotee.eth'
      const stake = 1 // 1 wei
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)

      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      const relayerStateBefore = await relayerRegistry.relayers(relayer._address)

      let cache = tornadoWithdrawalsCache[note]
      ;({ proof, args } = cache)
      await expect(tornadoRouter.connect(relayer).withdraw(oneEthInstance, proof, ...args)).to.be.reverted

      const relayerStateAfter = await relayerRegistry.relayers(relayer._address)
      expect(relayerStateAfter.balance).to.be.equal(relayerStateBefore.balance)
    })

    it('should NOT revert for unregistered relayer (custom relayer UI feature)', async () => {
      const [sender, customRelayer] = await ethers.getSigners()
      const value = ethers.utils.parseEther('1')
      const note = notes[2]
      const relayerFee = ethers.utils.parseEther('0.1')

      const balanceBeforeDep = await ethers.provider.getBalance(sender.address)
      let tx = await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      let receipt = await tx.wait()
      let txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterDep = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterDep).to.be.equal(balanceBeforeDep.sub(txFee).sub(value))
      const relayerBalanceBeforeWith = await ethers.provider.getBalance(customRelayer.address)

      tx = await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: customRelayer,
        fee: relayerFee,
        instanceAddr: oneEthInstance,
      })

      receipt = await tx.wait()
      txFee = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      const balanceAfterWith = await ethers.provider.getBalance(sender.address)
      expect(balanceAfterWith).to.be.equal(balanceAfterDep.add(value).sub(relayerFee))
      const relayerBalanceAfterWith = await ethers.provider.getBalance(customRelayer.address)
      expect(relayerBalanceAfterWith).to.be.equal(relayerBalanceBeforeWith.add(relayerFee).sub(txFee))
    })

    it('should revert for unregistered worker of registered relayer', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [, worker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      const relayerStateBefore = await relayerRegistry.relayers(relayer._address)

      let cache = tornadoWithdrawalsCache[note]
      ;({ proof, args } = cache)
      await expect(tornadoRouter.connect(worker).withdraw(oneEthInstance, proof, ...args)).to.be.reverted

      const relayerStateAfter = await relayerRegistry.relayers(relayer._address)
      expect(relayerStateAfter.balance).to.be.equal(relayerStateBefore.balance)
    })

    it('should nullify relayer balance by governance', async () => {
      // init gov signer
      const govSigner = await getSignerFromAddress(config.governance)

      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])
      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, relayerAddress)).to.be.true

      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake)
      await expect(relayerRegistry.nullifyBalance(relayerAddress)).to.be.reverted
      await relayerRegistry.connect(govSigner).nullifyBalance(relayerAddress)
      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(0)

      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, relayerAddress)).to.be.true
    })

    it('should be able to stake to some relayer', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake.mul(2))
      await tornToken.approve(relayerRegistry.address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake.mul(2))

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])
      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, relayerAddress)).to.be.true

      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake)
      await relayerRegistry.connect(relayer).stakeToRelayer(relayerAddress, stake)
      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake.mul(2))
      await relayerRegistry.connect(tornWhale).stakeToRelayer(relayerAddress, stake)
      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake.mul(3))
    })

    it('should be able to stake to some relayer with permit', async () => {
      const privateKey = '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3'
      const publicKey = '0x' + ethers.utils.computeAddress(Buffer.from(privateKey.slice(2), 'hex'))
      const staker = await ethers.getSigner(publicKey.slice(2))
      const stakerAddress = staker.address

      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender] = await ethers.getSigners()

      // send TORN to staker
      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(stakerAddress, stake)
      const tokenBalanceBeforeRegister = await tornToken.balanceOf(stakerAddress)
      await tornToken.transfer(relayerAddress, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      // prepare permit data
      const domain = {
        name: await tornToken.name(),
        version: '1',
        chainId: 1,
        verifyingContract: tornToken.address,
      }

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        owner: staker,
        spender: relayerRegistry.address,
        value: stake,
        nonce: 0,
        deadline: curTimestamp + 1000,
      }

      const permitSigner = new PermitSigner(domain, args)
      const signature = await permitSigner.getSignature(privateKey)
      const signer = await permitSigner.getSignerAddress(args, signature.hex)
      expect(signer).to.equal(stakerAddress)

      // call registration
      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])
      expect(await relayerRegistry.isRelayerRegistered(relayerAddress, relayerAddress)).to.be.true

      // stake to
      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake)

      await relayerRegistry
        .connect(sender)
        .stakeToRelayerPermit(
          relayerAddress,
          stake,
          stakerAddress,
          args.deadline.toString(),
          signature.v,
          signature.r,
          signature.s,
        )

      expect(await relayerRegistry.getRelayerBalance(relayerAddress)).to.equal(stake.mul(2))
      expect(await tornToken.balanceOf(stakerAddress)).to.be.equal(tokenBalanceBeforeRegister.sub(stake))
    })
  })

  describe('InstancesRegistry contract', () => {
    it('constructor', async () => {
      expect(await instanceRegistry.governance()).to.be.equal(config.governance)
      expect(await instanceRegistry.router()).to.be.equal(tornadoRouter.address)
    })

    it('gov should be able to remove instance', async () => {
      const daiToken = await (await getToken(dai)).connect(daiWhale)
      const govSigner = await getSignerFromAddress(config.governance)

      const instanceAddr = await instanceRegistry.instanceIds(4)
      const instanceState = await instanceRegistry.instances(instanceAddr)
      expect(instanceState.state).to.be.equal(2)

      expect(await daiToken.allowance(tornadoRouter.address, instanceAddr)).to.be.equal(
        ethers.constants.MaxUint256,
      )

      await instanceRegistry.connect(govSigner).removeInstance(4)

      const instanceStateAfter = await instanceRegistry.instances(instanceAddr)
      expect(instanceStateAfter.state).to.be.equal(0)
      expect(await daiToken.allowance(tornadoRouter.address, instanceAddr)).to.be.equal(0)
    })

    it('gov should be able to add instance', async () => {
      const daiToken = await (await getToken(dai)).connect(daiWhale)
      const govSigner = await getSignerFromAddress(config.governance)

      const tornados = await instanceRegistry.getAllInstances()
      const instanceAddr = tornados[4].addr
      expect(tornados[4].instance.state).to.be.equal(2)
      expect(await daiToken.allowance(tornadoRouter.address, instanceAddr)).to.be.equal(
        ethers.constants.MaxUint256,
      )

      await instanceRegistry.connect(govSigner).removeInstance(4)

      const instanceStateAfterRem = await instanceRegistry.instances(instanceAddr)
      expect(instanceStateAfterRem.state).to.be.equal(0)
      expect(await daiToken.allowance(tornadoRouter.address, instanceAddr)).to.be.equal(0)

      await instanceRegistry.connect(govSigner).updateInstance(tornados[4])

      const instanceStateAfterAdd = await instanceRegistry.instances(instanceAddr)
      expect(instanceStateAfterAdd.state).to.be.equal(2)
      expect(await daiToken.allowance(tornadoRouter.address, instanceAddr)).to.be.equal(
        ethers.constants.MaxUint256,
      )
    })

    it('gov should be able to update instance', async () => {
      const govSigner = await getSignerFromAddress(config.governance)

      let tornados = await instanceRegistry.getAllInstances()
      expect(tornados[0].instance.state).to.be.equal(2)
      const updatedTornado = {
        addr: tornados[0].addr,
        instance: {
          isERC20: tornados[0].instance.isERC20,
          token: tornados[0].instance.token,
          state: 1,
          uniswapPoolSwappingFee: tornados[0].instance.uniswapPoolSwappingFee,
          protocolFeePercentage: tornados[0].instance.protocolFeePercentage,
        },
      }

      await instanceRegistry.connect(govSigner).updateInstance(updatedTornado)

      const instanceStateAfter = await instanceRegistry.instances(tornados[0].addr)
      expect(instanceStateAfter.state).to.be.equal(1)
    })
  })

  describe('StakingRewards contract', () => {
    it('constructor', async () => {
      expect(await stakingRewards.torn()).to.be.equal(torn)
      expect(await stakingRewards.Governance()).to.be.equal(config.governance)
      expect(await stakingRewards.relayerRegistry()).to.be.equal(relayerRegistry.address)
      expect(await stakingRewards.ratioConstant()).to.be.equal(ethers.utils.parseEther('10000000'))
    })

    it('should be able to lock torn in governance after the proposal and get reward according to the share', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender, worker, staker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.transfer(staker.address, stake)
      await tornToken.connect(staker).approve(gov.address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await gov.connect(staker).lockWithApproval(stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const tornadoVaultBalance = await tornToken.balanceOf(config.tornadoVault)
      const lockedBalance = await gov.lockedBalance(staker.address)
      const stakerBalanceBefore = await tornToken.balanceOf(staker.address)
      await gov.connect(staker).unlock(lockedBalance)
      const stakerBalanceAfter = await tornToken.balanceOf(staker.address)
      expect(stakerBalanceAfter).to.be.equal(stakerBalanceBefore.add(lockedBalance))

      const balanceBeforeReward = await tornToken.balanceOf(staker.address)
      await stakingRewards.connect(staker).getReward()
      const balanceAfterReward = await tornToken.balanceOf(staker.address)
      const protocolFee = await feeManager.instanceFee(oneEthInstance)
      const stakerReward = protocolFee.mul(lockedBalance).div(tornadoVaultBalance)
      expect(balanceAfterReward).to.be.equal(balanceBeforeReward.add(stakerReward))

      // second harvest shouldnt work if no withdraw was made
      await stakingRewards.connect(staker).getReward()
      expect(await tornToken.balanceOf(staker.address)).to.be.equal(balanceAfterReward)
    })

    it('should call a lockWithApproval(0) for a signer and have incremented rewards', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender, , staker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.transfer(staker.address, stake)
      await tornToken.connect(staker).approve(gov.address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await gov.connect(staker).lockWithApproval(stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      // should call a lockWithApproval(0) for a signer and have incremented some of his rewards
      expect(await stakingRewards.accumulatedRewards(staker.address)).to.be.equal(0)
      await gov.connect(staker).lockWithApproval(0)
      const rewardBeforeawaitGetReward = await stakingRewards.accumulatedRewards(staker.address)

      const tornadoVaultBalance = await tornToken.balanceOf(config.tornadoVault)
      const lockedBalance = await gov.lockedBalance(staker.address)
      const stakerBalanceBefore = await tornToken.balanceOf(staker.address)
      await gov.connect(staker).unlock(lockedBalance)
      const stakerBalanceAfter = await tornToken.balanceOf(staker.address)
      expect(stakerBalanceAfter).to.be.equal(stakerBalanceBefore.add(lockedBalance))

      const balanceBeforeReward = await tornToken.balanceOf(staker.address)
      await stakingRewards.connect(staker).getReward()
      const balanceAfterReward = await tornToken.balanceOf(staker.address)
      const protocolFee = await feeManager.instanceFee(oneEthInstance)
      const stakerReward = protocolFee.mul(lockedBalance).div(tornadoVaultBalance)
      expect(balanceAfterReward).to.be.equal(balanceBeforeReward.add(stakerReward))
      expect(stakerReward).to.be.equal(rewardBeforeawaitGetReward)
    })

    it('checkReward method', async () => {
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)
      const [sender, worker, staker] = await ethers.getSigners()

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.transfer(staker.address, stake)
      await tornToken.connect(staker).approve(gov.address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)

      await gov.connect(staker).lockWithApproval(stake)

      await relayerRegistry.connect(relayer).register(relayerENS, stake, [worker.address])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const tornadoVaultBalance = await tornToken.balanceOf(config.tornadoVault)
      const lockedBalance = await gov.lockedBalance(staker.address)
      const protocolFee = await feeManager.instanceFee(oneEthInstance)
      const stakerReward = protocolFee.mul(lockedBalance).div(tornadoVaultBalance)
      expect(await stakingRewards.checkReward(staker.address)).to.be.equal(stakerReward)

      // it should be the same after unlock
      await gov.connect(staker).unlock(lockedBalance)
      expect(await stakingRewards.checkReward(staker.address)).to.be.equal(stakerReward)

      // it should be zero after getReward call
      await stakingRewards.connect(staker).getReward()
      expect(await stakingRewards.checkReward(staker.address)).to.be.equal(0)
    })
  })

  describe('FeeManager contract', () => {
    it('constructor', async () => {
      expect(await feeManager.torn()).to.be.equal(torn)
      expect(await feeManager.governance()).to.be.equal(config.governance)
      expect(await feeManager.registry()).to.be.equal(instanceRegistry.address)
      expect(await feeManager.uniswapTimePeriod()).to.be.equal(5400)
    })

    it('protocol fees should be updated on withdrawal when time has come', async () => {
      // pamp TORN price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)
      const [sender] = await ethers.getSigners()

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['weth'],
        tokenOut: config.tokenAddresses['torn'],
        fee: 10000, // TORN/ETH 1% pool
        recipient: sender.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('20'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(sender).exactInputSingle(args, { value: ethers.utils.parseEther('20') })

      await minewait(config.UpdateFeeTimeLimit + 1)

      const feeBefore = await feeManager.instanceFee(oneEthInstance)

      // create withdrawal with registrated relayer
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)
      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const feeAfter = await feeManager.instanceFee(oneEthInstance)
      expect(feeAfter).to.be.lt(feeBefore)
    })

    it('protocol fees should not be updated on withdrawal when time has not come', async () => {
      // pamp TORN price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)
      const [sender] = await ethers.getSigners()

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['weth'],
        tokenOut: config.tokenAddresses['torn'],
        fee: 10000, // TORN/ETH 1% pool
        recipient: sender.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('20'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(sender).exactInputSingle(args, { value: ethers.utils.parseEther('20') })

      await minewait(config.TWAPPeriod)

      const feeBefore = await feeManager.instanceFee(oneEthInstance)

      // create withdrawal with registrated relayer
      const relayerENS = 'defidevotee.eth'
      const stake = ethers.utils.parseEther('300')
      const note = notes[0]

      const relayerAddress = await ensResolver['addr(bytes32)'](namehash.hash(relayerENS))
      const relayer = await getSignerFromAddress(relayerAddress)

      let tornToken = (await getToken(torn)).connect(tornWhale)
      await tornToken.transfer(relayer._address, stake)
      await tornToken.connect(relayer).approve(relayerRegistry.address, stake)
      await relayerRegistry.connect(relayer).register(relayerENS, stake, [])

      await makeDeposit({ note: note, proxy: tornadoRouter, instanceAddr: oneEthInstance })

      await makeWithdraw({
        note: note,
        proxy: tornadoRouter,
        recipient: sender.address,
        relayerSigner: relayer,
        fee: ethers.utils.parseEther('0.1'),
        instanceAddr: oneEthInstance,
      })

      const feeAfter = await feeManager.instanceFee(oneEthInstance)
      expect(feeAfter).to.be.equal(feeBefore)
    })

    it('anyone should be able to update cached protocol fees for each instance', async () => {
      const feeBefore = await feeManager.instanceFee(config.instances[6].addr)

      await feeManager.updateAllFees()

      const feeAfter = await feeManager.instanceFee(config.instances[6].addr)
      expect(feeAfter).to.be.equal(feeBefore)
    })

    it('anyone should be able to update cached protocol fees after price goes down', async () => {
      // pamp DAI price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)
      const [sender] = await ethers.getSigners()

      // deploy price tester
      // await singletonFactory.deploy(bytecode, config.salt, { gasLimit: 50000000 })
      // const priceTester = await ethers.getContractAt('PriceTester', priceTesterAddress)
      // await priceTester.getPriceOfTokenInETH(config.tokenAddresses['dai'], 3000, config.TWAPPeriod)
      // daiPriceBefore = await priceTester.lastPriceOfToken(config.tokenAddresses['dai'])
      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['weth'],
        tokenOut: config.tokenAddresses['dai'],
        fee: config.instances[6].instance.uniswapPoolSwappingFee,
        recipient: sender.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('500'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(sender).exactInputSingle(args, { value: ethers.utils.parseEther('1500') })

      await minewait(config.TWAPPeriod)

      const feeBefore = await feeManager.instanceFee(config.instances[6].addr)

      await feeManager.updateAllFees()

      const feeAfter = await feeManager.instanceFee(config.instances[6].addr)
      expect(feeAfter).to.be.gt(feeBefore)
    })

    it('anyone should be able to update cached protocol fees after price goes up', async () => {
      // damp DAI price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)

      const daiToken = await (await getToken(dai)).connect(daiWhale)
      await daiToken.approve(config.uniswapRouter, ethers.utils.parseEther('5000000'))

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['dai'],
        tokenOut: config.tokenAddresses['weth'],
        fee: config.instances[6].instance.uniswapPoolSwappingFee,
        recipient: daiWhale.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('500000'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(daiWhale).exactInputSingle(args)

      await minewait(config.TWAPPeriod)

      const feeBefore = await feeManager.instanceFee(config.instances[6].addr)

      await feeManager.updateAllFees()

      const feeAfter = await feeManager.instanceFee(config.instances[6].addr)
      expect(feeAfter).to.be.lt(feeBefore)
    })

    it('feeDeviations() function should work correctly', async () => {
      let deviations = await feeManager.feeDeviations()
      for (const dev of deviations) {
        expect(dev.deviation).to.be.equal(0)
      }

      // damp DAI price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)

      const daiToken = await (await getToken(dai)).connect(daiWhale)
      await daiToken.approve(config.uniswapRouter, ethers.utils.parseEther('5000000'))

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['dai'],
        tokenOut: config.tokenAddresses['weth'],
        fee: config.instances[6].instance.uniswapPoolSwappingFee,
        recipient: daiWhale.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('5000000'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(daiWhale).exactInputSingle(args)

      await minewait(config.TWAPPeriod)

      deviations = await feeManager.feeDeviations()
      expect(deviations[6].deviation).to.be.gt(0)
      // console.log(deviations[6].deviation.toString())

      await feeManager.updateAllFees()

      deviations = await feeManager.feeDeviations()
      expect(deviations[6].deviation).to.be.equal(0)
    })

    it('anyone should be able to update cached protocol fees for single instance', async () => {
      // pamp DAI price
      const uniswapRouter = new ethers.Contract(config.uniswapRouter, uniswapRouterAbi)
      const [sender] = await ethers.getSigners()

      const curTimestamp = Math.trunc(new Date().getTime() / 1000)
      const args = {
        tokenIn: config.tokenAddresses['weth'],
        tokenOut: config.tokenAddresses['dai'],
        fee: config.instances[6].instance.uniswapPoolSwappingFee,
        recipient: sender.address,
        deadline: curTimestamp + 1000,
        amountIn: ethers.utils.parseEther('500'),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      await uniswapRouter.connect(sender).exactInputSingle(args, { value: ethers.utils.parseEther('1500') })

      await minewait(config.TWAPPeriod)

      const feeBefore = await feeManager.instanceFee(config.instances[6].addr)

      await feeManager.updateFee(config.instances[6].addr)
      // var tx = await feeManager.updateFee(config.instances[6].addr)
      // var receipt = await ethers.provider.getTransactionReceipt(tx.hash);
      // console.log(`updateFee() method spent ${receipt.gasUsed} GAS`)

      const feeAfter = await feeManager.instanceFee(config.instances[6].addr)
      expect(feeAfter).to.be.gt(feeBefore)
    })
  })

  describe('TornadoRouter contract', () => {
    it('constructor', async () => {
      expect(await tornadoRouter.governance()).to.be.equal(config.governance)
      expect(await tornadoRouter.instanceRegistry()).to.be.equal(instanceRegistry.address)
      expect(await tornadoRouter.relayerRegistry()).to.be.equal(relayerRegistry.address)
      expect(await tornadoRouter.tornadoTrees()).to.be.equal(config.tornadoTrees)
    })

    it('gov should be able to claim junk and accidentally sent tokens', async () => {
      const amount = ethers.utils.parseEther('100')

      let tornToken = (await getToken(torn)).connect(tornWhale)
      expect(await tornToken.balanceOf(tornadoRouter.address)).to.be.equal(0)
      const tokenBalanceBefore = await tornToken.balanceOf(tornWhale.address)

      await tornToken.transfer(tornadoRouter.address, amount)
      expect(await tornToken.balanceOf(tornadoRouter.address)).to.be.equal(amount)

      const govSigner = await getSignerFromAddress(config.governance)
      await tornadoRouter.connect(govSigner).rescueTokens(torn, tornWhale.address, amount)

      expect(await tornToken.balanceOf(tornadoRouter.address)).to.be.equal(0)
      expect(await tornToken.balanceOf(tornWhale.address)).to.be.equal(tokenBalanceBefore)
    })
  })

  afterEach(async () => {
    await revertSnapshot(snapshotId)
    snapshotId = await takeSnapshot()
  })
})

// async function initEventsCache({note, startBlock, instanceAddr }) {
//   const noteObject = Note.fromString(note, instanceAddr, 1, 1)
//   const instanceContract = await ethers.getContractAt(require('./abi/tornado.json'), instanceAddr)
//   const filter = instanceContract.filters.Deposit()
//   const rawEvents = await instanceContract.queryFilter(filter, startBlock)
//   let events = []
//   for (const rawEvent of rawEvents) {
//     console.log(rawEvent.args.leafIndex)
//     let timestamp = (await ethers.provider.getBlock(rawEvent.blockNumber)).timestamp
//     events.push({
//       args: {
//         blockNumber: rawEvent.blockNumber,
//         transactionHash: rawEvent.transactionHash,
//         commitment: rawEvent.args[0],
//         leafIndex: rawEvent.args[1],
//         timestamp: timestamp.toString(),
//       },
//     })
//   }
//   fs.writeFileSync(
//     './test/events/deposits_' + noteObject.currency + '_' + noteObject.amount + '.json',
//     JSON.stringify(events, null, 2),
//   )
// }
