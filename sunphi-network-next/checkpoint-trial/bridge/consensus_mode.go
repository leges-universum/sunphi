package main

import (
 "fmt"
 abci "github.com/cometbft/cometbft/abci/types"
)

// The private application's persisted policy is the authority for activation.
// Installing a bridge binary alone must not alter pre-activation ABCI requests.
// Restore/replay learns the same policy from Info, never from a wallet or RPC.
type consensusMode struct {
 Version int `json:"version"`
 Activation int64 `json:"activation"`
}

func (b *bridge) acceptConsensusMode(method string, next *consensusMode) error {
 if next==nil{return nil}
 if method!="info"&&method!="init"&&method!="finalize"{return fmt.Errorf("consensus policy on non-authoritative response")}
 if next.Version!=1||next.Activation<1{return fmt.Errorf("unsupported consensus context policy")}
 if e:=b.checkSlashingConsensusParameters();e!=nil{return e}
 copy:=*next
 for {
  previous:=b.consensus.Load()
  if previous!=nil {
   if *previous!=copy{return fmt.Errorf("consensus context policy changed")}
   return nil
  }
  if b.consensus.CompareAndSwap(nil,&copy){return nil}
 }
}

func (b *bridge) consensusContext(height int64, commit abci.CommitInfo, evidence []abci.Misbehavior)(*consensusContext,error){
 mode:=b.consensus.Load()
 if mode==nil||height<mode.Activation{return nil,nil}
 if e:=b.checkSlashingConsensusParameters();e!=nil{return nil,e}
 return normalizedConsensus(commit,evidence)
}
