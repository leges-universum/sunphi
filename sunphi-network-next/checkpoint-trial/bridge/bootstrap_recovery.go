package main

import (
 "bytes"
 "context"
 "fmt"
 cfg "github.com/cometbft/cometbft/config"
 "github.com/cometbft/cometbft/light"
 "github.com/cometbft/cometbft/libs/log"
 "github.com/cometbft/cometbft/node"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/statesync"
 "github.com/cometbft/cometbft/store"
 "github.com/cometbft/cometbft/types"
)

// The normal ABCI snapshot protocol publishes app state before Comet saves its
// own state. A lost final reply must not require deleting that verified history.
// Use Comet's existing light state provider to recover ONLY empty consensus
// stores. All writes are repeatable after interruption; no signer is recreated.
func recoverPublishedBootstrap(ctx context.Context,c *cfg.Config,b *bridge,logger log.Logger) error {
 if !c.StateSync.Enable{return fmt.Errorf("bootstrap recovery requires configured state sync")}
 blockDB,e:=cfg.DefaultDBProvider(&cfg.DBContext{ID:"blockstore",Config:c});if e!=nil{return e}
 blocks:=store.NewBlockStore(blockDB);defer blocks.Close()
 if blocks.Height()>0{return nil} // Ordinary committed-block replay owns this case.
 stateDB,e:=cfg.DefaultDBProvider(&cfg.DBContext{ID:"state",Config:c});if e!=nil{return e}
 states:=sm.NewStore(stateDB,sm.StoreOptions{DiscardABCIResponses:c.Storage.DiscardABCIResponses});defer states.Close()
 r,e:=b.call(ctx,request{Method:"bootstrapRecovery"});if e!=nil{return e}
 if r.Height<1||len(r.Hash)!=32||r.AnchorHeight<r.Height||len(r.AnchorHash)!=32{return fmt.Errorf("bootstrap recovery authority bounds")}
 genesis,e:=node.DefaultGenesisDocProviderFunc(c)();if e!=nil{return e}
 gen,e:=sm.MakeGenesisState(genesis);if e!=nil{return e}
 provider,e:=statesync.NewLightClientStateProvider(ctx,gen.ChainID,gen.Version,gen.InitialHeight,c.StateSync.RPCServers,light.TrustOptions{Period:c.StateSync.TrustPeriod,Height:r.AnchorHeight,Hash:r.AnchorHash},logger);if e!=nil{return e}
 verified,e:=provider.State(ctx,uint64(r.Height));if e!=nil{return e}
 commit,e:=provider.Commit(ctx,uint64(r.Height));if e!=nil{return e}
 return publishRecoveredBootstrap(states,blocks,verified,commit,r.Hash,func()error{return blockDB.SetSync([]byte("duebyte/bootstrap-seen-commit-durable/v1"),[]byte{1})},func(string)error{return nil})
}

func publishRecoveredBootstrap(states sm.Store,blocks *store.BlockStore,verified sm.State,commit *types.Commit,root []byte,durable func()error,after func(string)error)error{
 if blocks.Height()!=0||verified.LastBlockHeight<1||len(root)!=32||!bytes.Equal(verified.AppHash,root)||commit==nil||commit.Height!=verified.LastBlockHeight||!commit.BlockID.Equals(verified.LastBlockID){return fmt.Errorf("bootstrap recovery commitment mismatch")}
 prior,e:=states.Load();if e!=nil{return e}
 if prior.LastBlockHeight!=0&&(prior.LastBlockHeight!=verified.LastBlockHeight||prior.ChainID!=verified.ChainID||!bytes.Equal(prior.AppHash,root)){return fmt.Errorf("bootstrap recovery cannot replace existing consensus history")}
 // Store.Bootstrap writes one synchronous batch; replaying the same independently
 // verified height also repairs a crash between this batch and the seen commit.
 if e=states.Bootstrap(verified);e!=nil{return e};if e=after("state");e!=nil{return e}
 if e=blocks.SaveSeenCommit(verified.LastBlockHeight,commit);e!=nil{return e};if e=durable();e!=nil{return e};if e=after("commit");e!=nil{return e}
 if e=states.SetOfflineStateSyncHeight(verified.LastBlockHeight);e!=nil{return e};return after("height")
}
