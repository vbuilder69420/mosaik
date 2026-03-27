use {
	crate::{
		dcnet::{
			Contribution,
			DcNetCommand,
			DcNetMixer,
			DcNetQuery,
			DcNetQueryResult,
			MESSAGE_SIZE,
			compute_contribution,
			xor_into,
		},
		utils::{discover_all, timeout_after, timeout_s},
	},
	mosaik::{groups::Consistency, *},
	std::collections::BTreeSet,
};

// ─── Unit tests (no network) ────────────────────────────────

/// Verify that pairwise pads cancel perfectly when all
/// participants contribute cover traffic (all zeros).
#[test]
fn pad_cancellation() {
	let secret = [7u8; 32];
	let peers: Vec<[u8; 32]> = (0..5u8)
		.map(|i| {
			let mut id = [0u8; 32];
			id[0] = i;
			id
		})
		.collect();

	let peer_refs: Vec<&[u8]> = peers.iter().map(|p| p.as_slice()).collect();

	let mut xor_all = vec![0u8; MESSAGE_SIZE];
	for peer in &peers {
		let zeros = vec![0u8; MESSAGE_SIZE];
		let contrib = compute_contribution(
			&secret,
			peer.as_slice(),
			&peer_refs,
			1,
			&zeros,
			MESSAGE_SIZE,
		);
		xor_into(&mut xor_all, &contrib);
	}

	// All pads should cancel → result is all zeros.
	assert_eq!(xor_all, vec![0u8; MESSAGE_SIZE]);
}

/// Verify that a single sender's message survives the XOR.
#[test]
fn pad_cancellation_single_sender() {
	let secret = [42u8; 32];
	let peers: Vec<[u8; 32]> = (0..3u8)
		.map(|i| {
			let mut id = [0u8; 32];
			id[0] = i + 10;
			id
		})
		.collect();

	let peer_refs: Vec<&[u8]> = peers.iter().map(|p| p.as_slice()).collect();

	let mut message = vec![0u8; MESSAGE_SIZE];
	message[..13].copy_from_slice(b"hello dc-net!");

	let mut xor_all = vec![0u8; MESSAGE_SIZE];
	for (i, peer) in peers.iter().enumerate() {
		let msg = if i == 0 {
			message.clone()
		} else {
			vec![0u8; MESSAGE_SIZE]
		};
		let contrib = compute_contribution(
			&secret,
			peer.as_slice(),
			&peer_refs,
			1,
			&msg,
			MESSAGE_SIZE,
		);
		xor_into(&mut xor_all, &contrib);
	}

	assert_eq!(xor_all, message);
}

// ─── Helpers ────────────────────────────────────────────────

fn pad_message(s: &str) -> Vec<u8> {
	let mut buf = vec![0u8; MESSAGE_SIZE];
	let bytes = s.as_bytes();
	buf[..bytes.len()].copy_from_slice(bytes);
	buf
}

async fn query_round_output(
	group: &mosaik::Group<DcNetMixer>,
	round: u64,
) -> anyhow::Result<Option<Vec<u8>>> {
	let committed = timeout_s(
		3,
		group.query(DcNetQuery::RoundOutput(round), Consistency::Strong),
	)
	.await??;
	match committed.result() {
		DcNetQueryResult::RoundOutput(v) => Ok(v.clone()),
		other => panic!("expected RoundOutput, got {other:?}"),
	}
}

/// Shared setup: create N nodes, discover, join group, online.
struct MixingCluster {
	networks: Vec<Network>,
	groups: Vec<Group<DcNetMixer>>,
	group_key: GroupKey,
}

impl MixingCluster {
	async fn new(n: usize) -> anyhow::Result<Self> {
		let network_id = NetworkId::random();
		let group_key = GroupKey::random();

		let mut networks = Vec::with_capacity(n);
		for _ in 0..n {
			networks.push(Network::new(network_id).await?);
		}
		discover_all(&networks).await?;

		let mut groups = Vec::with_capacity(n);
		for net in &networks {
			groups.push(
				net
					.groups()
					.with_key(group_key)
					.with_state_machine(DcNetMixer::default())
					.join(),
			);
		}

		let timeout = 2
			* (groups[0].config().consensus().bootstrap_delay
				+ groups[0].config().consensus().election_timeout
				+ groups[0].config().consensus().election_timeout_jitter);

		for g in &groups {
			timeout_after(timeout, g.when().online()).await?;
		}

		// Set participants.
		let peers: BTreeSet<PeerId> =
			networks.iter().map(|n| n.local().id()).collect();
		timeout_s(3, groups[0].execute(DcNetCommand::SetParticipants(peers)))
			.await??;

		Ok(Self {
			networks,
			groups,
			group_key,
		})
	}

	const fn secret(&self) -> &[u8; 32] {
		self.group_key.secret().as_bytes()
	}

	fn peer_id_bytes(&self) -> Vec<Vec<u8>> {
		self
			.networks
			.iter()
			.map(|n| n.local().id().as_bytes().to_vec())
			.collect()
	}

