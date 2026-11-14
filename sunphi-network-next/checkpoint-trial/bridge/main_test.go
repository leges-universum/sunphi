package main

import (
 "bytes"
 "encoding/json"
 "context"
 "io"
 "net/http"
 "net/http/httptest"
 "sync/atomic"
 "testing"
 "time"
 abci "github.com/cometbft/cometbft/abci/types"
)

func TestProposalAndFinalizeRetainSameConsensusBlockIdentity(t *testing.T){
 var requests []request
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){var q request;if e:=json.NewDecoder(r.Body).Decode(&q);e!=nil{t.Error(e)};requests=append(requests,q);io.WriteString(w,`{"accept":true,"codes":[0]}`)}));defer srv.Close()
 b:=&bridge{url:srv.URL,client:srv.Client()};ctx:=context.Background();digest:=bytes.Repeat([]byte{7},32);txs:=[][]byte{[]byte("test")};at:=time.Unix(1234,0)
 if _,e:=b.ProcessProposal(ctx,&abci.RequestProcessProposal{Height:10,Time:at,Hash:digest,Txs:txs});e!=nil{t.Fatal(e)}
 if _,e:=b.FinalizeBlock(ctx,&abci.RequestFinalizeBlock{Height:10,Time:at,Hash:digest,Txs:txs});e!=nil{t.Fatal(e)}
 if len(requests)!=2||!bytes.Equal(requests[0].Hash,digest)||!bytes.Equal(requests[1].Hash,digest)||requests[0].Time!=requests[1].Time||requests[0].Height!=requests[1].Height{t.Fatal("consensus identity lost before prepared commit")}
}

// A truncated success reply models a completed application operation whose
// response was lost during process suspension or a local socket reset.
func TestLostCommitReplyIsRetriedWithSameRequest(t *testing.T){
 var requests atomic.Int32;var original string
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if r.Header.Get("X-Duebyte-App-Auth")!="capability"{t.Error("missing application capability")}
  data,_:=io.ReadAll(r.Body)
  if requests.Add(1)==1{original=string(data);w.Header().Set("Content-Length","20");io.WriteString(w,"{");return};if string(data)!=original{t.Error("retry changed the original request")};io.WriteString(w,"{}")
 }));defer srv.Close();b:=&bridge{url:srv.URL,auth:"capability",client:srv.Client(),fatal:make(chan error,1)}
 if _,e:=b.call(context.Background(),request{Method:"commit"});e!=nil{t.Fatal(e)};if requests.Load()!=2{t.Fatal("lost response was not retried once")};select{case <-b.fatal:t.Fatal("successful retry reported fatal");default:}
}
func TestRetryAndFatalBoundaries(t *testing.T){
 for _,tc:=range []struct{method string;status int;body string;attempts int;fatal bool}{{"prepare",200,"{",3,true},{"prepare",403,"",1,true},{"publicWork",200,"{",3,false},{"applySnapshotChunk",200,"{",1,false}}{
  t.Run(tc.method+http.StatusText(tc.status),func(t *testing.T){var requests atomic.Int32;srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){requests.Add(1);w.WriteHeader(tc.status);io.WriteString(w,tc.body)}));defer srv.Close();b:=&bridge{url:srv.URL,client:srv.Client(),fatal:make(chan error,1)};if _,e:=b.call(context.Background(),request{Method:tc.method});e==nil{t.Fatal("expected rejection")};if int(requests.Load())!=tc.attempts{t.Fatalf("attempts %d",requests.Load())};select{case <-b.fatal:if !tc.fatal{t.Fatal("query/snapshot rejection killed consensus")};default:if tc.fatal{t.Fatal("consensus failure not escalated")}}})
 }
}
func TestCancelledCallDoesNotRetry(t *testing.T){
 var requests atomic.Int32;srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){requests.Add(1);io.Copy(io.Discard,r.Body);select{case <-r.Context().Done():case <-time.After(200*time.Millisecond):}}));defer srv.Close();ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel();b:=&bridge{url:srv.URL,client:srv.Client(),fatal:make(chan error,1)};if _,e:=b.call(ctx,request{Method:"prepare"});e==nil{t.Fatal("expected cancellation")};if requests.Load()!=1{t.Fatalf("attempts %d",requests.Load())}
}
func TestSnapshotVerificationHasSeparateTimeoutAndHonorsCancellation(t *testing.T){
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){time.Sleep(80*time.Millisecond);io.WriteString(w,"{}")}));defer srv.Close()
 client:=srv.Client();client.Timeout=10*time.Millisecond;b:=&bridge{url:srv.URL,client:client,fatal:make(chan error,1)}
 if _,e:=b.call(context.Background(),request{Method:"applySnapshotChunk"});e!=nil{t.Fatal(e)}
 if client.Timeout!=10*time.Millisecond{t.Fatal("snapshot changed shared client timeout")}
 ctx,cancel:=context.WithTimeout(context.Background(),10*time.Millisecond);defer cancel()
 if _,e:=b.call(ctx,request{Method:"applySnapshotChunk"});e==nil{t.Fatal("snapshot ignored cancellation")}
 if _,e:=b.callOnce(context.Background(),[]byte(`{"method":"info"}`),"info");e==nil{t.Fatal("ordinary query lost short timeout")}
}

func TestSnapshotRejectionContinuesDiscoveryWithoutAcceptingIncompleteState(t *testing.T){
 for _,tc:=range []struct{body string;want abci.ResponseApplySnapshotChunk_Result}{
  {`{"accept":true}`,abci.ResponseApplySnapshotChunk_ACCEPT},
  {`{"snapshotResult":"reject-snapshot"}`,abci.ResponseApplySnapshotChunk_REJECT_SNAPSHOT},
  {`{"accept":true,"snapshotResult":"reject-snapshot"}`,abci.ResponseApplySnapshotChunk_ABORT},
  {`{"snapshotResult":"unknown"}`,abci.ResponseApplySnapshotChunk_ABORT},
  {`{"error":"failed","snapshotResult":"reject-snapshot"}`,abci.ResponseApplySnapshotChunk_ABORT},
  {`{`,abci.ResponseApplySnapshotChunk_ABORT},
 }{t.Run(tc.body,func(t *testing.T){srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){io.WriteString(w,tc.body)}));defer srv.Close();b:=&bridge{url:srv.URL,client:srv.Client(),fatal:make(chan error,1)};r,e:=b.ApplySnapshotChunk(context.Background(),&abci.RequestApplySnapshotChunk{});if e!=nil||r.Result!=tc.want{t.Fatalf("result %v error %v",r,e)};select{case <-b.fatal:if tc.want!=abci.ResponseApplySnapshotChunk_ABORT{t.Fatal("nonterminal snapshot result stopped discovery")};default:if tc.want==abci.ResponseApplySnapshotChunk_ABORT{t.Fatal("terminal abort left a stalled node running")}}})}
}
