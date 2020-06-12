const {contract, accounts, web3} = require("@openzeppelin/test-environment")
const {expectRevert, expectEvent, time} = require("@openzeppelin/test-helpers")
const {createSnapshot, restoreSnapshot} = require('../helpers/snapshot');

const {grantTokens, grantTokensToManagedGrant} = require('../helpers/grantTokens');

const KeepToken = contract.fromArtifact('KeepToken')
const TokenGrant = contract.fromArtifact('TokenGrant')
const PermissiveStakingPolicy = contract.fromArtifact('PermissiveStakingPolicy')
const ManagedGrantFactory = contract.fromArtifact('ManagedGrantFactory')
const ManagedGrant = contract.fromArtifact('ManagedGrant')
const TokenStakingEscrow = contract.fromArtifact('TokenStakingEscrow')

const BN = web3.utils.BN
const chai = require('chai')
chai.use(require('bn-chai')(BN))
const expect = chai.expect

describe('TokenStakingEscrow', () => {
  
  const owner = accounts[0],
    grantee = accounts[1],
    operator = accounts[2],
    operator2 = accounts[3]

  let grantedAmount, grantStart, grantUnlockingDuration,
  grantId, managedGrantId, managedGrant

  let token, tokenGrant, permissivePolicy, managedGrantFactory, escrow

  before(async () => {
    token = await KeepToken.new({from: owner})
    tokenGrant = await TokenGrant.new(token.address, {from: owner})
    permissivePolicy = await PermissiveStakingPolicy.new()
    managedGrantFactory = await ManagedGrantFactory.new(
      token.address,
      tokenGrant.address,
      {from: owner}
    );
    
    escrow = await TokenStakingEscrow.new(
      token.address, 
      tokenGrant.address,
      owner, // set the owner as TokenStaking address for test simplicity
      {from: owner}
    )

    grantedAmount = 10000
    grantStart = await time.latest()
    grantCliff = time.duration.days(5)
    grantUnlockingDuration = time.duration.days(30)
    
    grantId = await grantTokens(
      tokenGrant, 
      token, 
      grantedAmount, 
      owner, 
      grantee, 
      grantUnlockingDuration,
      grantStart,
      grantCliff,
      true,
      permissivePolicy.address
    )

    const managedGrantAddress = await grantTokensToManagedGrant(
      managedGrantFactory,
      token,
      grantedAmount,
      owner,
      grantee,
      grantUnlockingDuration,
      grantStart,
      grantCliff,
      false,
      permissivePolicy.address,
    )
    managedGrant = await ManagedGrant.at(managedGrantAddress)
    managedGrantId = (await managedGrant.grantId()).toNumber()
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe('receiveApproval', async () => {
    it('reverts for unknown token', async () => {
      let anotherToken = await KeepToken.new({from: owner})
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )

      await expectRevert(
        anotherToken.approveAndCall(
            escrow.address, grantedAmount, data, {from: owner}
        ),
        "Not a KEEP token"
      )
    })

    it('reverts for corrupted extraData', async () => {
      const corruptedData = web3.eth.abi.encodeParameters(
        ['address'], [operator]
      )

      await expectRevert(
        token.approveAndCall(
            escrow.address, grantedAmount, corruptedData, {from: owner}
        ),
        "Unexpected data length"
      )
    })

    it('reverts for unknown grant', async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, 999]
      )

      await expectRevert(
        token.approveAndCall(
            escrow.address, grantedAmount, data, {from: owner}
        ),
        "Grant with this ID does not exist"
      )
    })

    it('deposits KEEP', async () => {    
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )
      await token.approveAndCall(
        escrow.address, grantedAmount, data, {from: owner}
      )

      const deposited = await escrow.depositedAmount(operator)
      expect(deposited).to.eq.BN(grantedAmount)
    })

    it('can not be called by anyone but staking contract', async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )

      await expectRevert(
        token.approveAndCall(
          escrow.address, grantedAmount, data, {from: operator}
        ),
        "Only staking contract can deposit"
      )
      await expectRevert(
        token.approveAndCall(
          escrow.address, grantedAmount, data, {from: grantee}
        ),
        "Only staking contract can deposit"
      )
    })
  })

  describe('depositedAmount', async () => {
    it('returns 0 for unknown operator', async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )
      await token.approveAndCall(
        escrow.address, grantedAmount, data, {from: owner}
      )

      const deposited = await escrow.depositedAmount(grantee)
      expect(deposited).to.eq.BN(0)   
    })
  })

  describe('withdrawable', async () => {
    const depositedAmount = 1000
    beforeEach(async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )
      await token.approveAndCall(
        escrow.address, depositedAmount, data, {from: owner}
      )
    })

    it('returns 0 for unknown operator', async () => {
      const withdrawable = await escrow.withdrawable(grantee)
      expect(withdrawable).to.eq.BN(0) 
    })

    it('returns 0 just before the cliff', async () => {
      await time.increaseTo(
        // 1 minute before the cliff ends
        grantStart.add(grantCliff).sub(time.duration.minutes(1))
      )
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(0) 
    })

    it('returns unlocked amount just after the cliff', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(166) // (1000 / 30) * 5 = 166
    })

    it('returns unlocked amount in the middle of unlocking period', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(500) // (1000 / 30) * 15 = 500 
    })

    it('returns whole deposited amount after it unlocked', async () => {
      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(depositedAmount) 
    })

    it('returns 0 just after the cliff if all unlocked withdrawn', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await escrow.withdraw(operator, {from: grantee})
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(0)
    })

    it('returns remaining unlocked, non-withdrawn amount', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdraw(operator, {from: grantee}) // withdraws 500
      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(500) // the remaining 500
    })

    it('returns 0 for revoked grant', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await tokenGrant.revoke(grantId, {from: owner})
      const withdrawable = await escrow.withdrawable(operator)
      expect(withdrawable).to.eq.BN(0)
    })
  })

  describe('withdraw', async () => {
    const depositedAmount = 2000
    beforeEach(async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )
      await token.approveAndCall(
        escrow.address, depositedAmount, data, {from: owner}
      )
    })

    it('can be called by grantee', async () => {
      await escrow.withdraw(operator, {from: grantee})
      // ok, no reverts
    })

    it('can be called by operator', async () => {
      await escrow.withdraw(operator, {from: operator})
      // ok, no reverts
    })

    it('can not be called by third-party', async () => {
      await expectRevert(
        escrow.withdraw(operator, {from: owner}),
        "Only grantee or operator can withdraw" 
      )
    })

    it('withdraws entire unlocked amount just after the cliff', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await escrow.withdraw(operator, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(333) // (2000 / 30) * 5 = 333
    })

    it('withdraws entire unlocked amount in the middle of unlocking period', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdraw(operator, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(1000) // (2000 / 30) * 15 = 1000  
    })

    it('withdraws entire unlocked amount after the whole unlocking period', async () => {
      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      await escrow.withdraw(operator, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(depositedAmount)
    })

    it('allows to withdraw in multiple rounds', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await escrow.withdraw(operator, {from: grantee})

      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdraw(operator, {from: grantee})

      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      await escrow.withdraw(operator, {from: grantee})

      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(depositedAmount)
    })

    it('emits an event', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      const receipt = await escrow.withdraw(operator, {from: grantee})

      await expectEvent(receipt, 'DepositWithdrawn', {
        operator: operator,
        grantee: grantee,
        amount: web3.utils.toBN(1000)// (2000 / 30) * 15 = 1000 
      })
    })
    
    it('can not be called for managed grant', async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator2, managedGrantId]
      )
      await token.approveAndCall(
        escrow.address, 600, data, {from: owner}
      )

      await expectRevert(
          escrow.withdraw(operator2, {from: operator2}),
          "Can not be called for managed grant"
      );
    })
  })

  describe('withdrawToManagedGrantee', async () => {
    const depositedAmount = 2000
    beforeEach(async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator2, managedGrantId]
      )
      await token.approveAndCall(
        escrow.address, depositedAmount, data, {from: owner}
      )
    })

    it('can be called by grantee', async () => {
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
      // ok, no reverts
    })
  
    it('can be called by operator', async () => {
      await escrow.withdrawToManagedGrantee(operator2, {from: operator2})
      // ok, no reverts
    })

    it('can not be called by third-party', async () => {
      await expectRevert(
        escrow.withdrawToManagedGrantee(operator2, {from: owner}),
        "Only grantee or operator can withdraw" 
      )
    })

    it('withdraws entire unlocked amount just after the cliff', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(333) // (2000 / 30) * 5 = 333
    })
  
    it('withdraws entire unlocked amount in the middle of unlocking period', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(1000) // (2000 / 30) * 15 = 1000  
    })
  
    it('withdraws entire unlocked amount after the whole unlocking period', async () => {
      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(depositedAmount)
    })

    it('allows to withdraw in multiple rounds', async () => {
      await time.increaseTo(grantStart.add(grantCliff))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
  
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
  
      await time.increaseTo(grantStart.add(grantUnlockingDuration))
      await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
  
      const balance = await token.balanceOf(grantee);
      expect(balance).to.eq.BN(depositedAmount)
    })

    it('emits an event', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      const receipt = await escrow.withdrawToManagedGrantee(operator2, {from: grantee})
  
      await expectEvent(receipt, 'DepositWithdrawn', {
        operator: operator2,
        grantee: grantee,
        amount: web3.utils.toBN(1000)// (2000 / 30) * 15 = 1000 
      })
    })
  })
  
  describe('withdrawnAmount', async () => {
    const depositedAmount = 3000

    beforeEach(async () => {
      const data = web3.eth.abi.encodeParameters(
        ['address', 'uint256'], [operator, grantId]
      )
      await token.approveAndCall(
        escrow.address, depositedAmount, data, {from: owner}
      )
    })

    it('returns 0 for unknown operator', async () => {
      const withdrawn = await escrow.withdrawnAmount(grantee)
      expect(withdrawn).to.eq.BN(0)   
    })

    it('returns 0 if nothing has been withdrawn', async () => {
      const withdrawn = await escrow.withdrawnAmount(operator)
      expect(withdrawn).to.eq.BN(0)   
    })
  
    it('returns withdrawn amount in the middle of unlocking period', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(15)))
      await escrow.withdraw(operator, {from: grantee})
      const withdrawn = await escrow.withdrawnAmount(operator)
      expect(withdrawn).to.eq.BN(1500) // (3000 / 30) * 15 = 1500  
    })
  
    it('returns withdrawn amount at the end of unlocking period', async () => {
      await time.increaseTo(grantStart.add(time.duration.days(grantUnlockingDuration)))
      await escrow.withdraw(operator, {from: grantee})
      const withdrawn = await escrow.withdrawnAmount(operator)
      expect(withdrawn).to.eq.BN(depositedAmount)
    })
  })
})