// Isolated public-accounting trial. This is not the old mandatory-ZK adapter.
package main
import (
 "bytes"
 "context"
 "encoding/hex"
 "encoding/base64"
 "encoding/json"
 "errors"
 "flag"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/url"
 "os"
 "os/signal"
 "path/filepath"
 "strings"
 "syscall"
 "time"
 abci "github.com/cometbft/cometbft/abci/types"
 cfg "github.com/cometbft/cometbft/config"
 "github.com/cometbft/cometbft/node"
 "github.com/cometbft/cometbft/p2p"
 "github.com/cometbft/cometbft/privval"
 "github.com/cometbft/cometbft/proxy"
 "github.com/spf13/viper"
 cjson "github.com/cometbft/cometbft/libs/json"
 "github.com/cometbft/cometbft/libs/log"
 cmtflags "github.com/cometbft/cometbft/libs/cli/flags"
 rpc "github.com/cometbft/cometbft/rpc/client/http"
 rpctypes "github.com/cometbft/cometbft/rpc/core/types"
 "github.com/cometbft/cometbft/types"
)
type bridge struct {abci.BaseApplication; url string; auth string; client *http.Client; fatal chan error}
type request struct {Method string `json:"method"`; Height int64 `json:"height"`; Time int64 `json:"time"`; Hash []byte `json:"hash"`; Txs [][]byte `json:"txs"`; State []byte `json:"state"`; Chain string `json:"chain"`; Key string `json:"key"`; AppHash string `json:"appHash"`; Snapshot *abci.Snapshot `json:"snapshot,omitempty"`; Chunk []byte `json:"chunk"`; Index uint32 `json:"index"`}
type update struct {Key string `json:"key"`; Power int64 `json:"power"`}
type response struct {Height int64 `json:"height"`; Hash []byte `json:"hash"`; Code uint32 `json:"code"`; Codes []uint32 `json:"codes"`; Txs [][]byte `json:"txs"`; Accept bool `json:"accept"`; Value json.RawMessage `json:"value"`; Error string `json:"error"`; Snapshots []*abci.Snapshot `json:"snapshots"`; Chunk []byte `json:"chunk"`; Updates []update `json:"updates"`}
func retryableCall(method string)bool{switch method{case "info","init","check","prepare","process","finalize","commit","status","snapshot","publicWork","publicCheckpoint","listSnapshots","loadSnapshotChunk":return true};return false}
func criticalCall(method string)bool{switch method{case "info","init","prepare","process","finalize","commit":return true};return false}
func transportFailure(e error)bool{var n net.Error;return errors.Is(e,io.EOF)||errors.Is(e,io.ErrUnexpectedEOF)||errors.Is(e,syscall.ECONNRESET)||errors.Is(e,syscall.EPIPE)||errors.As(e,&n)}
func(b *bridge)callOnce(c context.Context,data []byte,method string)(response,error){var out response;r,e:=http.NewRequestWithContext(c,"POST",b.url,bytes.NewReader(data));if e!=nil{return out,e};r.Header.Set("Content-Type","application/json");r.Header.Set("X-Duebyte-App-Auth",b.auth);client:=b.client;if method=="applySnapshotChunk"{copy:=*client;copy.Timeout=15*time.Minute;client=&copy};s,e:=client.Do(r);if e!=nil{return out,e};defer s.Body.Close();if s.StatusCode!=200{return out,fmt.Errorf("application HTTP %d",s.StatusCode)};e=json.NewDecoder(io.LimitReader(s.Body,8<<20)).Decode(&out);if e==nil&&out.Error!=""{e=fmt.Errorf("application: %s",out.Error)};return out,e}
func(b *bridge)call(c context.Context,q request)(response,error){
 var out response;data,e:=json.Marshal(q);if e!=nil{return out,e}
 // Reuse the exact request only for read-only or idempotent operations.
 // In particular, never replay snapshot restoration after an ambiguous reply.
 for attempt:=0;attempt<3;attempt++{out,e=b.callOnce(c,data,q.Method);if e==nil{return out,nil};if !retryableCall(q.Method)||!transportFailure(e)||c.Err()!=nil||attempt==2{break};b.client.CloseIdleConnections();timer:=time.NewTimer(time.Duration(attempt+1)*100*time.Millisecond);select{case <-c.Done():timer.Stop();e=c.Err();case <-timer.C:};if c.Err()!=nil{break}}
 // Comet catches a consensus-routine panic without terminating the node.
 // Notify the process supervisor instead of leaving a live but stalled signer.
 if criticalCall(q.Method)&&b.fatal!=nil{select{case b.fatal<-fmt.Errorf("private application %s unavailable",q.Method):default:}}
 return out,e
}
func(b *bridge)Info(c context.Context,_ *abci.RequestInfo)(*abci.ResponseInfo,error){r,e:=b.call(c,request{Method:"info"});return &abci.ResponseInfo{Version:"duebyte-checkpoint-trial-0.1",AppVersion:1,LastBlockHeight:r.Height,LastBlockAppHash:r.Hash},e}
func(b *bridge)InitChain(c context.Context,q *abci.RequestInitChain)(*abci.ResponseInitChain,error){r,e:=b.call(c,request{Method:"init",State:q.AppStateBytes,Chain:q.ChainId});return &abci.ResponseInitChain{AppHash:r.Hash},e}
func(b *bridge)CheckTx(c context.Context,q *abci.RequestCheckTx)(*abci.ResponseCheckTx,error){r,e:=b.call(c,request{Method:"check",Txs:[][]byte{q.Tx}});return &abci.ResponseCheckTx{Code:r.Code},e}
func(b *bridge)PrepareProposal(c context.Context,q *abci.RequestPrepareProposal)(*abci.ResponsePrepareProposal,error){r,e:=b.call(c,request{Method:"prepare",Height:q.Height,Time:q.Time.Unix(),Txs:q.Txs});return &abci.ResponsePrepareProposal{Txs:r.Txs},e}
func(b *bridge)ProcessProposal(c context.Context,q *abci.RequestProcessProposal)(*abci.ResponseProcessProposal,error){r,e:=b.call(c,request{Method:"process",Height:q.Height,Time:q.Time.Unix(),Hash:q.Hash,Txs:q.Txs});s:=abci.ResponseProcessProposal_REJECT;if r.Accept{s=abci.ResponseProcessProposal_ACCEPT};return &abci.ResponseProcessProposal{Status:s},e}
// Match the application admission envelope; zero removes an existing voter.
// Authorization and roster transitions remain the application's responsibility.
func validatedValidatorUpdates(input []update)([]abci.ValidatorUpdate,error){
 if len(input)>512{return nil,fmt.Errorf("validator update count")};out:=[]abci.ValidatorUpdate{};seen:=map[string]bool{}
 for _,u:=range input{k,e:=base64.RawURLEncoding.DecodeString(u.Key);if e!=nil||len(k)!=32||base64.RawURLEncoding.EncodeToString(k)!=u.Key||u.Power<0||u.Power>1000000||seen[u.Key]{return nil,fmt.Errorf("validator update")};seen[u.Key]=true;out=append(out,abci.Ed25519ValidatorUpdate(k,u.Power))};return out,nil
}
func(b *bridge)FinalizeBlock(c context.Context,q *abci.RequestFinalizeBlock)(*abci.ResponseFinalizeBlock,error){r,e:=b.call(c,request{Method:"finalize",Height:q.Height,Time:q.Time.Unix(),Hash:q.Hash,Txs:q.Txs});if e!=nil{return nil,e};v:=make([]*abci.ExecTxResult,len(r.Codes));for i,x:=range r.Codes{v[i]=&abci.ExecTxResult{Code:x}};updates,e:=validatedValidatorUpdates(r.Updates);if e!=nil{return nil,e};return &abci.ResponseFinalizeBlock{AppHash:r.Hash,TxResults:v,ValidatorUpdates:updates},nil}
func(b *bridge)Commit(c context.Context,_ *abci.RequestCommit)(*abci.ResponseCommit,error){_,e:=b.call(c,request{Method:"commit"});return &abci.ResponseCommit{},e}
func(b *bridge)Query(c context.Context,q *abci.RequestQuery)(*abci.ResponseQuery,error){if q.Prove||q.Height!=0||len(q.Data)>4096{return &abci.ResponseQuery{Code:1,Log:"use signed header and snapshot verifier"},nil};method:="status";if q.Path=="/snapshot"{method="snapshot"}else if q.Path=="/work"{method="publicWork"}else if q.Path=="/checkpoint"{method="publicCheckpoint"}else if q.Path!=""&&q.Path!="/status"{return &abci.ResponseQuery{Code:1,Log:"unknown query"},nil};r,e:=b.call(c,request{Method:method,Key:string(q.Data)});if e!=nil{return &abci.ResponseQuery{Code:1,Log:"unavailable"},nil};return &abci.ResponseQuery{Value:r.Value,Height:r.Height},nil}
func(b *bridge)ListSnapshots(c context.Context,_ *abci.RequestListSnapshots)(*abci.ResponseListSnapshots,error){r,e:=b.call(c,request{Method:"listSnapshots"});return &abci.ResponseListSnapshots{Snapshots:r.Snapshots},e}
func(b *bridge)OfferSnapshot(c context.Context,q *abci.RequestOfferSnapshot)(*abci.ResponseOfferSnapshot,error){r,e:=b.call(c,request{Method:"offerSnapshot",Snapshot:q.Snapshot,AppHash:hex.EncodeToString(q.AppHash)});v:=abci.ResponseOfferSnapshot_REJECT;if e==nil&&r.Accept{v=abci.ResponseOfferSnapshot_ACCEPT};return &abci.ResponseOfferSnapshot{Result:v},nil}
func(b *bridge)LoadSnapshotChunk(c context.Context,q *abci.RequestLoadSnapshotChunk)(*abci.ResponseLoadSnapshotChunk,error){r,e:=b.call(c,request{Method:"loadSnapshotChunk",Height:int64(q.Height),Index:q.Chunk});if e!=nil{return &abci.ResponseLoadSnapshotChunk{},nil};return &abci.ResponseLoadSnapshotChunk{Chunk:r.Chunk},nil}
func(b *bridge)ApplySnapshotChunk(c context.Context,q *abci.RequestApplySnapshotChunk)(*abci.ResponseApplySnapshotChunk,error){r,e:=b.call(c,request{Method:"applySnapshotChunk",Chunk:q.Chunk,Index:q.Index});v:=abci.ResponseApplySnapshotChunk_ABORT;if e==nil&&r.Accept{v=abci.ResponseApplySnapshotChunk_ACCEPT};return &abci.ResponseApplySnapshotChunk{Result:v},nil}
type proof struct{Version int `json:"version"`; Headers []*types.SignedHeader `json:"headers"`; Sets map[string][]*types.Validator `json:"sets,omitempty"`}
// Resource envelope shared with validator-authority.mjs, not a throughput claim.
const maxProofValidators=256
func validateProofValidators(vs []*types.Validator,version int)error{
 if (version==1&&len(vs)!=10)||(version==2&&(len(vs)<4||len(vs)>maxProofValidators))||(version!=1&&version!=2){return fmt.Errorf("validator set bounds")}
 seen:=map[string]bool{}
 for _,v:=range vs{if v==nil||v.PubKey==nil||v.PubKey.Type()!="ed25519"||len(v.PubKey.Bytes())!=32||!bytes.Equal(v.Address,v.PubKey.Address())||seen[string(v.Address)]||v.VotingPower<1||v.VotingPower>1000000||(version==1&&v.VotingPower!=10){return fmt.Errorf("invalid validator set")};seen[string(v.Address)]=true};return nil
}
func genesisProofAuthority(g *types.GenesisDoc)(*types.ValidatorSet,int,error){
 var app struct{Control *struct{Version *int `json:"version"`; Validators []struct{Key string `json:"key"`;Power int64 `json:"power"`} `json:"validators"`} `json:"control"`}
 if e:=json.Unmarshal(g.AppState,&app);e!=nil{return nil,0,fmt.Errorf("genesis application authority: %w",e)}
 version:=1;if app.Control!=nil&&app.Control.Version!=nil{version=*app.Control.Version};if version!=1&&version!=2{return nil,0,fmt.Errorf("unknown genesis authority version")}
 vals:=[]*types.Validator{};for _,v:=range g.Validators{if v.PubKey==nil{return nil,0,fmt.Errorf("missing genesis key")};vals=append(vals,types.NewValidator(v.PubKey,v.Power))}
 if e:=validateProofValidators(vals,version);e!=nil{return nil,0,e}
 if app.Control!=nil{
  expected:=map[string]int64{};for _,v:=range app.Control.Validators{k,e:=base64.RawURLEncoding.DecodeString(v.Key);if e!=nil||len(k)!=32||base64.RawURLEncoding.EncodeToString(k)!=v.Key{return nil,0,fmt.Errorf("genesis authority key")};if _,ok:=expected[v.Key];ok{return nil,0,fmt.Errorf("duplicate application validator")};power:=int64(10);if version==2{power=v.Power};expected[v.Key]=power}
  if len(expected)!=len(vals){return nil,0,fmt.Errorf("genesis authority count")};for _,v:=range vals{if expected[base64.RawURLEncoding.EncodeToString(v.PubKey.Bytes())]!=v.VotingPower{return nil,0,fmt.Errorf("genesis authority key or power mismatch")}}
 }
 return types.NewValidatorSet(vals),version,nil
}
type validatorPageSource interface{Validators(context.Context,*int64,*int,*int)(*rpctypes.ResultValidators,error)}
func fetchProofValidators(ctx context.Context,c validatorPageSource,height int64,expectedHash []byte,version int)([]*types.Validator,error){
 // Fix the height, bound the total, and verify the assembled hash. Pagination
 // must never silently authenticate just the first page of a larger roster.
 vals:=[]*types.Validator{};total:=-1;per:=100
 for page:=1;;page++{v,e:=c.Validators(ctx,&height,&page,&per);if e!=nil{return nil,e};if v==nil||v.BlockHeight!=height||v.Total<1||v.Total>maxProofValidators{return nil,fmt.Errorf("validator page bounds")};if total==-1{total=v.Total};if total!=v.Total{return nil,fmt.Errorf("validator page total changed")};want:=total-len(vals);if want>per{want=per};if v.Count!=want||len(v.Validators)!=want{return nil,fmt.Errorf("incomplete validator page")};vals=append(vals,v.Validators...);if len(vals)==total{break}}
 if e:=validateProofValidators(vals,version);e!=nil{return nil,e};if !bytes.Equal(types.NewValidatorSet(vals).Hash(),expectedHash){return nil,fmt.Errorf("validator page hash mismatch")};return vals,nil
}
func check(a proof,g *types.GenesisDoc,h int64,pin string,fresh bool)(map[string]interface{},error){
 if (a.Version!=1&&a.Version!=2)||len(a.Headers)<1||len(a.Headers)>512||len(a.Sets)>512||h<1{return nil,fmt.Errorf("proof bounds")};p,e:=hex.DecodeString(pin);if e!=nil||len(p)!=32{return nil,fmt.Errorf("trusted hash")};initial,authorityVersion,e:=genesisProofAuthority(g);if e!=nil{return nil,e};if authorityVersion==2&&a.Version!=2{return nil,fmt.Errorf("linked validator sets required")}
 var prev *types.SignedHeader
 for i,s:=range a.Headers{if s==nil||s.Header==nil||s.Commit==nil{return nil,fmt.Errorf("missing header")};if e=s.ValidateBasic(g.ChainID);e!=nil{return nil,e};set:=initial
 if a.Version==2{vs,ok:=a.Sets[hex.EncodeToString(s.ValidatorsHash)];if !ok{return nil,fmt.Errorf("missing validator set")};if e=validateProofValidators(vs,authorityVersion);e!=nil{return nil,e};set=types.NewValidatorSet(vs)}
 if !bytes.Equal(s.Hash(),s.Commit.BlockID.Hash)||!bytes.Equal(s.ValidatorsHash,set.Hash()){return nil,fmt.Errorf("header/set mismatch")};if a.Version==1&&!bytes.Equal(s.NextValidatorsHash,initial.Hash()){return nil,fmt.Errorf("static proof changed set")};if s.Height==1&&!bytes.Equal(s.ValidatorsHash,initial.Hash()){return nil,fmt.Errorf("genesis set mismatch")};if i==0&&(s.Height!=h||!bytes.Equal(s.Hash(),p)){return nil,fmt.Errorf("trusted anchor mismatch")};if prev!=nil&&(s.Height!=prev.Height+1||!s.LastBlockID.Equals(prev.Commit.BlockID)||!s.Time.After(prev.Time)||!bytes.Equal(prev.NextValidatorsHash,s.ValidatorsHash)){return nil,fmt.Errorf("broken ancestry or validator transition")};if e=set.VerifyCommitLight(g.ChainID,s.Commit.BlockID,s.Height,s.Commit);e!=nil{return nil,e};prev=s}
 age:=time.Since(prev.Time);if fresh&&(age>180*time.Second||age< -30*time.Second){return nil,fmt.Errorf("stale/future head")};return map[string]interface{}{"verified":true,"height":prev.Height,"blockHash":hex.EncodeToString(prev.Hash()),"appHeight":prev.Height-1,"appHash":hex.EncodeToString(prev.AppHash),"headerCount":len(a.Headers)},nil
}
func main(){home:=flag.String("home","","existing configured node home (no ABCI socket)");app:=flag.Int("app",29059,"local private application port");file:=flag.String("verify-file","","offline linked headers");endpoint:=flag.String("export","","loopback RPC for linked headers");gen:=flag.String("genesis","","trusted genesis");at:=flag.Int64("anchor-height",0,"trusted height");pin:=flag.String("anchor-hash","","trusted hash");end:=flag.Int64("end",0,"last height");historical:=flag.Bool("historical",false,"ancestry check only, not fresh");flag.Parse()
 if *file!=""||*endpoint!=""{
  g,e:=types.GenesisDocFromFile(*gen);if e!=nil{panic(e)};_,authorityVersion,e:=genesisProofAuthority(g);if e!=nil{panic(e)};a:=proof{Version:2,Sets:map[string][]*types.Validator{}}
  if *endpoint!=""{
   u,e:=url.Parse(*endpoint);if e!=nil||u.Scheme!="http"||u.Hostname()!="127.0.0.1"{panic("loopback RPC required")};c,e:=rpc.New(*endpoint,"/websocket");if e!=nil{panic(e)}
   ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second);defer cancel()
   if *end==0{r,e:=c.Commit(ctx,nil);if e!=nil{panic(e)};*end=r.Header.Height};if *end<*at||*end-*at>=512{panic("tail window")}
   for n:=*at;n<=*end;n++{
    r,e:=c.Commit(ctx,&n);if e!=nil{panic(e)};a.Headers=append(a.Headers,&r.SignedHeader)
    id:=hex.EncodeToString(r.Header.ValidatorsHash)
    if _,ok:=a.Sets[id];!ok{vs,e:=fetchProofValidators(ctx,c,n,r.Header.ValidatorsHash,authorityVersion);if e!=nil{panic(e)};a.Sets[id]=vs}
   }
  }else{st,e:=os.Stat(*file);if e!=nil||st.Size()>8<<20{panic("proof size")};b,e:=os.ReadFile(*file);if e!=nil{panic(e)};if e=cjson.Unmarshal(b,&a);e!=nil{panic(e)}}
  r,e:=check(a,g,*at,*pin,!*historical);if e!=nil{fmt.Fprintln(os.Stderr,e);os.Exit(1)}
  if *endpoint!=""{b,e:=cjson.Marshal(a);if e!=nil{panic(e)};if len(b)>8<<20{panic("proof size; use a shorter recovery window")};os.Stdout.Write(b)}else{json.NewEncoder(os.Stdout).Encode(r)};return
 }
 if *home==""{panic("configured home required; network ABCI is disabled")}
 root,e:=filepath.Abs(*home);if e!=nil{panic(e)}
 c:=cfg.DefaultConfig();v:=viper.New();v.SetConfigFile(filepath.Join(root,"config","config.toml"));if e=v.ReadInConfig();e!=nil{panic(e)};if e=v.Unmarshal(c);e!=nil{panic(e)};c.SetRoot(root);if e=c.ValidateBasic();e!=nil{panic(e)}
 // Never generate replacement signing material during a restart or migration.
 for _,p:=range []string{c.PrivValidatorKeyFile(),c.PrivValidatorStateFile(),c.NodeKeyFile()}{if _,e=os.Stat(p);e!=nil{panic(e)}}
 raw,e:=os.ReadFile(filepath.Join(root,"application-auth"));if e!=nil{panic(e)};auth:=strings.TrimSpace(string(raw));decoded,e:=hex.DecodeString(auth);if e!=nil||len(decoded)!=32{panic("invalid application capability")}
 b:=&bridge{url:fmt.Sprintf("http://127.0.0.1:%d",*app),auth:auth,client:&http.Client{Timeout:20*time.Second},fatal:make(chan error,1)}
 key,e:=p2p.LoadNodeKey(c.NodeKeyFile());if e!=nil{panic(e)}
 logger,e:=cmtflags.ParseLogLevel(c.LogLevel,log.NewTMLogger(log.NewSyncWriter(os.Stdout)),cfg.DefaultLogLevel);if e!=nil{panic(e)}
 s,e:=node.NewNode(c,privval.LoadFilePV(c.PrivValidatorKeyFile(),c.PrivValidatorStateFile()),key,proxy.NewLocalClientCreator(b),node.DefaultGenesisDocProviderFunc(c),cfg.DefaultDBProvider,node.DefaultMetricsProvider(c.Instrumentation),logger);if e!=nil{panic(e)}
 if e=s.Start();e!=nil{panic(e)};stop:=make(chan os.Signal,1);signal.Notify(stop,os.Interrupt,syscall.SIGTERM);failed:=false;select{case <-stop:case e=<-b.fatal:fmt.Fprintln(os.Stderr,e);failed=true};if failed{time.AfterFunc(10*time.Second,func(){os.Exit(1)})};_ = s.Stop();s.Wait();if failed{os.Exit(1)}
}
