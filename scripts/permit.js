const { EIP712Signer } = require('@ticket721/e712')

const Permit = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
]

class PermitSigner extends EIP712Signer {
  constructor(_domain, _permitArgs) {
    super(_domain, ['Permit', Permit])
    this.permitArgs = _permitArgs
  }

  // Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
  setPermitInfo(_permitArgs) {
    this.permitArgs = _permitArgs
  }

  getPayload() {
    return this.generatePayload(this.permitArgs, 'Permit')
  }

  async getSignature(privateKey) {
    let payload = this.getPayload()
    payload.message.owner = payload.message.owner.address
    const { hex, v, r, s } = await this.sign(privateKey, payload)
    return {
      hex,
      v,
      r: '0x' + r,
      s: '0x' + s,
    }
  }

  getSignerAddress(permitArgs, signature) {
    const original_payload = this.generatePayload(permitArgs, 'Permit')
    return this.verify(original_payload, signature)
  }
}

module.exports = { PermitSigner }
