// SunPhi isolated ABCI bridge. CometBFT orders blocks; each local application
// independently checks mandatory ZK proofs. No connection to an external chain.
package main

import (
 "bytes"
 "context"
 "encoding/json"
 "encoding/hex"
 "flag"
 "fmt"
 "io"
 "net/http"
 "os"
 "os/signal"
 "time"
 abci "github.com/cometbft/cometbft/abci/types"
 server "github.com/cometbft/cometbft/abci/server"
 "github.com/cometbft/cometbft/libs/log"
)
type bridge struct { abci.BaseApplication; url string; client *http.Client }
type request struct { Method string `json:"method"`; Height int64 `json:"height"`; Txs [][]byte `json:"txs"`; Hash []byte `json:"hash"`; Chain string `json:"chain"`; State []byte `json:"state"`; MaxBytes int64 `json:"maxBytes"`; Key string `json:"key"` }
type keyUpdate struct { Key string `json:"key"`; Power int64 `json:"power"` }
type response struct { Height int64 `json:"height"`; Hash []byte `json:"hash"`; Code uint32 `json:"code"`; Txs [][]byte `json:"txs"`; Codes []uint32 `json:"codes"`; Accept bool `json:"accept"`; Value json.RawMessage `json:"value"`; Error string `json:"error"`; Updates []keyUpdate `json:"updates"` }
func (b *bridge) call(ctx context.Context,r request)(response,error){
 var out response
 data,e:=json.Marshal(r); if e!=nil{return out,e}
 req,e:=http.NewRequestWithContext(ctx,"POST",b.url,bytes.NewReader(data)); if e!=nil{return out,e}
 req.Header.Set("Content-Type","application/json")
 res,e:=b.client.Do(req); if e!=nil{return out,e}; defer res.Body.Close()
 if res.StatusCode!=200{return out,fmt.Errorf("local application HTTP %d",res.StatusCode)}
 e=json.NewDecoder(io.LimitReader(res.Body,2<<20)).Decode(&out)
 if e==nil && out.Error!="" {e=fmt.Errorf("application: %s",out.Error)}
 return out,e
}
func(b *bridge) Info(c context.Context,_ *abci.RequestInfo)(*abci.ResponseInfo,error){r,e:=b.call(c,request{Method:"info"});return &abci.ResponseInfo{Version:"sunphi-lab-0.2",AppVersion:2,LastBlockHeight:r.Height,LastBlockAppHash:r.Hash},e}
func(b *bridge) InitChain(c context.Context,q *abci.RequestInitChain)(*abci.ResponseInitChain,error){
 var cfg struct { Governance *struct { Members []struct {Key string `json:"key"`} `json:"members"` } `json:"governance"` }
 if e:=json.Unmarshal(q.AppStateBytes,&cfg);e!=nil{return nil,e}
 if cfg.Governance!=nil{
  if len(cfg.Governance.Members)!=10||len(q.Validators)!=10{return nil,fmt.Errorf("governance/genesis size mismatch")}
  keys:=map[string]bool{};for _,v:=range q.Validators{if v.Power!=10||len(v.PubKey.GetEd25519())!=32{return nil,fmt.Errorf("equal Ed25519 seats required")};keys[hex.EncodeToString(v.PubKey.GetEd25519())]=true}
  for _,m:=range cfg.Governance.Members{if !keys[m.Key]{return nil,fmt.Errorf("governance/genesis key mismatch")};delete(keys,m.Key)}
 }
 r,e:=b.call(c,request{Method:"init",Chain:q.ChainId,State:q.AppStateBytes});return &abci.ResponseInitChain{AppHash:r.Hash},e
}
func(b *bridge) CheckTx(c context.Context,q *abci.RequestCheckTx)(*abci.ResponseCheckTx,error){r,e:=b.call(c,request{Method:"check",Txs:[][]byte{q.Tx}});return &abci.ResponseCheckTx{Code:r.Code},e}
func(b *bridge) PrepareProposal(c context.Context,q *abci.RequestPrepareProposal)(*abci.ResponsePrepareProposal,error){r,e:=b.call(c,request{Method:"prepare",Height:q.Height,Txs:q.Txs,MaxBytes:q.MaxTxBytes});return &abci.ResponsePrepareProposal{Txs:r.Txs},e}
func(b *bridge) ProcessProposal(c context.Context,q *abci.RequestProcessProposal)(*abci.ResponseProcessProposal,error){r,e:=b.call(c,request{Method:"process",Height:q.Height,Txs:q.Txs});s:=abci.ResponseProcessProposal_REJECT;if r.Accept{s=abci.ResponseProcessProposal_ACCEPT};return &abci.ResponseProcessProposal{Status:s},e}
func(b *bridge) FinalizeBlock(c context.Context,q *abci.RequestFinalizeBlock)(*abci.ResponseFinalizeBlock,error){
 r,e:=b.call(c,request{Method:"finalize",Height:q.Height,Txs:q.Txs,Hash:q.Hash});if e!=nil{return nil,e}
 v:=make([]*abci.ExecTxResult,len(r.Codes));for i,x:=range r.Codes {v[i]=&abci.ExecTxResult{Code:x}}
 updates:=[]abci.ValidatorUpdate{};for _,u:=range r.Updates{k,err:=hex.DecodeString(u.Key);if err!=nil||len(k)!=32||(u.Power!=0&&u.Power!=10){return nil,fmt.Errorf("invalid validator update")};updates=append(updates,abci.Ed25519ValidatorUpdate(k,u.Power))}
 return &abci.ResponseFinalizeBlock{AppHash:r.Hash,TxResults:v,ValidatorUpdates:updates},nil
}
func(b *bridge) Commit(c context.Context,_ *abci.RequestCommit)(*abci.ResponseCommit,error){_,e:=b.call(c,request{Method:"commit"});return &abci.ResponseCommit{},e}
func(b *bridge) Query(c context.Context,q *abci.RequestQuery)(*abci.ResponseQuery,error){if q.Prove||q.Height!=0{return &abci.ResponseQuery{Code:1,Log:"use authenticated checkpoint verifier; historical queries unsupported"},nil};m:="status";if q.Path=="/passport"{m="passport"};if q.Path=="/governance"{m="governance"};if q.Path=="/receipt"{m="receipt"};r,e:=b.call(c,request{Method:m,Key:string(q.Data)});if e!=nil{return &abci.ResponseQuery{Code:1,Log:"query unavailable"},nil};return &abci.ResponseQuery{Value:r.Value,Height:r.Height},nil}
func main(){
 port:=flag.Int("port",29058,"loopback ABCI socket port");app:=flag.Int("app",29059,"loopback application HTTP port")
 verifyRPC:=flag.String("verify","","verify a checkpoint from a loopback RPC");genesis:=flag.String("genesis","","independently trusted genesis file");height:=flag.Int64("height",0,"signed header height");expected:=flag.String("app-hash","","expected application hash (hex)")
 anchorHeight:=flag.Int64("trusted-height",0,"previous independently retained header height");anchorHash:=flag.String("trusted-hash","","previous independently retained header hash; NEVER obtained as a trust claim from RPC")
 exportHistory:=flag.String("export-history","","export bounded history from isolated RPC");verifyHistory:=flag.String("verify-history","","verify an offline archive file")
 exportReceipt:=flag.String("export-receipt-proof","","export linked receipt headers");verifyReceipt:=flag.String("verify-receipt-proof","","verify portable receipt headers");flag.Parse()
 if *exportReceipt!=""||*verifyReceipt!=""{if e:=receiptCommand(*exportReceipt,*genesis,*verifyReceipt,*height,*anchorHeight,*anchorHash);e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)};return}
 if *exportHistory!=""||*verifyHistory!=""{if e:=historyCommand(*exportHistory,*genesis,*verifyHistory,*height,*anchorHeight,*anchorHash);e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)};return}
 if *verifyRPC!="" {if e:=verifyLinkedCheckpoint(*verifyRPC,*genesis,*height,*expected,*anchorHeight,*anchorHash);e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)};return}
 b:=&bridge{url:fmt.Sprintf("http://127.0.0.1:%d",*app),client:&http.Client{Timeout:120*time.Second}}
 s,e:=server.NewServer(fmt.Sprintf("tcp://127.0.0.1:%d",*port),"socket",b);if e!=nil{panic(e)}
 s.SetLogger(log.NewTMLogger(log.NewSyncWriter(os.Stdout)))
 if e=s.Start();e!=nil{panic(e)}
 stop:=make(chan os.Signal,1);signal.Notify(stop,os.Interrupt);<-stop;_ = s.Stop()
}
