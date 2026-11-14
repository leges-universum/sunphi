// Prepare exact public bytes for release signing, after archive and quorum checks.
// This module never signs, publishes, activates a profile or issues tokens.
import assert from 'node:assert/strict';
import {hash,integer,exact} from './crypto.mjs';
import {sha256} from './update-core.mjs';
import {validateConsumerProfile} from './consumer-profile.mjs';
import {validateTransitionDelivery} from './profile-delivery.mjs';
import {verifyBoundedRootTransition} from './research/bounded-root-transition.mjs';
export function prepareTransitionProfile({original,originalHash,source,certificate,handler,trustedSourceRoot,route,sequence,issuedAt,expiresAt,now=Math.floor(Date.now()/1000)}){
 validateConsumerProfile(original,originalHash);assert(!original.indexed,'legacy predecessor required');
 exact(route,['hostIndex','localPort','remotePort','readPort']);integer(route.hostIndex);assert(route.hostIndex<original.hosts.length);
 const terms=verifyBoundedRootTransition(certificate,source,original.config,handler,trustedSourceRoot);
 const profile=structuredClone(original);profile.hosts[route.hostIndex].forwards.push([route.localPort,route.remotePort]);
 profile.indexed={previousProfileHash:originalHash,readPort:route.readPort,url:'http://127.0.0.1:'+route.localPort,source:structuredClone(source),certificate:structuredClone(certificate)};
 const body={domain:'DUEBYTE_HOME_PROFILE_DELIVERY_V1',sequence,fromProfileHash:originalHash,toProfileHash:hash(profile),minimumVersion:'0.3.42',issuedAt,expiresAt,profile};
 validateTransitionDelivery(body,{edition:'home',version:body.minimumVersion,networkPin:originalHash},original,now);
 const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');assert(bytes.length<=16*1048576,'profile exceeds signed transport budget');
 return {body,bytes,review:{domain:'DUEBYTE_PROFILE_SIGNING_REVIEW_V1',target:'home-indexed-profile.json',sha256:sha256(bytes),length:bytes.length,network:terms.network,configHash:terms.configHash,sourceHeight:terms.sourceHeight,activationHeight:terms.activationHeight,sourceRoot:terms.sourceRoot,targetRoot:terms.targetRoot,archiveDigest:terms.archive.digest,archiveRows:terms.archive.count,transitionHash:hash(certificate),predecessor:originalHash,successor:body.toProfileHash,releaseSignatureRequired:true,profilePublished:false,active:false,issuance:false}};
}
