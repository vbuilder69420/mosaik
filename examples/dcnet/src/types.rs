use {
	mosaik::PeerId,
	serde::{Deserialize, Serialize},
};

/// Fixed message size for the demo (256 bytes per slot).
pub const MESSAGE_SIZE: usize = 256;

/// A node's XOR-blinded contribution for a specific round.
///
/// The `data` field contains the node's message XOR'd with all
/// pairwise pads. Its length must equal [`MESSAGE_SIZE`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contribution {
	pub round: u64,
	pub peer: PeerId,
	pub data: Vec<u8>,
}

/// A plaintext message sent by a client to an aggregator node.
///
/// The aggregator folds this into its own DC-net contribution
/// (XOR'd with pairwise pads) before submitting to the group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInput {
	pub round: u64,
	pub data: Vec<u8>,
}
