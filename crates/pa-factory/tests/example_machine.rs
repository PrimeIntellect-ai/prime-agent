//! The bundled example machine, end to end: load, compile, plan, and bind
//! the typed output of the first state and the asset into the second.

use std::collections::BTreeMap;
use std::path::PathBuf;

use pa_factory::run::{plan_payloads, Bind, Payload, Settle, SourceView};
use pa_factory::{compile, load_machine_dir, AssetCache};
use serde_json::{json, Map, Value};

fn example_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/machines/outline-draft")
}

#[test]
fn the_example_machine_binds_the_typed_output_and_the_asset() {
    let dir = example_dir();
    let machine = load_machine_dir(&dir).unwrap();
    let mut params = Map::new();
    params.insert("topic".to_string(), json!("tide pools"));
    let spec = compile(&machine, &params).unwrap();
    assert_eq!(
        spec["states"][1]["inputs"],
        json!([
            {"name": "outline", "type": "json", "from": "plan.outline"},
            {"name": "style", "type": "text", "from": "assets/style.md"},
        ])
    );

    let mut assets = AssetCache::new(&dir);
    let mut plans = plan_payloads(&spec, &assets).unwrap();
    let draft = plans.remove("draft").unwrap();
    let outline = json!({"title": "Tide pools", "sections": ["Zones", "Life", "Care"]});
    let Value::Object(outputs) = json!({"outline": outline}) else {
        unreachable!("json! gives an object")
    };
    let settles = [Settle::Done {
        outputs,
        output_errors: BTreeMap::new(),
    }];
    let bound = draft.bind(
        |state| SourceView {
            settles: if state == "plan" { &settles } else { &[] },
            live: false,
        },
        &mut assets,
    );
    let style = std::fs::read_to_string(dir.join("assets/style.md")).unwrap();
    let Value::Object(fields) = json!({"outline": outline, "style": style}) else {
        unreachable!("json! gives an object")
    };
    assert_eq!(bound, Bind::Ready(Payload { fields, fan: None }));
}
