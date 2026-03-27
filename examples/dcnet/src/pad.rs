//! Pairwise pad derivation for DC-net mixing.
//!
//! # Security note
//!
//! This simplified scheme derives pairwise pads from the shared
//! group key, which means **any group member can compute any
//! pairwise pad and deanonymize any other member**. This is a
//! placeholder for the demo.
//!
//! In production, per-pair ECDH inside a TEE prevents extraction.
//! See <https://github.com/flashbots/adcnet> for the production
//! protocol.

/// Derive a deterministic pad for the pair (`peer_a`, `peer_b`)
/// at a given `round`, seeded by the `group_secret`.
///
/// The pad is symmetric: `derive_pad(s, a, b, r, n)` ==
/// `derive_pad(s, b, a, r, n)` because peer bytes are sorted
/// before hashing.
pub fn derive_pad(
	group_secret: &[u8; 32],
	peer_a: &[u8],
	peer_b: &[u8],
	round: u64,
	len: usize,
) -> Vec<u8> {
	let (lo, hi) = if peer_a <= peer_b {
		(peer_a, peer_b)
	} else {
		(peer_b, peer_a)
	};

	let mut hasher = blake3::Hasher::new_derive_key("dcnet-pairwise-pad-v1");
	hasher.update(group_secret);
	hasher.update(lo);
	hasher.update(hi);
	hasher.update(&round.to_le_bytes());

	let mut output = vec![0u8; len];
	hasher.finalize_xof().fill(&mut output);
	output
}

/// XOR `src` into `dst` element-wise.
///
/// # Panics
///
/// Panics if `dst` and `src` have different lengths.
pub fn xor_into(dst: &mut [u8], src: &[u8]) {
	assert_eq!(
		dst.len(),
		src.len(),
		"xor_into: length mismatch ({} vs {})",
		dst.len(),
		src.len(),
	);
	for (d, s) in dst.iter_mut().zip(src) {
		*d ^= s;
	}
}

/// Compute a node's DC-net contribution for a round.
///
/// `message` is the plaintext (or all zeros for cover traffic).
/// The result is `message XOR pad(me, p1) XOR pad(me, p2) …`.
///
/// # Panics
///
/// Panics if `message.len() != msg_size`.
pub fn compute_contribution(
	group_secret: &[u8; 32],
	my_id: &[u8],
	all_peers: &[&[u8]],
	round: u64,
	message: &[u8],
	msg_size: usize,
) -> Vec<u8> {
	assert_eq!(
		message.len(),
		msg_size,
		"message length must equal msg_size",
	);
	let mut result = message.to_vec();
	for peer in all_peers {
		if *peer == my_id {
			continue;
		}
		let pad = derive_pad(group_secret, my_id, peer, round, msg_size);
		xor_into(&mut result, &pad);
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pad_is_symmetric() {
		let secret = [42u8; 32];
		let a = [1u8; 32];
		let b = [2u8; 32];
		let p1 = derive_pad(&secret, &a, &b, 1, 64);
		let p2 = derive_pad(&secret, &b, &a, 1, 64);
		assert_eq!(p1, p2);
	}

	#[test]
	fn different_rounds_produce_different_pads() {
		let secret = [42u8; 32];
		let a = [1u8; 32];
		let b = [2u8; 32];
		let p1 = derive_pad(&secret, &a, &b, 1, 64);
		let p2 = derive_pad(&secret, &a, &b, 2, 64);
		assert_ne!(p1, p2);
	}
}
