use {
	crate::{
		dcnet::ClientInput,
		utils::{discover_all, timeout_s},
	},
	futures::{SinkExt, StreamExt},
	mosaik::*,
};

/// Verify that a stream with an `accept_if` tag predicate only
/// allows attested consumers to subscribe.
#[tokio::test]
async fn attested_stream_filtering() -> anyhow::Result<()> {
	let network_id = NetworkId::random();
	let measurement: Tag = "dcnet-tee-measurement-v1".into();

	let n0 = Network::new(network_id).await?;
	let n1 = Network::new(network_id).await?;
	let n2 = Network::new(network_id).await?;

	// n1 has the correct TEE measurement tag.
	n1.discovery().add_tags(measurement);
	// n2 does NOT have the tag.

	discover_all([&n0, &n1, &n2]).await?;

	// Producer only accepts consumers with the measurement tag.
	let expected_tag = measurement;
	let mut producer = n0
		.streams()
		.producer::<ClientInput>()
		.with_stream_id("dcnet-attested-input")
		.accept_if(move |peer| peer.tags().contains(&expected_tag))
		.build()?;

	// n1 (attested) should be able to subscribe.
	let mut consumer_ok = n1
		.streams()
		.consumer::<ClientInput>()
		.with_stream_id("dcnet-attested-input")
		.build();

	// n2 (not attested) also tries to subscribe.
	let _consumer_bad = n2
		.streams()
		.consumer::<ClientInput>()
		.with_stream_id("dcnet-attested-input")
		.build();

	// Wait for at least 1 subscription (n1).
	timeout_s(5, producer.when().subscribed()).await?;

	// Send a message.
	let msg = ClientInput {
		round: 1,
		data: vec![42u8; 32],
	};
	producer.send(msg.clone()).await?;

	// n1 should receive it.
	let received = timeout_s(3, consumer_ok.next()).await?.unwrap();
	assert_eq!(received.round, 1);
	assert_eq!(received.data, vec![42u8; 32]);

	Ok(())
}
