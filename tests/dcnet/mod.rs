use {
	mosaik::{
		PeerId,
		groups::{ApplyContext, LogReplaySync, StateMachine},
		primitives::UniqueId,
	},
	serde::{Deserialize, Serialize},
	std::collections::{BTreeMap, BTreeSet},
};

pub mod attestation;
pub mod mixing;

// ── Constants ───────────────────────────────────────────────

pub const MESSAGE_SIZE: usize = 256;

// ── Types ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contribution {
	pub round: u64,
	pub peer: PeerId,
	pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInput {
	pub round: u64,
	pub data: Vec<u8>,
}

// ── Commands ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetCommand {
	SetParticipants(BTreeSet<PeerId>),
	StartRound(u64),
	Contribute(Contribution),
	AbortRound(u64),
}

// ── Queries ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetQuery {
	CurrentRound,
	RoundOutput(u64),
	ContributionCount,
	Participants,
	IsRoundComplete(u64),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetQueryResult {
	CurrentRound(Option<u64>),
	RoundOutput(Option<Vec<u8>>),
	ContributionCount(usize),
	Participants(BTreeSet<PeerId>),
	IsRoundComplete(bool),
}

// ── State machine ───────────────────────────────────────────

#[derive(Debug)]
pub struct DcNetMixer {
	participants: BTreeSet<PeerId>,
	current_round: Option<u64>,
	contributed: BTreeSet<PeerId>,
	xor_acc: Vec<u8>,
	completed: BTreeMap<u64, Vec<u8>>,
	message_size: usize,
}

impl DcNetMixer {
	pub fn new(message_size: usize) -> Self {
		Self {
			participants: BTreeSet::new(),
			current_round: None,
			contributed: BTreeSet::new(),
			xor_acc: vec![0u8; message_size],
			completed: BTreeMap::new(),
			message_size,
		}
	}
}

impl Default for DcNetMixer {
	fn default() -> Self {
		Self::new(MESSAGE_SIZE)
	}
}

impl StateMachine for DcNetMixer {
	type Command = DcNetCommand;
	type Query = DcNetQuery;
	type QueryResult = DcNetQueryResult;
	type StateSync = LogReplaySync<Self>;

	fn signature(&self) -> UniqueId {
		UniqueId::from("dcnet_mixer_v1").derive(self.message_size.to_le_bytes())
	}

	fn apply(&mut self, command: Self::Command, _ctx: &dyn ApplyContext) {
		match command {
			DcNetCommand::SetParticipants(peers) => {
				self.participants = peers;
				self.current_round = None;
				self.contributed.clear();
				self.xor_acc = vec![0u8; self.message_size];
			}
			DcNetCommand::StartRound(n) => {
				if self.current_round == Some(n) {
					return;
				}
				self.current_round = Some(n);
				self.contributed.clear();
				self.xor_acc = vec![0u8; self.message_size];
			}
			DcNetCommand::Contribute(c) => {
				if self.current_round != Some(c.round) {
					return;
				}
				if c.data.len() != self.message_size {
					return;
				}
				if !self.participants.contains(&c.peer) {
					return;
				}
				if self.contributed.contains(&c.peer) {
					return;
				}
				for (acc, byte) in self.xor_acc.iter_mut().zip(&c.data) {
					*acc ^= byte;
				}
				self.contributed.insert(c.peer);
				if self.contributed.len() == self.participants.len() {
					self.completed.insert(c.round, self.xor_acc.clone());
				}
			}
			DcNetCommand::AbortRound(n) => {
				if self.current_round == Some(n) {
					self.current_round = None;
					self.contributed.clear();
					self.xor_acc = vec![0u8; self.message_size];
				}
			}
		}
	}

	fn query(&self, query: Self::Query) -> Self::QueryResult {
		match query {
			DcNetQuery::CurrentRound => {
				DcNetQueryResult::CurrentRound(self.current_round)
			}
			DcNetQuery::RoundOutput(r) => {
				DcNetQueryResult::RoundOutput(self.completed.get(&r).cloned())
			}
			DcNetQuery::ContributionCount => {
				DcNetQueryResult::ContributionCount(self.contributed.len())
			}
			DcNetQuery::Participants => {
				DcNetQueryResult::Participants(self.participants.clone())
			}
			DcNetQuery::IsRoundComplete(r) => {
				DcNetQueryResult::IsRoundComplete(self.completed.contains_key(&r))
			}
		}
	}

	fn state_sync(&self) -> Self::StateSync {
		LogReplaySync::default()
	}
}

// ── Pad derivation (inline copy for tests) ──────────────────

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

pub fn xor_into(dst: &mut [u8], src: &[u8]) {
	for (d, s) in dst.iter_mut().zip(src) {
		*d ^= s;
	}
}

pub fn compute_contribution(
	group_secret: &[u8; 32],
	my_id: &[u8],
	all_peers: &[&[u8]],
	round: u64,
	message: &[u8],
	msg_size: usize,
) -> Vec<u8> {
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
