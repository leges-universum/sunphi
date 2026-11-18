package main

import (
 "encoding/hex"
 "fmt"
 "sort"

 abci "github.com/cometbft/cometbft/abci/types"
)

// Only the private ABCI connection may supply this context. Wallet transactions
// are never a source of evidence or of last-commit participation.
type consensusVote struct {
 Address string `json:"address"`
 Power int64 `json:"power"`
 Flag int32 `json:"flag"`
}
type consensusFault struct {
 Type int32 `json:"type"`
 Address string `json:"address"`
 Power int64 `json:"power"`
 Height int64 `json:"height"`
 Time int64 `json:"time"`
 TotalPower int64 `json:"totalPower"`
}
type consensusContext struct {
 Round int32 `json:"round"`
 Votes []consensusVote `json:"votes"`
 Misbehavior []consensusFault `json:"misbehavior"`
}
func normalizedConsensus(commit abci.CommitInfo, evidence []abci.Misbehavior)(*consensusContext,error){
 if commit.Round<0||len(commit.Votes)>256||len(evidence)>65536{return nil,fmt.Errorf("consensus context bounds")}
 out:=&consensusContext{Round:commit.Round,Votes:[]consensusVote{},Misbehavior:[]consensusFault{}}
 seen:=map[string]bool{}
 for _,v:=range commit.Votes{
  address:=hex.EncodeToString(v.Validator.Address);flag:=int32(v.BlockIdFlag)
  if len(v.Validator.Address)!=20||v.Validator.Power<1||v.Validator.Power>1000000||flag<1||flag>3||seen[address]{return nil,fmt.Errorf("consensus vote")}
  seen[address]=true;out.Votes=append(out.Votes,consensusVote{address,v.Validator.Power,flag})
 }
 for _,e:=range evidence{
  if (e.Type!=abci.MisbehaviorType_DUPLICATE_VOTE&&e.Type!=abci.MisbehaviorType_LIGHT_CLIENT_ATTACK)||len(e.Validator.Address)!=20||e.Validator.Power<1||e.Validator.Power>1000000||e.Height<1||e.Time.Unix()<1||e.TotalVotingPower<e.Validator.Power||e.TotalVotingPower>256000000{return nil,fmt.Errorf("consensus evidence")}
  out.Misbehavior=append(out.Misbehavior,consensusFault{int32(e.Type),hex.EncodeToString(e.Validator.Address),e.Validator.Power,e.Height,e.Time.Unix(),e.TotalVotingPower})
 }
 sort.Slice(out.Votes,func(i,j int)bool{return out.Votes[i].Address<out.Votes[j].Address})
 sort.Slice(out.Misbehavior,func(i,j int)bool{a,b:=out.Misbehavior[i],out.Misbehavior[j];if a.Height!=b.Height{return a.Height<b.Height};if a.Address!=b.Address{return a.Address<b.Address};if a.Type!=b.Type{return a.Type<b.Type};if a.Time!=b.Time{return a.Time<b.Time};if a.Power!=b.Power{return a.Power<b.Power};return a.TotalPower<b.TotalPower})
 return out,nil
}
func proposalCommit(c abci.ExtendedCommitInfo) abci.CommitInfo {
 out:=abci.CommitInfo{Round:c.Round,Votes:make([]abci.VoteInfo,len(c.Votes))}
 for i,v:=range c.Votes{out.Votes[i]=abci.VoteInfo{Validator:v.Validator,BlockIdFlag:v.BlockIdFlag}}
 return out
}
