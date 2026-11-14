// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface RecoveryToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
}
// One immutable order per deployment. Local qualification only; no admin path.
contract RecoverableUSDC {
    RecoveryToken public immutable token;
    struct Lock { address payer; address recipient; uint256 amount; bytes32 hashlock; uint64 until; uint8 status; }
    mapping(bytes32 => Lock) public locks;
    bool private busy;
    event Locked(bytes32 indexed id);
    event Claimed(bytes32 indexed id,bytes32 secret);
    event Refunded(bytes32 indexed id);
    event Cancelled(bytes32 indexed id);
    constructor(address asset,bytes32 id,address payer,address recipient,uint256 amount,bytes32 hashlock,uint64 until) {
        require(block.chainid==31337 && asset.code.length>0,"isolated token");
        require(id!=bytes32(0) && payer!=address(0) && recipient!=address(0) && payer!=recipient,"parties");
        require(amount>0 && hashlock!=bytes32(0) && until>block.timestamp && until<=block.timestamp+7 days,"terms");
        token=RecoveryToken(asset);locks[id]=Lock(payer,recipient,amount,hashlock,until,4);
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
        require(token.transfer(l.recipient,l.amount),"claim failed");emit Claimed(id,secret);
    }
    function refund(bytes32 id) external guarded {
        Lock storage l=locks[id];require(l.status==1 && block.timestamp>=l.until,"not refundable");
        l.status=3;require(token.transfer(l.payer,l.amount),"refund failed");emit Refunded(id);
    }
}
