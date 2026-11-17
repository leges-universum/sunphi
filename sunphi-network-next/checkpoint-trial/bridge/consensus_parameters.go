package main

import (
 "fmt"
 "time"
 cfg "github.com/cometbft/cometbft/config"
 "github.com/cometbft/cometbft/node"
 sm "github.com/cometbft/cometbft/state"
 "github.com/cometbft/cometbft/types"
)

// The application's bonded-stake retention and the bridge's expansion budget
// must agree with the actual Comet parameters, including after state sync.
// No public RPC observation or local clock can relax these constraints.
func checkSlashingParameters(p types.ConsensusParams) error {
 if p.Evidence.MaxAgeNumBlocks!=100000 || p.Evidence.MaxAgeDuration!=172800*time.Second || p.Evidence.MaxBytes>1048576 || p.Evidence.MaxBytes<1 || p.Block.MaxBytes>1048576 || p.Block.MaxBytes<1 || p.ABCI.VoteExtensionsEnableHeight!=0 {
  return fmt.Errorf("Comet parameters incompatible with PoS retention or request bounds")
 }
 return nil
}
func (b *bridge) checkSlashingConsensusParameters() error {
 if b.consensusParameters==nil{return fmt.Errorf("Comet parameters unavailable for PoS")}
 p,e:=b.consensusParameters();if e!=nil{return e};return checkSlashingParameters(p)
}
// Load before NewNode's handshake, then close our handle. After construction
// the bridge uses Comet's own state store, avoiding a second writer/DB handle.
func loadConsensusParameters(c *cfg.Config)(types.ConsensusParams,error){
 db,e:=cfg.DefaultDBProvider(&cfg.DBContext{ID:"state",Config:c});if e!=nil{return types.ConsensusParams{},e}
 store:=sm.NewStore(db,sm.StoreOptions{DiscardABCIResponses:c.Storage.DiscardABCIResponses});state,e:=store.Load();closeError:=store.Close();if e!=nil{return types.ConsensusParams{},e};if closeError!=nil{return types.ConsensusParams{},closeError}
 if !state.IsEmpty(){return state.ConsensusParams,nil}
 genesis,e:=node.DefaultGenesisDocProviderFunc(c)();if e!=nil{return types.ConsensusParams{},e};state,e=sm.MakeGenesisState(genesis);return state.ConsensusParams,e
}
