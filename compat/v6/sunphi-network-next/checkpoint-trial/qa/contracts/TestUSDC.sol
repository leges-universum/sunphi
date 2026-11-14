// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Local qualification asset, NOT Circle-issued USDC.
contract TestUSDC {
    string public constant name = "DueByte isolated test USDC";
    string public constant symbol = "TEST-USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable admin;
    bool public paused;
    bool public returnFalse;
    bool public shortTransfer;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(address buyer, uint256 supply) {
        admin = msg.sender; totalSupply = supply; balanceOf[buyer] = supply;
        emit Transfer(address(0), buyer, supply);
    }
    modifier onlyAdmin() { require(msg.sender == admin, "admin"); _; }
    function setPaused(bool value) external onlyAdmin { paused = value; }
    function setReturnFalse(bool value) external onlyAdmin { returnFalse = value; }
    function setShortTransfer(bool value) external onlyAdmin { shortTransfer = value; }
    function setReentry(address target, bytes calldata data) external onlyAdmin {
        reentryTarget = target; reentryData = data; reentrySucceeded = false;
    }
    function setBlocked(address who, bool value) external onlyAdmin { blocked[who] = value; }
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true;
    }
    function transfer(address to, uint256 value) external returns (bool) { return move(msg.sender, to, value); }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(allowance[from][msg.sender] >= value, "allowance");
        bool ok = move(from, to, value); if (ok) allowance[from][msg.sender] -= value; return ok;
    }
    function move(address from, address to, uint256 value) private returns (bool) {
        require(!paused && !blocked[from] && !blocked[to], "restricted");
        require(to != address(0) && balanceOf[from] >= value, "balance");
        if (returnFalse) return false;
        if (shortTransfer && value > 0) value -= 1;
        balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value);
        if (reentryTarget != address(0)) (reentrySucceeded,) = reentryTarget.call(reentryData);
        return true;
    }
}
