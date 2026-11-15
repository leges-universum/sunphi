package main

import (
 "bytes"
 "errors"
 "testing"
 "time"
 dbm "github.com/cometbft/cometbft-db"
 "github.com/cometbft/cometbft/crypto/ed25519"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/store"
 "github.com/cometbft/cometbft/types"
)

func recoveryFixture(t *testing.T)(sm.Store,*store.BlockStore,sm.State,*types.Commit){
 t.Helper();key:=ed25519.GenPrivKey();s,e:=sm.MakeGenesisState(&types.GenesisDoc{ChainID:"isolated-bootstrap-recovery",GenesisTime:time.Unix(1700000000,0).UTC(),InitialHeight:1,ConsensusParams:types.DefaultConsensusParams(),Validators:[]types.GenesisValidator{{PubKey:key.PubKey(),Power:10}},AppHash:bytes.Repeat([]byte{1},32)});if e!=nil{t.Fatal(e)}
 states:=sm.NewStore(dbm.NewMemDB(),sm.StoreOptions{});if e=states.Save(s);e!=nil{t.Fatal(e)};blocks:=store.NewBlockStore(dbm.NewMemDB());t.Cleanup(func(){states.Close();blocks.Close()})
 s.LastBlockHeight=10;s.LastValidators=s.Validators.Copy();s.LastBlockID=types.BlockID{Hash:bytes.Repeat([]byte{2},32),PartSetHeader:types.PartSetHeader{Total:1,Hash:bytes.Repeat([]byte{3},32)}};s.AppHash=bytes.Repeat([]byte{4},32)
 commit:=&types.Commit{Height:10,BlockID:s.LastBlockID,Signatures:[]types.CommitSig{{BlockIDFlag:types.BlockIDFlagCommit,ValidatorAddress:key.PubKey().Address(),Timestamp:s.LastBlockTime}}};commit.Signatures[0].Signature,e=key.Sign(commit.VoteSignBytes(s.ChainID,0));if e!=nil{t.Fatal(e)}
 return states,blocks,s,commit
}
func TestPublishedBootstrapRecoveryIsRepeatableAtEveryWriteBoundary(t *testing.T){
 for _,point:=range []string{"state","commit","height"}{t.Run(point,func(t *testing.T){states,blocks,s,commit:=recoveryFixture(t);durable:=0
  if e:=publishRecoveredBootstrap(states,blocks,s,commit,s.AppHash,func()error{durable++;return nil},func(at string)error{if at==point{return errors.New("injected interruption")};return nil});e==nil{t.Fatal("missing injected failure")}
  if e:=publishRecoveredBootstrap(states,blocks,s,commit,s.AppHash,func()error{durable++;return nil},func(string)error{return nil});e!=nil{t.Fatal(e)}
  current,e:=states.Load();if e!=nil||!current.Equals(s){t.Fatal("recovered state mismatch",e)};height,e:=states.GetOfflineStateSyncHeight();if e!=nil||height!=10||blocks.LoadSeenCommit(10)==nil||durable<1{t.Fatal("incomplete durable bootstrap",e)}
 })}
}
func TestPublishedBootstrapRecoveryRejectsChangedRootAndExistingHistory(t *testing.T){
 for _,mode:=range []string{"root","height","prior-root","commit"}{t.Run(mode,func(t *testing.T){states,blocks,s,commit:=recoveryFixture(t);root:=s.AppHash
  if mode=="root"{root=bytes.Repeat([]byte{9},32)};if mode=="height"||mode=="prior-root"{prior:=s.Copy();if mode=="height"{prior.LastBlockHeight++}else{prior.AppHash=bytes.Repeat([]byte{9},32)};if e:=states.Save(prior);e!=nil{t.Fatal(e)}};if mode=="commit"{commit.Height++}
  before,e:=states.Load();if e!=nil{t.Fatal(e)};if e=publishRecoveredBootstrap(states,blocks,s,commit,root,func()error{t.Fatal("must not write");return nil},func(string)error{return nil});e==nil{t.Fatal("accepted unsafe replacement")};after,e:=states.Load();if e!=nil||!before.Equals(after){t.Fatal("changed rejected state",e)}
 })}
}
