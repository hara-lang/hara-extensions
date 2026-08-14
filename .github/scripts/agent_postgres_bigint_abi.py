from pathlib import Path

cargo = Path("hara-runtime/modules/std-db-postgres/Cargo.toml")
cargo_text = cargo.read_text()
old_rev = 'rev = "defad8f3324b7277562603027447ef465eadb568"'
new_rev = 'rev = "7eb824eccc7b8cafce5fb8fcb23842bd405e2bdd"'
if cargo_text.count(old_rev) != 1:
    raise SystemExit(f"expected one hara-abi revision, found {cargo_text.count(old_rev)}")
cargo.write_text(cargo_text.replace(old_rev, new_rev))

source = Path("hara-runtime/modules/std-db-postgres/src/lib.rs")
text = source.read_text()
old_arm = '''        Value::Decimal(value) | Value::String(value) | Value::Keyword(value) => {
            value.clone().into()
        }
'''
new_arm = '''        Value::BigInteger(value)
        | Value::Decimal(value)
        | Value::String(value)
        | Value::Keyword(value) => value.clone().into(),
'''
if text.count(old_arm) != 1:
    raise SystemExit(f"expected one exact-text JSON arm, found {text.count(old_arm)}")
text = text.replace(old_arm, new_arm)

test_anchor = '''    #[test]
    fn array_text_preserves_dimensions_and_rejects_ragged_values() {
'''
test = r'''    #[test]
    fn json_conversion_preserves_exact_numeric_text() {
        let integer = "922337203685477580812345678901234567890";
        assert_eq!(
            abi_json(&Value::BigInteger(integer.into())).unwrap(),
            serde_json::Value::String(integer.into())
        );

        let decimal = "0.123456789012345678901234567890";
        assert_eq!(
            abi_json(&Value::Decimal(decimal.into())).unwrap(),
            serde_json::Value::String(decimal.into())
        );
    }

'''
if text.count(test_anchor) != 1:
    raise SystemExit(f"expected one test anchor, found {text.count(test_anchor)}")
source.write_text(text.replace(test_anchor, test + test_anchor))
