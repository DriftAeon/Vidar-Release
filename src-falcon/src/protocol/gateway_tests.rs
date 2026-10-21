use super::*;

#[test]
fn gateway_round_trip_and_absence_preserve_plain_spawn_wire() {
    let plain = r#"{"cwd":"work","permission_mode":"default"}"#;
    let params: SpawnParams = serde_json::from_str(plain).unwrap();
    assert_eq!(params.gateway, None);
    assert_eq!(serde_json::to_string(&params).unwrap(), plain);
    let edge = "a".repeat(Gateway::MAX);
    for id in ["acme", "acme-2", edge.as_str()] {
        let mut params = params.clone();
        params.gateway = Some(Gateway::new(id).unwrap());
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains(&format!(r#""gateway":"{id}""#)));
        let back: SpawnParams = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.gateway.unwrap().as_str(), id);
    }
}

#[test]
fn gateway_refuses_ids_outside_the_contract_pattern() {
    let long = "a".repeat(Gateway::MAX + 1);
    for bad in ["", "Acme", "1acme", "-acme", "ac_me", "ac me", "acme/..", "ácme", long.as_str()] {
        assert!(Gateway::new(bad).is_none(), "{bad:?}");
        let wire = serde_json::json!({"cwd":"work","permission_mode":"default","gateway":bad});
        assert!(serde_json::from_value::<SpawnParams>(wire).is_err(), "{bad:?}");
    }
    assert!(serde_json::from_str::<SpawnParams>(
        r#"{"cwd":"work","permission_mode":"default","gateway":7}"#
    ).is_err());
}

#[test]
fn gateway_summary_round_trip_retains_identity_for_adoption() {
    let plain = r#"{"session":"s1","generation":1,"agent":"claude","cwd":"work","conversation":null,"pid":1,"model":null,"permission_mode":"default","attached":0,"exited":null}"#;
    let mut summary: SessionSummary = serde_json::from_str(plain).unwrap();
    assert_eq!(summary.gateway, None);
    assert!(!serde_json::to_string(&summary).unwrap().contains("gateway"));
    summary.gateway = Gateway::new("acme");
    let back: SessionSummary = serde_json::from_str(&serde_json::to_string(&summary).unwrap()).unwrap();
    assert_eq!(back.gateway, summary.gateway);
}
