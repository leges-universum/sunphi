// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface NativeUSDC {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
}

// Candidate for review and isolated qualification; not deployed or activated.
// One immutable order. No owner, upgrade, arbitrary call or withdrawal method.
contract EthereumUSDCExchange {
    NativeUSDC public constant token = NativeUSDC(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    struct Lock { address payer; address recipient; uint256 amount; bytes32 hashlock; uint64 until; uint8 status; }
    mapping(bytes32 => Lock) public locks;
    bool private busy;
    event Locked(bytes32 indexed id);
    event Claimed(bytes32 indexed id,bytes32 secret);
    event Refunded(bytes32 indexed id);
    event Cancelled(bytes32 indexed id);

    constructor(bytes32 id,address payer,address recipient,uint256 amount,bytes32 hashlock,uint64 until) {
        require(block.chainid==1 && address(token).code.length>0 && token.decimals()==6,"Ethereum native USDC required");
        require(id!=bytes32(0) && payer!=address(0) && recipient!=address(0) && payer!=recipient,"parties");
        require(payer!=address(this) && recipient!=address(this),"external parties");
        require(amount>0 && hashlock!=bytes32(0) && until>block.timestamp && until<=block.timestamp+7 days,"terms");
        locks[id]=Lock(payer,recipient,amount,hashlock,until,4);
    }
    modifier guarded() { require(!busy,"busy");busy=true;_;busy=false; }
    function lock(bytes32 id) external guarded {
        Lock storage l=locks[id];require(l.status==4 && msg.sender==l.payer && block.timestamp<l.until,"not fundable");
        uint256 beforeBalance=token.balanceOf(address(this));l.status=1;
        require(token.transferFrom(l.payer,address(this),l.amount),"funding failed");
        require(token.balanceOf(address(this))==beforeBalance+l.amount,"exact funding");emit Locked(id);
    }
    function cancelUnfunded(bytes32 id) external guarded {
        Lock storage l=locks[id];require(l.status==4 && (msg.sender==l.payer || block.timestamp>=l.until),"not cancellable");
        l.status=5;emit Cancelled(id);
    }
    function claim(bytes32 id,bytes32 secret) external guarded {
        Lock storage l=locks[id];require(l.status==1 && block.timestamp<l.until,"not claimable");
        require(sha256(abi.encodePacked(secret))==l.hashlock,"preimage");l.status=2;
        pay(l.recipient,l.amount);emit Claimed(id,secret);
    }
    function refund(bytes32 id) external guarded {
        Lock storage l=locks[id];require(l.status==1 && block.timestamp>=l.until,"not refundable");
        l.status=3;pay(l.payer,l.amount);emit Refunded(id);
    }
    function pay(address recipient,uint256 amount) private {
        uint256 beforeBalance=token.balanceOf(recipient);
        require(token.transfer(recipient,amount),"transfer failed");
        require(token.balanceOf(recipient)==beforeBalance+amount,"exact receipt");
    }
}
