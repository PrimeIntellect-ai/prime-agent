//! The output contract a state's values are checked against.
//!
//! The compiler writes one contract per state into the canonical spec
//! (`"emit"`). An agent state's child receives it at spawn, and its
//! `factory.emit` host request checks every value before accepting it, so
//! a wrong value fails inside the child that produced it. A python state's
//! returned dict goes through the same check; it has no emit, so a `file`
//! output is refused. The JSON form keeps types in the machine.toml grammar,
//! so one parser reads both.

use serde_json::{json, Map, Value};

use crate::load::is_identifier;
use crate::machine::{Machine, Output};
use crate::types::{check_value, parse_slot, record_names, Records, Slot};

/// The ports a state owes and the records their types use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contract {
    pub outputs: Vec<(String, Slot)>,
    pub records: Records,
}

impl Contract {
    /// The contract for one state's declared outputs.
    #[must_use]
    pub fn for_outputs(machine: &Machine, outputs: &[Output]) -> Self {
        let mut records = Records::default();
        let mut pending: Vec<&str> = outputs
            .iter()
            .flat_map(|output| record_names(&output.slot.ty))
            .collect();
        while let Some(name) = pending.pop() {
            if records.0.contains_key(name) {
                continue;
            }
            if let Some(fields) = machine.records.fields(name) {
                pending.extend(fields.iter().flat_map(|(_, slot)| record_names(&slot.ty)));
                records.0.insert(name.to_string(), fields.to_vec());
            }
        }
        Self {
            outputs: outputs
                .iter()
                .map(|output| (output.name.clone(), output.slot.clone()))
                .collect(),
            records,
        }
    }

    /// `{"outputs": [{"name", "type"}], "records": {name: [[field, type]]}}`
    /// with types written in the machine.toml grammar (`text?` when optional).
    #[must_use]
    pub fn to_json(&self) -> Value {
        let outputs: Vec<Value> = self
            .outputs
            .iter()
            .map(|(name, slot)| json!({"name": name, "type": slot.to_string()}))
            .collect();
        let records: Map<String, Value> = self
            .records
            .0
            .iter()
            .map(|(name, fields)| {
                let fields: Vec<Value> = fields
                    .iter()
                    .map(|(field, slot)| json!([field, slot.to_string()]))
                    .collect();
                (name.clone(), Value::Array(fields))
            })
            .collect();
        json!({"outputs": outputs, "records": records})
    }

    /// Read a contract back from [`Contract::to_json`]'s form.
    ///
    /// # Errors
    /// Returns the first malformed part.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let malformed = |what: &str| format!("malformed factory contract: {what}");
        let mut outputs = Vec::new();
        for output in value
            .get("outputs")
            .and_then(Value::as_array)
            .ok_or_else(|| malformed("outputs is not a list"))?
        {
            let name = output
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("an output has no name"))?;
            // A file port's name becomes a directory under the session.
            if !is_identifier(name) {
                return Err(malformed(&format!("output name {name:?} is not an identifier")));
            }
            let ty = output
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("an output has no type"))?;
            outputs.push((
                name.to_string(),
                parse_slot(ty).map_err(|error| malformed(&error))?,
            ));
        }
        let mut records = Records::default();
        if let Some(table) = value.get("records").and_then(Value::as_object) {
            for (name, fields) in table {
                let mut parsed = Vec::new();
                for field in fields
                    .as_array()
                    .ok_or_else(|| malformed("a record is not a list"))?
                {
                    let (Some(field), Some(ty)) = (
                        field.get(0).and_then(Value::as_str),
                        field.get(1).and_then(Value::as_str),
                    ) else {
                        return Err(malformed("a record field is not [name, type]"));
                    };
                    parsed.push((
                        field.to_string(),
                        parse_slot(ty).map_err(|error| malformed(&error))?,
                    ));
                }
                records.0.insert(name.clone(), parsed);
            }
        }
        Ok(Self { outputs, records })
    }

    #[must_use]
    pub fn slot(&self, port: &str) -> Option<&Slot> {
        self.outputs
            .iter()
            .find(|(name, _)| name == port)
            .map(|(_, slot)| slot)
    }

    /// Check each named value against its port. Unknown ports and wrong
    /// values are all reported; nothing is partial.
    ///
    /// # Errors
    /// Returns one `<port path>: <reason>` line per problem.
    pub fn check(&self, values: &Map<String, Value>) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        for (port, value) in values {
            match self.slot(port) {
                None => {
                    let known: Vec<&str> =
                        self.outputs.iter().map(|(name, _)| name.as_str()).collect();
                    problems.push(format!(
                        "{port}: not an output of this state (it has: {})",
                        if known.is_empty() {
                            "none".to_string()
                        } else {
                            known.join(", ")
                        }
                    ));
                }
                Some(_) if value.is_null() => {
                    problems.push(format!(
                        "{port}: null is not a value; leave an optional output out"
                    ));
                }
                Some(slot) => {
                    if let Err(error) = check_value(&slot.ty, value, &self.records, port) {
                        problems.push(error);
                    }
                }
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    /// The required ports `emitted` does not carry yet.
    #[must_use]
    pub fn missing(&self, emitted: &Map<String, Value>) -> Vec<&str> {
        self.outputs
            .iter()
            .filter(|(name, slot)| !slot.optional && !emitted.contains_key(name))
            .map(|(name, _)| name.as_str())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Type;
    use std::collections::BTreeMap;

    fn contract() -> Contract {
        Contract {
            outputs: vec![
                ("verdict".to_string(), parse_slot("verdict").unwrap()),
                ("note".to_string(), parse_slot("text?").unwrap()),
            ],
            records: Records(BTreeMap::from([(
                "verdict".to_string(),
                vec![(
                    "decision".to_string(),
                    parse_slot("enum(approve, rework)").unwrap(),
                )],
            )])),
        }
    }

    #[test]
    fn a_contract_refuses_an_output_name_that_is_not_an_identifier() {
        let contract = json!({"outputs": [{"name": "../../x", "type": "file"}], "records": {}});
        assert_eq!(
            Contract::from_json(&contract).unwrap_err(),
            "malformed factory contract: output name \"../../x\" is not an identifier"
        );
    }

    #[test]
    fn round_trips_through_json() {
        let contract = contract();
        assert_eq!(
            contract.to_json(),
            json!({"outputs": [{"name": "verdict", "type": "verdict"}, {"name": "note", "type": "text?"}],
                   "records": {"verdict": [["decision", "enum(approve, rework)"]]}})
        );
        assert_eq!(Contract::from_json(&contract.to_json()), Ok(contract));
        assert_eq!(
            Slot {
                ty: Type::List(Box::new(Type::Int)),
                optional: true
            }
            .to_string(),
            "list[int]?"
        );
    }

    #[test]
    fn checks_every_port_and_names_the_missing_ones() {
        let contract = contract();
        let values = |value: Value| value.as_object().cloned().unwrap();
        assert_eq!(
            contract.check(&values(json!({"verdict": {"decision": "approve"}}))),
            Ok(())
        );
        assert_eq!(
            contract.check(&values(
                json!({"verdict": {"decision": "ship"}, "notes": "x", "note": null})
            )),
            Err(vec![
                "verdict.decision: \"ship\" is not one of approve, rework".to_string(),
                "notes: not an output of this state (it has: verdict, note)".to_string(),
                "note: null is not a value; leave an optional output out".to_string(),
            ])
        );
        assert_eq!(contract.missing(&values(json!({"note": "n"}))), ["verdict"]);
        assert!(contract.missing(&values(json!({"verdict": {}}))).is_empty());
    }
}
