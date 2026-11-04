// Offline PSL grouping, vendored tldts 7.0.19 (MIT; TLDTS-LICENSE.txt).
// A domain is a grouping boundary, not proof of independent ownership.
// Private hosting suffixes deliberately remain grouped conservatively.
import {getDomain} from './tldts-vendor.mjs';
export function publisherDomain(url){
 try{return getDomain(new URL(url).hostname.toLowerCase().replace(/\.$/,''),{allowPrivateDomains:false})??null;}catch{return null;}
}
