package main

import (
 "bytes"
 "encoding/base64"
 "encoding/hex"
 "encoding/json"
 "testing"
 "time"

 "github.com/cometbft/cometbft/crypto/ed25519"
 cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
 cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
 "github.com/cometbft/cometbft/types"
 "github.com/cometbft/cometbft/version"
)

// Real Ed25519 commits over linked headers; a roster's size is never its
// authorization. Its hash must be authorized by the preceding signed header.
func signedTransition(t *testing.T, sizes []int)(proof,*types.GenesisDoc,string){
 t.Helper();g:=&types.GenesisDoc{ChainID:"isolated-legacy-pos-transition"}
 keys:=make(map[string]ed25519.PrivKey);vals:=[]*types.Validator{};members:=[]map[string]string{}
 for i:=0;i<10;i++{k:=ed25519.GenPrivKey();v:=types.NewValidator(k.PubKey(),10);keys[string(v.Address)]=k;vals=append(vals,v);g.Validators=append(g.Validators,types.GenesisValidator{PubKey:k.PubKey(),Power:10});members=append(members,map[string]string{"key":base64.RawURLEncoding.EncodeToString(k.PubKey().Bytes())})}
 g.AppState,_=json.Marshal(map[string]interface{}{"control":map[string]interface{}{"validators":members}})
 sets:=[]*types.ValidatorSet{};for _,n:=range sizes{sets=append(sets,types.NewValidatorSet(vals[:n]))}
 p:=proof{Version:2,Sets:map[string][]*types.Validator{}};previous:=types.BlockID{}
 for n,set:=range sets{
  next:=set;if n+1<len(sets){next=sets[n+1]};now:=time.Unix(1794900000+int64(n),0)
  h:=&types.Header{Version:cmtversion.Consensus{Block:version.BlockProtocol},ChainID:g.ChainID,Height:int64(n+1),Time:now,LastBlockID:previous,ValidatorsHash:set.Hash(),NextValidatorsHash:next.Hash(),ProposerAddress:set.Validators[0].Address,AppHash:bytes.Repeat([]byte{byte(n+1)},32)}
  id:=types.BlockID{Hash:h.Hash(),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{byte(n+2)},32)}}
  commit:=&types.Commit{Height:h.Height,Round:0,BlockID:id}
  for i,v:=range set.Validators{
   vote:=&types.Vote{Type:cmtproto.PrecommitType,Height:h.Height,Round:0,BlockID:id,Timestamp:now,ValidatorAddress:v.Address,ValidatorIndex:int32(i)}
   sig,e:=keys[string(v.Address)].Sign(types.VoteSignBytes(g.ChainID,vote.ToProto()));if e!=nil{t.Fatal(e)}
   commit.Signatures=append(commit.Signatures,types.CommitSig{BlockIDFlag:types.BlockIDFlagCommit,ValidatorAddress:v.Address,Timestamp:now,Signature:sig})
  }
  p.Headers=append(p.Headers,&types.SignedHeader{Header:h,Commit:commit});p.Sets[hex.EncodeToString(set.Hash())]=set.Validators;previous=id
 }
 return p,g,hex.EncodeToString(p.Headers[0].Hash())
}

func TestLinkedProofAcceptsAuthenticatedLegacyTransition(t *testing.T){
 for _,sizes:=range [][]int{{10,10,9},{10,9,4,3,2,1}}{p,g,pin:=signedTransition(t,sizes);if _,e:=check(p,g,1,pin,false);e!=nil{t.Fatal(e)}}
}
func TestLinkedProofNeverTrustsAnUnlinkedOrUnsignedRoster(t *testing.T){
 for _,fault:=range []string{"ancestry","successor","signature","quorum","set","pin","static"}{t.Run(fault,func(t *testing.T){
  p,g,pin:=signedTransition(t,[]int{10,9,9});switch fault{
  case "ancestry":p.Headers[1].LastBlockID.Hash=bytes.Repeat([]byte{99},32)
  case "successor":p.Headers[0].NextValidatorsHash=bytes.Repeat([]byte{99},32)
  case "signature":p.Headers[1].Commit.Signatures[0].Signature[0]^=1
  case "quorum":for i:=0;i<3;i++{p.Headers[1].Commit.Signatures[i]=types.NewCommitSigAbsent()}
  case "set":p.Sets[hex.EncodeToString(p.Headers[1].ValidatorsHash)]=p.Sets[hex.EncodeToString(p.Headers[0].ValidatorsHash)]
  case "pin":pin=hex.EncodeToString(bytes.Repeat([]byte{99},32))
  case "static":p.Version=1
  };if _,e:=check(p,g,1,pin,false);e==nil{t.Fatal("accepted forged transition")}
 })}
}