	/// Run a round where `sender_idx` sends `message` and
	/// everyone else sends cover traffic.
	async fn run_round(
		&self,
		round: u64,
		sender_idx: Option<usize>,
		message: &[u8],
	) -> anyhow::Result<()> {
		timeout_s(3, self.groups[0].execute(DcNetCommand::StartRound(round)))
			.await??;

		let id_bytes = self.peer_id_bytes();
		let all_refs: Vec<&[u8]> = id_bytes.iter().map(|b| b.as_slice()).collect();

		for (i, (net, group)) in self.networks.iter().zip(&self.groups).enumerate()
		{
			let msg = if sender_idx == Some(i) {
				message.to_vec()
			} else {
				vec![0u8; MESSAGE_SIZE]
			};
			let my_id = net.local().id();
			let contrib = compute_contribution(
				self.secret(),
				my_id.as_bytes(),
				&all_refs,
				round,
				&msg,
				MESSAGE_SIZE,
			);
			timeout_s(
				3,
				group.execute(DcNetCommand::Contribute(Contribution {
					round,
					peer: my_id,
					data: contrib,
				})),
			)
			.await??;
		}
		Ok(())
	}
}

// ─── E2E integration tests ─────────────────────────────────

/// Full E2E: 3 nodes, one sender, verify anonymous recovery.
#[tokio::test]
async fn single_sender() -> anyhow::Result<()> {
	let cluster = MixingCluster::new(3).await?;
	let message = pad_message("hello dc-net!");

	cluster.run_round(1, Some(0), &message).await?;

	for group in &cluster.groups {
		let output = query_round_output(group, 1)
			.await?
			.expect("round should complete");
		assert_eq!(output, message);
	}
	Ok(())
}

/// All cover traffic → output is all zeros.
#[tokio::test]
async fn cover_traffic_only() -> anyhow::Result<()> {
	let cluster = MixingCluster::new(3).await?;
	let zeros = vec![0u8; MESSAGE_SIZE];

	cluster.run_round(1, None, &zeros).await?;

	let output = query_round_output(&cluster.groups[0], 1)
		.await?
		.expect("round should complete");
	assert_eq!(output, zeros);
	Ok(())
}

/// Two senders → output is XOR of both messages.
#[tokio::test]
async fn two_senders_xor() -> anyhow::Result<()> {
	let cluster = MixingCluster::new(3).await?;

	let msg_a = pad_message("message from node 0");
	let msg_b = pad_message("message from node 1");

	// Custom round: nodes 0 and 1 send, node 2 is cover.
	timeout_s(3, cluster.groups[0].execute(DcNetCommand::StartRound(1)))
		.await??;

	let id_bytes = cluster.peer_id_bytes();
	let all_refs: Vec<&[u8]> = id_bytes.iter().map(|b| b.as_slice()).collect();
	let messages = [msg_a.clone(), msg_b.clone(), vec![0u8; MESSAGE_SIZE]];

	for (i, (net, group)) in
		cluster.networks.iter().zip(&cluster.groups).enumerate()
	{
		let my_id = net.local().id();
		let contrib = compute_contribution(
			cluster.secret(),
			my_id.as_bytes(),
			&all_refs,
			1,
			&messages[i],
			MESSAGE_SIZE,
		);
		timeout_s(
			3,
			group.execute(DcNetCommand::Contribute(Contribution {
				round: 1,
				peer: my_id,
				data: contrib,
			})),
		)
		.await??;
	}

	let output = query_round_output(&cluster.groups[0], 1)
		.await?
		.expect("round should complete");

	let mut expected = msg_a;
	xor_into(&mut expected, &msg_b);
	assert_eq!(output, expected);
	Ok(())
}

/// Run 3 sequential rounds with different senders.
#[tokio::test]
async fn multiple_rounds() -> anyhow::Result<()> {
	let cluster = MixingCluster::new(3).await?;

	let round_messages = [
		pad_message("round 1 from node 0"),
		pad_message("round 2 from node 1"),
		pad_message("round 3 from node 2"),
	];

	for round in 1..=3u64 {
		let sender_idx = (round - 1) as usize;
		cluster
			.run_round(round, Some(sender_idx), &round_messages[sender_idx])
			.await?;

		let output = query_round_output(&cluster.groups[0], round)
			.await?
			.expect("round should complete");
		assert_eq!(output, round_messages[sender_idx]);
	}
	Ok(())
}

/// Verify that `AbortRound` clears a stuck round.
#[tokio::test]
async fn abort_round() -> anyhow::Result<()> {
	let cluster = MixingCluster::new(3).await?;

	// Start round 1 but only 2 of 3 contribute.
	timeout_s(3, cluster.groups[0].execute(DcNetCommand::StartRound(1)))
		.await??;

	let id_bytes = cluster.peer_id_bytes();
	let all_refs: Vec<&[u8]> = id_bytes.iter().map(|b| b.as_slice()).collect();

	for (net, group) in cluster.networks.iter().zip(&cluster.groups).take(2)
	// only first two contribute
	{
		let my_id = net.local().id();
		let contrib = compute_contribution(
			cluster.secret(),
			my_id.as_bytes(),
			&all_refs,
			1,
			&vec![0u8; MESSAGE_SIZE],
			MESSAGE_SIZE,
		);
		timeout_s(
			3,
			group.execute(DcNetCommand::Contribute(Contribution {
				round: 1,
				peer: my_id,
				data: contrib,
			})),
		)
		.await??;
	}

	// Round 1 should NOT be complete.
	assert_eq!(query_round_output(&cluster.groups[0], 1).await?, None);

	// Abort.
	timeout_s(3, cluster.groups[0].execute(DcNetCommand::AbortRound(1)))
		.await??;

	// Still no output for round 1.
	assert_eq!(query_round_output(&cluster.groups[0], 1).await?, None);

	// Round 2 works normally.
	let message = pad_message("recovered after abort");
	cluster.run_round(2, Some(0), &message).await?;

	let output = query_round_output(&cluster.groups[0], 2)
		.await?
		.expect("round 2 should complete");
	assert_eq!(output, message);
	Ok(())
}
