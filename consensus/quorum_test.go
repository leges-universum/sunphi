package main
import (
 "bytes"
 "path/filepath"
 "testing"
 "time"
 "github.com/cometbft/cometbft/crypto/ed25519"
 proto "github.com/cometbft/cometbft/proto/tendermint/types"
 "github.com/cometbft/cometbft/privval"
 "github.com/cometbft/cometbft/types"
)
func TestActualSignatureQuorumBoundaries(t *testing.T){
 keys:=map[string]ed25519.PrivKey{};vals:=make([]*types.Validator,10)
 for i:=range vals{k:=ed25519.GenPrivKey();keys[string(k.PubKey().Address())]=k;vals[i]=types.NewValidator(k.PubKey(),1)}
 set:=types.NewValidatorSet(vals);chain:="sunphi-lab-quorum"
 block:=types.BlockID{Hash:bytes.Repeat([]byte{1},32),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{2},32)}}
 makeCommit:=func(n int,id types.BlockID)*types.Commit{
  c:=&types.Commit{Height:9,Round:0,BlockID:id,Signatures:make([]types.CommitSig,10)}
  for i,v:=range set.Validators{c.Signatures[i]=types.NewCommitSigAbsent();if i>=n{continue};vote:=&types.Vote{Type:proto.PrecommitType,Height:9,Round:0,BlockID:id,Timestamp:time.Now().UTC(),ValidatorAddress:v.Address,ValidatorIndex:int32(i)};sig,e:=keys[string(v.Address)].Sign(types.VoteSignBytes(chain,vote.ToProto()));if e!=nil{t.Fatal(e)};vote.Signature=sig;c.Signatures[i]=vote.CommitSig()};return c
 }
 for _,n:=range []int{3,6,7,10}{e:=set.VerifyCommitLight(chain,block,9,makeCommit(n,block));if (e==nil)!=(n>=7){t.Fatalf("quorum %d: %v",n,e)}}
 altered:=block;altered.Hash=bytes.Repeat([]byte{3},32)
 c:=makeCommit(10,block);c.BlockID=altered;if set.VerifyCommitLight(chain,altered,9,c)==nil{t.Fatal("altered block accepted")}
 c=makeCommit(7,block);c.Signatures[1]=c.Signatures[0];if set.VerifyCommitLight(chain,block,9,c)==nil{t.Fatal("duplicate signer accepted")}
 c=makeCommit(7,block);if set.VerifyCommitLight("sunphi-lab-other",block,9,c)==nil{t.Fatal("cross-chain replay accepted")}
 // Explicit upper bound: stealing 7 current keys can certify a fork. This test
 // documents the limit instead of claiming unconditional anti-collusion safety.
 if e:=set.VerifyCommitLight(chain,altered,9,makeCommit(7,altered));e!=nil{t.Fatal(e)}
}
func TestPersistedSignerRejectsConflictingVoteAfterRestart(t *testing.T){
 d:=t.TempDir();k:=ed25519.GenPrivKey();kp:=filepath.Join(d,"key.json");sp:=filepath.Join(d,"state.json")
 pv:=privval.NewFilePV(k,kp,sp);pv.Save()
 vote:=&proto.Vote{Type:proto.PrecommitType,Height:3,Round:0,BlockID:proto.BlockID{Hash:bytes.Repeat([]byte{1},32),PartSetHeader:proto.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{2},32)}},Timestamp:time.Now().UTC()}
 if e:=pv.SignVote("sunphi-lab-signing",vote);e!=nil{t.Fatal(e)}
 pv=privval.LoadFilePV(kp,sp);vote.BlockID.Hash=bytes.Repeat([]byte{3},32);vote.Signature=nil
 if pv.SignVote("sunphi-lab-signing",vote)==nil{t.Fatal("conflicting vote after restart accepted")}
}
