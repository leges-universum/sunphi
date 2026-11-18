// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Isolated qualification contract only. No upgrade/admin spend path.
interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
}
contract ConditionalUSDC {
    Token public immutable token;
    struct Lock { address payer; address recipient; uint256 amount; bytes32 hashlock; uint64 until; uint8 status; }
    mapping(bytes32 => Lock) public locks;
    bool private busy;
    event Locked(bytes32 indexed id,address payer,address recipient,uint256 amount,bytes32 hashlock,uint64 until);
    event Claimed(bytes32 indexed id,bytes32 secret);
    event Refunded(bytes32 indexed id);
    constructor(address asset) { require(block.chainid == 31337, "isolated chain only"); require(asset.code.length>0,"token"); token=Token(asset); }
    modifier guarded() { require(!busy,"busy"); busy=true; _; busy=false; }
    function lock(bytes32 id,address recipient,uint256 amount,bytes32 hashlock,uint64 until) external guarded {
        require(locks[id].status==0 && id!=bytes32(0),"used id");
        require(recipient!=address(0) && recipient!=msg.sender && amount>0 && hashlock!=bytes32(0),"terms");
        require(until>block.timestamp && until<=block.timestamp+7 days,"deadline");
        uint256 beforeBalance=token.balanceOf(address(this));
        locks[id]=Lock(msg.sender,recipient,amount,hashlock,until,1);
        require(token.transferFrom(msg.sender,address(this),amount),"funding failed");
        require(token.balanceOf(address(this))==beforeBalance+amount,"exact funding");
        emit Locked(id,msg.sender,recipient,amount,hashlock,until);
    }
    function claim(bytes32 id,bytes32 secret) external guarded {
        Lock storage l=locks[id];require(l.status==1 && block.timestamp<l.until,"not claimable");
        require(sha256(abi.encodePacked(secret))==l.hashlock,"preimage");
        l.status=2;require(token.transfer(l.recipient,l.amount),"claim failed");emit Claimed(id,secret);
    }
    function refund(bytes32 id) external guarded {
        Lock storage l=locks[id];require(l.status==1 && block.timestamp>=l.until,"not refundable");
        l.status=3;require(token.transfer(l.payer,l.amount),"refund failed");emit Refunded(id);
    }
}
