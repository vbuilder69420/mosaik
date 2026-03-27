use {
	crate::types::{Contribution, MESSAGE_SIZE},
	mosaik::{
		PeerId,
		groups::{ApplyContext, LogReplaySync, StateMachine},
		primitives::UniqueId,
	},
	serde::{Deserialize, Serialize},
	std::collections::{BTreeMap, BTreeSet},
};

// ── Commands ────────────────────────────────────────────────

/// Commands for the DC-net mixer replicated state machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetCommand {
	/// Set (or replace) the participant set for subsequent
	/// rounds. Peers are stored in canonical order.
	SetParticipants(BTreeSet<PeerId>),

	/// Begin a new round. Idempotent — ignored if the round is
	/// already active.
	StartRound(u64),

	/// Submit a blinded contribution for the current round.
	Contribute(Contribution),

	/// Abort a stuck round (external timeout). The round
	/// produces no output.
	AbortRound(u64),
}

// ── Queries ─────────────────────────────────────────────────

/// Queries against the DC-net mixer state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetQuery {
	/// Current active round number (if any).
	CurrentRound,
	/// Output of a completed round (None if not yet complete).
	RoundOutput(u64),
	/// Number of contributions received for the active round.
	ContributionCount,
	/// The registered participant set.
	Participants,
	/// Whether a specific round has completed.
	IsRoundComplete(u64),
}

/// Query results.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DcNetQueryResult {
	CurrentRound(Option<u64>),
	RoundOutput(Option<Vec<u8>>),
	ContributionCount(usize),
	Participants(BTreeSet<PeerId>),
	IsRoundComplete(bool),
}

// ── State machine ───────────────────────────────────────────

/// The DC-net mixer replicated state machine.
///
/// Tracks rounds, collects XOR-blinded contributions, and
/// produces the round output when all participants have
/// contributed.
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
				// Reset any active round when participants change.
				self.current_round = None;
				self.contributed.clear();
				self.xor_acc = vec![0u8; self.message_size];
			}

			DcNetCommand::StartRound(n) => {
				// Idempotent: ignore if already on this round.
				if self.current_round == Some(n) {
					return;
				}
				self.current_round = Some(n);
				self.contributed.clear();
				self.xor_acc = vec![0u8; self.message_size];
			}

			DcNetCommand::Contribute(c) => {
				// Guard: wrong round.
				if self.current_round != Some(c.round) {
					return;
				}
				// Guard: wrong payload size.
				if c.data.len() != self.message_size {
					return;
				}
				// Guard: non-participant.
				if !self.participants.contains(&c.peer) {
					return;
				}
				// Guard: duplicate contribution.
				if self.contributed.contains(&c.peer) {
					return;
				}

				// XOR into accumulator.
				for (acc, byte) in self.xor_acc.iter_mut().zip(&c.data) {
					*acc ^= byte;
				}
				self.contributed.insert(c.peer);

				// Round complete when all participants contributed.
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
