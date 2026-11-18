package main

import (
 "bytes"
 "context"
 "encoding/base64"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "testing"
 abci "github.com/cometbft/cometbft/abci/types"
)

func TestValidatorUpdatesReachConsensusWithExactPower(t *testing.T) {
 key:=base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1},32))
 for _,power:=range []int64{0,1,10,12,1000000} {
  srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){json.NewEncoder(w).Encode(response{Updates:[]update{{Key:key,Power:power}}})}))
  b:=&bridge{url:srv.URL,client:srv.Client()}
  result,e:=b.FinalizeBlock(context.Background(),&abci.RequestFinalizeBlock{Height:1});srv.Close()
  if e!=nil||len(result.ValidatorUpdates)!=1||result.ValidatorUpdates[0].Power!=power {t.Fatalf("power %d: %v",power,e)}
 }
}
func TestValidatorUpdatesRejectInvalidKeysPowersDuplicatesAndSize(t *testing.T) {
 key:=base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1},32))
 for _,input:=range [][]update{
  {{Key:key,Power:-1}},{{Key:key,Power:1000001}},{{Key:"bad",Power:10}},
  {{Key:key+"=",Power:10}},{{Key:key,Power:10},{Key:key,Power:0}},make([]update,513),
 } {if _,e:=validatedValidatorUpdates(input);e==nil {t.Fatal("invalid update accepted")}}
}
