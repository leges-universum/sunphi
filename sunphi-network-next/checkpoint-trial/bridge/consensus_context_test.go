package main

import (
 "bytes"
 "context"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "reflect"
 "testing"
 "time"
 abci "github.com/cometbft/cometbft/abci/types"
 cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
)

func testCommit() abci.CommitInfo {return abci.CommitInfo{Round:2,Votes:[]abci.VoteInfo{
 {Validator:abci.Validator{Address:bytes.Repeat([]byte{2},20),Power:12},BlockIdFlag:cmtproto.BlockIDFlagCommit},
 {Validator:abci.Validator{Address:bytes.Repeat([]byte{1},20),Power:10},BlockIdFlag:cmtproto.BlockIDFlagAbsent},
 {Validator:abci.Validator{Address:bytes.Repeat([]byte{3},20),Power:10},BlockIdFlag:cmtproto.BlockIDFlagNil},
 }}}
func testEvidence() []abci.Misbehavior{return []abci.Misbehavior{{Type:abci.MisbehaviorType_DUPLICATE_VOTE,Validator:abci.Validator{Address:bytes.Repeat([]byte{1},20),Power:10},Height:5,Time:time.Unix(1000,0),TotalVotingPower:100}}}
func TestConsensusMetadataAcrossAllABCIPhases(t *testing.T){
 commit,evidence:=testCommit(),testEvidence();expected,e:=normalizedConsensus(commit,evidence);if e!=nil{t.Fatal(e)}
 if expected.Votes[0].Flag!=1||expected.Votes[1].Power!=12||expected.Votes[2].Flag!=3{t.Fatal("sort/flags changed")}
 captured:=[]request{}
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){var q request;if err:=json.NewDecoder(r.Body).Decode(&q);err!=nil{t.Error(err)};if r.Header.Get("X-Duebyte-App-Auth")!="synthetic-capability"{t.Error("missing capability")};captured=append(captured,q);json.NewEncoder(w).Encode(response{Accept:true})}));defer server.Close()
 b:=&bridge{url:server.URL,auth:"synthetic-capability",client:server.Client(),consensusParameters:testSlashingParameters}
 if e=b.acceptConsensusMode("info",&consensusMode{Version:1,Activation:8});e!=nil{t.Fatal(e)}
 extended:=abci.ExtendedCommitInfo{Round:commit.Round};for _,v:=range commit.Votes{extended.Votes=append(extended.Votes,abci.ExtendedVoteInfo{Validator:v.Validator,BlockIdFlag:v.BlockIdFlag})}
 _,e=b.PrepareProposal(context.Background(),&abci.RequestPrepareProposal{Height:8,LocalLastCommit:extended,Misbehavior:evidence});if e!=nil{t.Fatal(e)}
 _,e=b.ProcessProposal(context.Background(),&abci.RequestProcessProposal{Height:8,ProposedLastCommit:commit,Misbehavior:evidence});if e!=nil{t.Fatal(e)}
 _,e=b.FinalizeBlock(context.Background(),&abci.RequestFinalizeBlock{Height:8,DecidedLastCommit:commit,Misbehavior:evidence});if e!=nil{t.Fatal(e)}
 for _,q:=range captured{if !reflect.DeepEqual(q.Consensus,expected){t.Fatalf("%s lost consensus metadata",q.Method)}}
 if len(captured)!=3{t.Fatal("missing phase")}
}
func TestConsensusContextRejectsMalformedInput(t *testing.T){
 for _,mutate:=range []func(*abci.CommitInfo){
  func(c *abci.CommitInfo){c.Round=-1},func(c *abci.CommitInfo){c.Votes[0].Validator.Address=[]byte{1}},
  func(c *abci.CommitInfo){c.Votes[0].Validator.Power=0},func(c *abci.CommitInfo){c.Votes[0].BlockIdFlag=0},
  func(c *abci.CommitInfo){c.Votes=append(c.Votes,c.Votes[0])},func(c *abci.CommitInfo){c.Votes=make([]abci.VoteInfo,257)},
 }{c:=testCommit();mutate(&c);if _,e:=normalizedConsensus(c,nil);e==nil{t.Fatal("accepted invalid commit")}}
 for _,mutate:=range []func(*abci.Misbehavior){
  func(e *abci.Misbehavior){e.Type=0},func(e *abci.Misbehavior){e.Height=0},func(e *abci.Misbehavior){e.TotalVotingPower=1},func(e *abci.Misbehavior){e.Time=time.Time{}},
 }{e:=testEvidence();mutate(&e[0]);if _,err:=normalizedConsensus(testCommit(),e);err==nil{t.Fatal("accepted invalid evidence")}}
 if _,e:=normalizedConsensus(abci.CommitInfo{},nil);e!=nil{t.Fatal("genesis empty commit",e)}
}
func TestConsensusEvidenceNormalizationIsDeterministic(t *testing.T){
 c:=testCommit();e:=testEvidence();other:=e[0];other.Type=abci.MisbehaviorType_LIGHT_CLIENT_ATTACK;e=append(e,other)
 first,err:=normalizedConsensus(c,e);if err!=nil{t.Fatal(err)}
 c.Votes[0],c.Votes[2]=c.Votes[2],c.Votes[0];e[0],e[1]=e[1],e[0]
 second,err:=normalizedConsensus(c,e);if err!=nil{t.Fatal(err)};if !reflect.DeepEqual(first,second){t.Fatal("order-dependent normalization")}
}
