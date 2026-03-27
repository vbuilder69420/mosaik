//! DC-net mixing demo on Mosaik.
//!
//! Demonstrates:
//! - Self-organizing mixing clusters via Raft groups
//! - Round-based XOR mixing as a replicated state machine
//! - Simulated TEE attestation gating via discovery tags
//! - An aggregator node that pre-XORs client inputs
//!
//! Topology:
//!   Client ──stream──▶ Aggregator ──group──▶ Mixer0
//!                                             Mixer1
//!                                             Mixer2

#![allow(clippy::too_many_lines)]

pub mod machine;
pub mod pad;
pub mod types;

use {
	futures::{SinkExt, StreamExt},
	machine::{DcNetCommand, DcNetMixer, DcNetQuery, DcNetQueryResult},
	mosaik::*,
	pad::compute_contribution,
	std::collections::BTreeSet,
	types::{ClientInput, Contribution, MESSAGE_SIZE},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	tracing_subscriber::fmt()
		.with_env_filter(
			tracing_subscriber::EnvFilter::try_from_default_env()
				.unwrap_or_else(|_| "info,mosaik=debug".parse().unwrap()),
		)
		.init();

	let network_id = NetworkId::random();
	let group_key = GroupKey::random();
	let measurement: Tag = "dcnet-tee-measurement-v1".into();

	println!("=== DC-Net Mixing Demo on Mosaik ===\n");

	// ── Spin up mixing cluster (3 mixers + 1 aggregator) ────

	let mixer0 = Network::new(network_id).await?;
	let mixer1 = Network::new(network_id).await?;
	let mixer2 = Network::new(network_id).await?;
	let aggregator = Network::new(network_id).await?;

	// All mixing nodes advertise TEE attestation tag.
	for net in [&mixer0, &mixer1, &mixer2, &aggregator] {
		net.discovery().add_tags(measurement);
	}

	discover_all([&mixer0, &mixer1, &mixer2, &aggregator]).await?;

	let g0 = mixer0
		.groups()
		.with_key(group_key)
		.with_state_machine(DcNetMixer::default())
		.join();
	let g1 = mixer1
		.groups()
		.with_key(group_key)
		.with_state_machine(DcNetMixer::default())
		.join();
	let g2 = mixer2
		.groups()
		.with_key(group_key)
		.with_state_machine(DcNetMixer::default())
		.join();
	let g_agg = aggregator
		.groups()
		.with_key(group_key)
		.with_state_machine(DcNetMixer::default())
		.join();

	tracing::info!("waiting for mixing group to come online...");
	g0.when().online().await;
	g1.when().online().await;
	g2.when().online().await;
	g_agg.when().online().await;

	let leader = g0.leader().expect("leader elected");
	println!(
		"Mixing cluster online: 4 nodes, leader {}\n",
		&format!("{leader}")[..10],
	);

	// Register all participants.
	let peers: BTreeSet<PeerId> = [
		mixer0.local().id(),
		mixer1.local().id(),
		mixer2.local().id(),
		aggregator.local().id(),
	]
	.into_iter()
	.collect();

	g0.execute(DcNetCommand::SetParticipants(peers.clone()))
		.await?;

	// ── Spin up client with TEE attestation ─────────────────

	let client = Network::new(network_id).await?;
	client.discovery().add_tags(measurement);
	discover_all([&client, &mixer0, &mixer1, &mixer2, &aggregator]).await?;

	// Client produces ClientInput via a stream.
	let mut client_producer = client
		.streams()
		.producer::<ClientInput>()
		.with_stream_id("dcnet-client-input")
		.build()?;

	// Aggregator consumes ClientInput — only from attested
	// peers.
	let expected_tag = measurement;
	let mut agg_consumer = aggregator
		.streams()
		.consumer::<ClientInput>()
		.with_stream_id("dcnet-client-input")
		.subscribe_if(move |peer| peer.tags().contains(&expected_tag))
		.build();

	agg_consumer.when().subscribed().await;
	println!("Client connected to aggregator (TEE-attested)\n");

	// ── Precompute ID byte vectors ──────────────────────────

	let secret = group_key.secret().as_bytes();
	let all_ids: Vec<PeerId> = peers.iter().copied().collect();
	let all_id_bytes: Vec<Vec<u8>> =
		all_ids.iter().map(|p| p.as_bytes().to_vec()).collect();
	let all_refs: Vec<&[u8]> =
		all_id_bytes.iter().map(|b| b.as_slice()).collect();

	// ── Round loop ──────────────────────────────────────────

	let messages = [
		"Hello from an anonymous sender!",
		"Privacy is a human right.",
		"You can't tell who sent this.",
	];

	for (round_num, msg_text) in
		messages.iter().enumerate().map(|(i, m)| (i as u64 + 1, m))
	{
		println!("--- Round {round_num} ---");

		g0.execute(DcNetCommand::StartRound(round_num)).await?;

		// Client sends message via stream to aggregator.
		let mut padded = vec![0u8; MESSAGE_SIZE];
		padded[..msg_text.len()].copy_from_slice(msg_text.as_bytes());

		client_producer
			.send(ClientInput {
				round: round_num,
				data: padded.clone(),
			})
			.await?;

		// Aggregator receives and folds into its contribution.
		let client_msg = agg_consumer.next().await.expect("expected client input");

		let agg_id = aggregator.local().id();
		let agg_contrib = compute_contribution(
			secret,
			agg_id.as_bytes(),
			&all_refs,
			round_num,
			&client_msg.data,
			MESSAGE_SIZE,
		);

		// Mixers contribute cover traffic.
		let mixer_nodes = [(&mixer0, &g0), (&mixer1, &g1), (&mixer2, &g2)];
		for (net, group) in &mixer_nodes {
			let my_id = net.local().id();
			let contrib = compute_contribution(
				secret,
				my_id.as_bytes(),
				&all_refs,
				round_num,
				&vec![0u8; MESSAGE_SIZE],
				MESSAGE_SIZE,
			);
			group
				.execute(DcNetCommand::Contribute(Contribution {
					round: round_num,
					peer: my_id,
					data: contrib,
				}))
				.await?;
		}

		// Aggregator submits its contribution.
		g_agg
			.execute(DcNetCommand::Contribute(Contribution {
				round: round_num,
				peer: agg_id,
				data: agg_contrib.clone(),
			}))
			.await?;

		// Query the round output.
		let result = g0
			.query(DcNetQuery::RoundOutput(round_num), Consistency::Strong)
			.await?;

		if let DcNetQueryResult::RoundOutput(Some(output)) = result.result() {
			// Find the printable prefix.
			let end = output.iter().position(|&b| b == 0).unwrap_or(output.len());
			let recovered = String::from_utf8_lossy(&output[..end]);
			println!("  Output: \"{recovered}\"");

			// Show that individual contributions look random.
			for (i, (net, _)) in mixer_nodes.iter().enumerate() {
				let id = net.local().id();
				let short = format!(
					"{:02x}{:02x}{:02x}{:02x}",
					id.as_bytes()[0],
					id.as_bytes()[1],
					id.as_bytes()[2],
					id.as_bytes()[3]
				);
				println!("    Mixer{i}  ({short}…): contribution is random bytes");
			}
			let ab = agg_id.as_bytes();
			let agg_short =
				format!("{:02x}{:02x}{:02x}{:02x}", ab[0], ab[1], ab[2], ab[3]);
			println!("    Aggregator ({agg_short}…): contribution is random bytes");
			println!("  All contributions indistinguishable from random.\n");
		}
	}

	// ── Verify follower replication ─────────────────────────

	g1.when().committed().reaches(g0.committed()).await;
	let follower = g1
		.query(DcNetQuery::RoundOutput(1), Consistency::Weak)
		.await?;
	if let DcNetQueryResult::RoundOutput(Some(_)) = follower.result() {
		println!("Follower g1 has replicated all rounds (consistent)");
	}

	println!("\n=== Demo complete ===");
	println!("  3 rounds executed across 4 mixing nodes");
	println!("  Client message delivered anonymously via aggregator");
	println!("  Non-attested nodes rejected from input stream");

	Ok(())
}

/// Cross-discover all networks with each other.
async fn discover_all(
	networks: impl IntoIterator<Item = &Network>,
) -> anyhow::Result<()> {
	let networks = networks.into_iter().collect::<Vec<_>>();
	for (i, net_i) in networks.iter().enumerate() {
		for (j, net_j) in networks.iter().enumerate() {
			if i != j {
				net_i.discovery().sync_with(net_j.local().addr()).await?;
			}
		}
	}
	Ok(())
}
