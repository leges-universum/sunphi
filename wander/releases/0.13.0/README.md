# SunPhi Wander 0.13.0

Signed release policy for the experimental Wander network. This release adds automatic replacement of unavailable controller assignments using independent observations and the existing global quorum. Durable prepared locks, wallet authorities and token balances are preserved.

This is a public policy mirror, not remote execution attestation. Existing publisher roots currently belong to one owner. The deployed policy is authoritative only after network certification. An outage of GitHub does not stop consensus. Source hashes do not prove that a malicious host runs the claimed code.

Recovery does not lower the global quorum. Minority partitions stop. The current detector observes signed availability replies; it is not a guarantee against every form of selective denial of service. No hidden rotation or independent-operator security is claimed.

Downloads and English instructions: https://wander.sun-phi.com/#download
