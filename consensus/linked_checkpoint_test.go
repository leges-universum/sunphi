package main

import (
 "bytes"
 "testing"
 "time"
 "github.com/cometbft/cometbft/crypto/ed25519"
 proto "github.com/cometbft/cometbft/proto/tendermint/types"
 pv "github.com/cometbft/cometbft/proto/tendermint/version"
 "github.com/cometbft/cometbft/types"
)

func TestLinkedHeadersAuthenticateCommitteeAndHistory(t *testing.T){
 chain:="sunphi-lab-linked";keys:=map[string]ed25519.PrivKey{};vals:=make([]*types.Validator,10)
 for i:=range vals{k:=ed25519.GenPrivKey();keys[string(k.PubKey().Address())]=k;vals[i]=types.NewValidator(k.PubKey(),10)}
 old:=types.NewValidatorSet(vals);replacement:=ed25519.GenPrivKey();keys[string(replacement.PubKey().Address())]=replacement
 newVals:=append([]*types.Validator{},vals...);newVals[9]=types.NewValidator(replacement.PubKey(),10);next:=types.NewValidatorSet(newVals)
 makeHeader:=func(h int64,set,nextSet *types.ValidatorSet,previous *types.SignedHeader)*types.SignedHeader{
  header:=&types.Header{Version:pv.Consensus{Block:11},ChainID:chain,Height:h,Time:time.Unix(1700000000+h,0),ValidatorsHash:set.Hash(),NextValidatorsHash:nextSet.Hash(),ConsensusHash:bytes.Repeat([]byte{7},32),AppHash:bytes.Repeat([]byte{8},32),ProposerAddress:set.Validators[0].Address}
  if previous!=nil{header.LastBlockID=previous.Commit.BlockID}
  id:=types.BlockID{Hash:header.Hash(),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{9},32)}}
  c:=&types.Commit{Height:h,Round:0,BlockID:id,Signatures:make([]types.CommitSig,10)}
  for i,v:=range set.Validators{vote:=&types.Vote{Type:proto.PrecommitType,Height:h,Round:0,BlockID:id,Timestamp:header.Time,ValidatorAddress:v.Address,ValidatorIndex:int32(i)};sig,e:=keys[string(v.Address)].Sign(types.VoteSignBytes(chain,vote.ToProto()));if e!=nil{t.Fatal(e)};vote.Signature=sig;c.Signatures[i]=vote.CommitSig()}
  return &types.SignedHeader{Header:header,Commit:c}
 }
 a:=makeHeader(1,old,next,nil);b:=makeHeader(2,next,next,a)
 if e:=verifyLinkedHeader(chain,a,old,nil);e!=nil{t.Fatal(e)}
 if e:=verifyLinkedHeader(chain,b,next,a);e!=nil{t.Fatal(e)}
 if verifyLinkedHeader(chain,b,old,a)==nil{t.Fatal("retired committee accepted")}
 other:=makeHeader(1,old,old,nil)
 if verifyLinkedHeader(chain,b,next,other)==nil{t.Fatal("history/set discontinuity accepted")}
 forged:=makeHeader(2,old,old,a)
 if verifyLinkedHeader(chain,forged,old,a)==nil{t.Fatal("old keys override committed new set")}
 b.Header.AppHash=bytes.Repeat([]byte{0},32)
 if verifyLinkedHeader(chain,b,next,a)==nil{t.Fatal("altered header accepted")}
}
