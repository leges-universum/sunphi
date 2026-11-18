package main

import (
 "context"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "testing"
 "time"
 abci "github.com/cometbft/cometbft/abci/types"
 "github.com/cometbft/cometbft/types"
)

func testSlashingParameters()(types.ConsensusParams,error){p:=*types.DefaultConsensusParams();p.Block.MaxBytes=1048576;return p,nil}

func TestSlashingRequiresActualConsensusRetentionAndBounds(t *testing.T){
 p,_:=testSlashingParameters();if e:=checkSlashingParameters(p);e!=nil{t.Fatal(e)}
 for _,alter:=range []func(*types.ConsensusParams){
  func(p *types.ConsensusParams){p.Evidence.MaxAgeNumBlocks++},
  func(p *types.ConsensusParams){p.Evidence.MaxAgeDuration+=time.Second},
  func(p *types.ConsensusParams){p.Evidence.MaxBytes++},
  func(p *types.ConsensusParams){p.Block.MaxBytes++},
  func(p *types.ConsensusParams){p.ABCI.VoteExtensionsEnableHeight=1},
 }{q:=p;alter(&q);b:=&bridge{consensusParameters:func()(types.ConsensusParams,error){return q,nil}};if e:=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:1});e==nil||b.consensus.Load()!=nil{t.Fatal("unsafe parameters activated")}}
 b:=&bridge{};if e:=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:1});e==nil{t.Fatal("missing actual parameters")}
 b.consensusParameters=testSlashingParameters;if e:=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:1});e!=nil{t.Fatal(e)}
 p.Evidence.MaxAgeNumBlocks++;b.consensusParameters=func()(types.ConsensusParams,error){return p,nil};if _,e:=b.consensusContext(2,testCommit(),nil);e==nil{t.Fatal("state-sync parameter mismatch ignored")}
}

func TestConsensusModeRequiresPersistedPrivatePolicy(t *testing.T){
 for _,source:=range []string{"info","init","finalize"}{
  b:=&bridge{consensusParameters:testSlashingParameters}
  if x,e:=b.consensusContext(100,abci.CommitInfo{Round:-1},nil);e!=nil||x!=nil{t.Fatal("inactive protocol changed")}
  if e:=b.acceptConsensusMode(source,&consensusMode{Version:1,Activation:101});e!=nil{t.Fatal(e)}
  if x,e:=b.consensusContext(100,abci.CommitInfo{Round:-1},nil);e!=nil||x!=nil{t.Fatal("pre-activation validation")}
  if _,e:=b.consensusContext(101,abci.CommitInfo{Round:-1},nil);e==nil{t.Fatal("active validation skipped")}
  if x,e:=b.consensusContext(101,testCommit(),testEvidence());e!=nil||x==nil{t.Fatal("missing active context",e)}
  if e:=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:101});e!=nil{t.Fatal("idempotent handshake",e)}
  if e:=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:102});e==nil{t.Fatal("policy changed")}
 }
 for _,mode:=range []*consensusMode{{Version:0,Activation:101},{Version:2,Activation:101},{Version:1,Activation:0}}{
  b:=&bridge{};if e:=b.acceptConsensusMode("info",mode);e==nil||b.consensus.Load()!=nil{t.Fatal("invalid policy installed")}
 }
 for _,source:=range []string{"check","prepare","process","status","publicWork"}{
  b:=&bridge{};if e:=b.acceptConsensusMode(source,&consensusMode{Version:1,Activation:101});e==nil{t.Fatal("uncommitted policy installed")}
 }
}

func TestConsensusModeInfoRestoresActivationAfterRestart(t *testing.T){
 mode:=&consensusMode{Version:1,Activation:50}
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){var q request;json.NewDecoder(r.Body).Decode(&q);if q.Method!="info"{t.Error("unexpected method")};json.NewEncoder(w).Encode(response{Height:70,ConsensusContext:mode})}));defer server.Close()
 for n:=0;n<2;n++{
  b:=&bridge{url:server.URL,client:server.Client(),consensusParameters:testSlashingParameters}
  if _,e:=b.Info(context.Background(),&abci.RequestInfo{});e!=nil{t.Fatal(e)}
  if x,e:=b.consensusContext(71,testCommit(),testEvidence());e!=nil||x==nil{t.Fatal("restart forgot policy",e)}
 }
}
