package main

import (
 "bytes"
 "encoding/hex"
 "testing"
 "time"
 "github.com/cometbft/cometbft/crypto/ed25519"
 proto "github.com/cometbft/cometbft/proto/tendermint/types"
 pv "github.com/cometbft/cometbft/proto/tendermint/version"
 "github.com/cometbft/cometbft/types"
)

func TestOfflineArchiveAuthenticatesPayloadAndAnchor(t *testing.T){
 chain:="sunphi-lab-archive";keys:=map[string]ed25519.PrivKey{};vals:=make([]*types.Validator,10);g:=&types.GenesisDoc{ChainID:chain,InitialHeight:1}
 for i:=range vals{k:=ed25519.GenPrivKey();keys[string(k.PubKey().Address())]=k;vals[i]=types.NewValidator(k.PubKey(),10);g.Validators=append(g.Validators,types.GenesisValidator{Address:k.PubKey().Address(),PubKey:k.PubKey(),Power:10})}
 set:=types.NewValidatorSet(vals);a:=historyArchive{Version:1};var previous *types.SignedHeader
 for h:=int64(1);h<=9;h++{
  txs:=[]types.Tx{};if h==1{txs=append(txs,types.Tx("authenticated payload"))};data:=types.Data{Txs:types.Txs(txs)}
  header:=&types.Header{Version:pv.Consensus{Block:11},ChainID:chain,Height:h,Time:time.Unix(1700000000+h,0),ValidatorsHash:set.Hash(),NextValidatorsHash:set.Hash(),ConsensusHash:bytes.Repeat([]byte{7},32),AppHash:bytes.Repeat([]byte{8},32),DataHash:data.Hash(),ProposerAddress:set.Validators[0].Address}
  if previous!=nil{header.LastBlockID=previous.Commit.BlockID}
  id:=types.BlockID{Hash:header.Hash(),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{9},32)}};c:=&types.Commit{Height:h,Round:0,BlockID:id,Signatures:make([]types.CommitSig,10)}
  for i,v:=range set.Validators{vote:=&types.Vote{Type:proto.PrecommitType,Height:h,Round:0,BlockID:id,Timestamp:header.Time,ValidatorAddress:v.Address,ValidatorIndex:int32(i)};sig,e:=keys[string(v.Address)].Sign(types.VoteSignBytes(chain,vote.ToProto()));if e!=nil{t.Fatal(e)};vote.Signature=sig;c.Signatures[i]=vote.CommitSig()}
  previous=&types.SignedHeader{Header:header,Commit:c};a.Entries=append(a.Entries,historyEntry{Header:previous,Validators:set.Validators,Txs:txs})
 }
 if _,e:=checkHistoryArchive(&a,g,0,"");e!=nil{t.Fatal(e)}
 proof:=receiptProof{Version:1};for _,x:=range a.Entries{proof.Entries=append(proof.Entries,historyEntry{Header:x.Header,Validators:x.Validators,Txs:[]types.Tx{}})}
 pin:=hex.EncodeToString(a.Entries[0].Header.Hash())
 if _,e:=checkReceiptProof(&proof,g,1,pin);e!=nil{t.Fatal(e)}
 if _,e:=checkReceiptProof(&proof,g,2,pin);e==nil{t.Fatal("receipt wrong anchor height")}
 if _,e:=checkReceiptProof(&proof,g,1,hex.EncodeToString(bytes.Repeat([]byte{0},32)));e==nil{t.Fatal("receipt wrong anchor hash")}
 if _,e:=checkReceiptProof(&proof,&types.GenesisDoc{ChainID:"wrong-chain"},1,pin);e==nil{t.Fatal("receipt wrong chain")}
 saved:=proof.Entries[4];proof.Entries[4]=proof.Entries[3]
 if _,e:=checkReceiptProof(&proof,g,1,pin);e==nil{t.Fatal("receipt broken linkage")};proof.Entries[4]=saved
 sigs:=append([]types.CommitSig{},proof.Entries[8].Header.Commit.Signatures...)
 for i:=6;i<10;i++{proof.Entries[8].Header.Commit.Signatures[i]=types.NewCommitSigAbsent()}
 if _,e:=checkReceiptProof(&proof,g,1,pin);e==nil{t.Fatal("receipt six signatures")}
 proof.Entries[8].Header.Commit.Signatures=sigs
 proof.Version=2;endPin:=hex.EncodeToString(a.Entries[8].Header.Hash())
 if r,e:=checkReceiptProof(&proof,g,9,endPin);e!=nil||r["headerHeight"]!=int64(1){t.Fatal("sealed endpoint proof",e)}
 if _,e:=checkReceiptProof(&proof,g,1,pin);e==nil{t.Fatal("v2 must anchor at final seal, not first header")}
 if _,e:=checkHistoryArchive(&a,g,1,hex.EncodeToString(a.Entries[0].Header.Hash()));e!=nil{t.Fatal(e)}
 if _,e:=checkHistoryArchive(&a,g,1,hex.EncodeToString(bytes.Repeat([]byte{0},32)));e==nil{t.Fatal("wrong retained anchor accepted")}
 a.Entries[0].Txs[0]=types.Tx("tampered payload")
 if _,e:=checkHistoryArchive(&a,g,0,"");e==nil{t.Fatal("unsigned payload accepted")}
 a.Entries[0].Txs[0]=types.Tx("authenticated payload")
 a.Entries[8].Header.Header.AppHash=bytes.Repeat([]byte{0},32)
 if _,e:=checkHistoryArchive(&a,g,0,"");e==nil{t.Fatal("rewritten application root accepted")}
}
