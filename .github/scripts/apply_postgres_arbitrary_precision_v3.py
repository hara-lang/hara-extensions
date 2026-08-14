from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_section(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start marker not found")
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise SystemExit(f"{label}: end marker not found")
    if text.find(start, start_index + len(start), end_index) >= 0:
        raise SystemExit(f"{label}: start marker is not unique in section")
    return text[:start_index] + replacement.rstrip() + "\n\n" + text[end_index:]


cargo_path = Path("hara-runtime/modules/std-db-postgres/Cargo.toml")
cargo = cargo_path.read_text(encoding="utf-8")
cargo = replace_once(
    cargo,
    'hara-abi = { git = "https://github.com/hara-lang/hara.git", rev = "defad8f3324b7277562603027447ef465eadb568", package = "hara-abi" }',
    'hara-abi = { git = "https://github.com/hara-lang/hara.git", rev = "af4e2856ae2580db9c1337044e6e1dc52bc8c30e", package = "hara-abi" }',
    "Hara ABI revision",
)
cargo = replace_once(
    cargo,
    'serde_json = "1"',
    'serde_json = { version = "1", features = ["arbitrary_precision"] }',
    "serde_json exact-number feature",
)
cargo_path.write_text(cargo, encoding="utf-8")

source_path = Path("hara-runtime/modules/std-db-postgres/src/lib.rs")
source = source_path.read_text(encoding="utf-8")

source = replace_section(
    source,
    "fn parameter_type(",
    "fn parameter(",
    r'''fn parameter_type(value: &Value, inferred: &Type) -> Result<Type, Error> {
    if matches!(*inferred, Type::JSON | Type::JSONB) {
        return Ok(inferred.clone());
    }
    if matches!(value, Value::BigInteger(_) | Value::Decimal(_))
        && matches!(*inferred, Type::TEXT | Type::UNKNOWN)
    {
        return Ok(Type::NUMERIC);
    }
    let Some((tag, fields)) = postgres_tag(value) else {
        return Ok(inferred.clone());
    };
    let explicit = match tag {
        "numeric" => Type::NUMERIC,
        "array" => array_type(
            fields
                .get("element")
                .and_then(string_value)
                .ok_or_else(|| {
                    Error::new("postgres/config-invalid", "array element is required")
                })?,
        )?,
        _ => unreachable!(),
    };
    if matches!(*inferred, Type::TEXT | Type::UNKNOWN) {
        Ok(explicit)
    } else {
        Ok(inferred.clone())
    }
}''',
    "parameter type inference",
)

source = replace_section(
    source,
    "fn parameter(",
    "fn result_value(",
    r'''fn parameter(value: &Value, ty: &Type) -> Result<Box<dyn ToSql + Sync>, Error> {
    if matches!(value, Value::Nil) {
        return Ok(Box::new(Null));
    }
    macro_rules! boxed {
        ($value:expr) => {
            Ok(Box::new($value))
        };
    }
    if matches!(*ty, Type::JSON | Type::JSONB) {
        return boxed!(abi_json(value)?);
    }
    if *ty == Type::NUMERIC {
        let numeric = match postgres_tag(value) {
            Some(("numeric", fields)) => fields.get("value").ok_or_else(|| {
                Error::new("postgres/config-invalid", "numeric value is required")
            })?,
            Some(_) => return Err(type_error(ty)),
            None => value,
        };
        return boxed!(TextParameter(numeric_parameter_text(numeric)?));
    }
    if let Kind::Array(member) = ty.kind() {
        let (array, dimensions) = match postgres_tag(value) {
            Some(("array", fields)) => {
                let declared = fields
                    .get("element")
                    .and_then(string_value)
                    .ok_or_else(|| {
                        Error::new("postgres/config-invalid", "array element is required")
                    })?;
                if array_type(declared)? != *ty {
                    return Err(Error::new(
                        "postgres/type-unsupported",
                        format!("array element {declared} does not match {}", member.name()),
                    ));
                }
                (
                    fields.get("value").ok_or_else(|| {
                        Error::new("postgres/config-invalid", "array value is required")
                    })?,
                    tagged_dimensions(fields.get("dimensions"))?,
                )
            }
            Some(_) => return Err(type_error(ty)),
            None => (value, None),
        };
        return boxed!(TextParameter(array_parameter_text(
            array,
            member,
            dimensions.as_deref(),
        )?));
    }
    match (value, ty) {
        (Value::Boolean(value), &Type::BOOL) => boxed!(*value),
        (Value::Integer(value), &Type::INT2) => {
            boxed!(i16::try_from(*value).map_err(|_| type_error(ty))?)
        }
        (Value::BigInteger(value), &Type::INT2) => {
            boxed!(value.parse::<i16>().map_err(|_| type_error(ty))?)
        }
        (Value::Integer(value), &Type::INT4) => {
            boxed!(i32::try_from(*value).map_err(|_| type_error(ty))?)
        }
        (Value::BigInteger(value), &Type::INT4) => {
            boxed!(value.parse::<i32>().map_err(|_| type_error(ty))?)
        }
        (Value::Integer(value), &Type::INT8) => boxed!(*value),
        (Value::BigInteger(value), &Type::INT8) => {
            boxed!(value.parse::<i64>().map_err(|_| type_error(ty))?)
        }
        (Value::Float(value), &Type::FLOAT4) => boxed!(*value as f32),
        (Value::Float(value), &Type::FLOAT8) => boxed!(*value),
        (Value::String(value), &Type::TEXT | &Type::VARCHAR | &Type::BPCHAR | &Type::NAME) => {
            boxed!(value.clone())
        }
        (Value::String(value), &Type::UUID) => {
            boxed!(value.parse::<Uuid>().map_err(|_| type_error(ty))?)
        }
        (Value::String(value), &Type::DATE) => {
            boxed!(value.parse::<NaiveDate>().map_err(|_| type_error(ty))?)
        }
        (Value::String(value), &Type::TIME) => {
            boxed!(value.parse::<NaiveTime>().map_err(|_| type_error(ty))?)
        }
        (Value::String(value), &Type::TIMESTAMP) => {
            boxed!(value.parse::<NaiveDateTime>().map_err(|_| type_error(ty))?)
        }
        (Value::String(value), &Type::TIMESTAMPTZ) => {
            boxed!(value.parse::<DateTime<Utc>>().map_err(|_| type_error(ty))?)
        }
        (Value::Bytes(value), &Type::BYTEA) => boxed!(value.clone()),
        _ => Err(type_error(ty)),
    }
}''',
    "scalar parameter conversion",
)

source = replace_section(
    source,
    "fn simple_numeric(",
    "fn decode_numeric(",
    r'''fn integer_text(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn simple_numeric(text: String) -> Value {
    if matches!(text.as_str(), "NaN" | "Infinity" | "-Infinity") {
        return numeric_tag(text);
    }
    let integral = text
        .split_once('.')
        .map(|(whole, fraction)| fraction.bytes().all(|byte| byte == b'0').then_some(whole))
        .unwrap_or(Some(text.as_str()));
    if let Some(value) = integral.filter(|value| integer_text(value)) {
        if let Ok(value) = value.parse::<i64>() {
            return Value::Integer(value);
        }
        return Value::BigInteger(value.into());
    }
    if text.contains('.') {
        Value::Decimal(text)
    } else {
        numeric_tag(text)
    }
}''',
    "exact NUMERIC decoding",
)

source = replace_section(
    source,
    "fn numeric_parameter_text(",
    "fn array_type(",
    r'''fn numeric_parameter_text(value: &Value) -> Result<String, Error> {
    match value {
        Value::Integer(value) => Ok(value.to_string()),
        Value::BigInteger(value) if integer_text(value) => Ok(value.clone()),
        Value::Float(value) if value.is_nan() => Ok("NaN".into()),
        Value::Float(value) if *value == f64::INFINITY => Ok("Infinity".into()),
        Value::Float(value) if *value == f64::NEG_INFINITY => Ok("-Infinity".into()),
        Value::Float(value) => Ok(value.to_string()),
        Value::Decimal(value) | Value::String(value) => Ok(value.clone()),
        _ => Err(Error::new(
            "postgres/type-unsupported",
            "NUMERIC requires a number or decimal string",
        )),
    }
}''',
    "exact NUMERIC parameters",
)

source = replace_section(
    source,
    "fn array_element_text(",
    "fn quote_array_text(",
    r'''fn array_element_text(value: &Value, ty: &Type) -> Result<String, Error> {
    if matches!(value, Value::Nil) {
        return Ok("NULL".into());
    }
    let text = match *ty {
        Type::BOOL => match value {
            Value::Boolean(value) => value.to_string(),
            _ => return Err(type_error(ty)),
        },
        Type::INT2 => match value {
            Value::Integer(value) => i16::try_from(*value)
                .map_err(|_| type_error(ty))?
                .to_string(),
            Value::BigInteger(value) => value
                .parse::<i16>()
                .map_err(|_| type_error(ty))?
                .to_string(),
            _ => return Err(type_error(ty)),
        },
        Type::INT4 => match value {
            Value::Integer(value) => i32::try_from(*value)
                .map_err(|_| type_error(ty))?
                .to_string(),
            Value::BigInteger(value) => value
                .parse::<i32>()
                .map_err(|_| type_error(ty))?
                .to_string(),
            _ => return Err(type_error(ty)),
        },
        Type::INT8 => match value {
            Value::Integer(value) => value.to_string(),
            Value::BigInteger(value) => value
                .parse::<i64>()
                .map_err(|_| type_error(ty))?
                .to_string(),
            _ => return Err(type_error(ty)),
        },
        Type::FLOAT4 | Type::FLOAT8 => match value {
            Value::Integer(value) => value.to_string(),
            Value::Float(value) => value.to_string(),
            _ => return Err(type_error(ty)),
        },
        Type::NUMERIC => {
            let value = match postgres_tag(value) {
                Some(("numeric", fields)) => fields.get("value").ok_or_else(|| {
                    Error::new("postgres/config-invalid", "numeric value is required")
                })?,
                Some(_) => return Err(type_error(ty)),
                None => value,
            };
            numeric_parameter_text(value)?
        }
        Type::TEXT
        | Type::VARCHAR
        | Type::BPCHAR
        | Type::NAME
        | Type::UUID
        | Type::DATE
        | Type::TIME
        | Type::TIMESTAMP
        | Type::TIMESTAMPTZ => quote_array_text(expect_string(Some(value), "array element")?),
        Type::JSON | Type::JSONB => quote_array_text(&abi_json(value)?.to_string()),
        Type::BYTEA => match value {
            Value::Bytes(bytes) => {
                let mut encoded = String::from("\\x");
                for byte in bytes {
                    encoded.push_str(&format!("{byte:02x}"));
                }
                quote_array_text(&encoded)
            }
            _ => return Err(type_error(ty)),
        },
        _ => return Err(type_error(ty)),
    };
    Ok(text)
}''',
    "array element conversion",
)

source = replace_section(
    source,
    "fn expect_i64(",
    "fn string_value(",
    r'''fn expect_i64(value: Option<&Value>, name: &str) -> Result<i64, Error> {
    match value {
        Some(Value::Integer(value)) => Ok(*value),
        Some(Value::BigInteger(value)) => value.parse::<i64>().map_err(|_| {
            Error::new(
                "postgres/config-invalid",
                format!("{name} must fit a signed 64-bit integer"),
            )
        }),
        _ => Err(Error::new(
            "postgres/config-invalid",
            format!("{name} must be an integer"),
        )),
    }
}''',
    "checked ABI integer boundary",
)

source = replace_section(
    source,
    "fn integer_option(",
    "fn identifier(",
    r'''fn integer_option(options: &BTreeMap<String, Value>, name: &str, fallback: i64) -> i64 {
    match options.get(name) {
        Some(Value::Integer(value)) => *value,
        Some(Value::BigInteger(value)) => value.parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}''',
    "representation-independent integer options",
)

source = replace_section(
    source,
    "fn abi_json(",
    "#[cfg(test)]",
    r'''fn exact_json_number(value: &str) -> Result<serde_json::Value, Error> {
    let value = serde_json::from_str::<serde_json::Value>(value).map_err(|_| {
        Error::new(
            "postgres/type-unsupported",
            "invalid exact JSON number",
        )
    })?;
    if value.is_number() {
        Ok(value)
    } else {
        Err(Error::new(
            "postgres/type-unsupported",
            "invalid exact JSON number",
        ))
    }
}

fn abi_json(value: &Value) -> Result<serde_json::Value, Error> {
    Ok(match value {
        Value::Nil => serde_json::Value::Null,
        Value::Boolean(value) => (*value).into(),
        Value::Integer(value) => (*value).into(),
        Value::BigInteger(value) | Value::Decimal(value) => exact_json_number(value)?,
        Value::Float(value) => serde_json::Number::from_f64(*value)
            .map(serde_json::Value::Number)
            .ok_or_else(|| {
                Error::new(
                    "postgres/type-unsupported",
                    "JSON does not support non-finite floating-point values",
                )
            })?,
        Value::String(value) | Value::Keyword(value) => value.clone().into(),
        Value::Vector(values) => {
            serde_json::Value::Array(values.iter().map(abi_json).collect::<Result<Vec<_>, _>>()?)
        }
        Value::Record(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), abi_json(value)?)))
                .collect::<Result<_, Error>>()?,
        ),
        Value::Bytes(_) => {
            return Err(Error::new(
                "postgres/type-unsupported",
                "bytes cannot be JSON",
            ))
        }
    })
}

fn json_abi(value: serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Nil,
        serde_json::Value::Bool(value) => Value::Boolean(value),
        serde_json::Value::Number(value) => {
            let text = value.to_string();
            if integer_text(&text) {
                text.parse::<i64>()
                    .map(Value::Integer)
                    .unwrap_or_else(|_| Value::BigInteger(text))
            } else {
                Value::Decimal(text)
            }
        }
        serde_json::Value::String(value) => Value::String(value),
        serde_json::Value::Array(values) => {
            Value::Vector(values.into_iter().map(json_abi).collect())
        }
        serde_json::Value::Object(values) => Value::Record(
            values
                .into_iter()
                .map(|(key, value)| (key, json_abi(value)))
                .collect(),
        ),
    }
}''',
    "exact ABI JSON conversion",
)

source = replace_section(
    source,
    "#[cfg(test)]",
    "",
    r'''#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_and_capabilities_are_stable() {
        let module = PostgresModule::new().unwrap();
        assert_eq!(module.identity().export, "std.db.postgres");
        assert_eq!(module.identity().abi, "hara.db-provider/1");
        assert!(module.capabilities().contains(&"notifications"));
    }

    #[test]
    fn config_rejects_ambiguous_tls_without_leaking_passwords() {
        let options = BTreeMap::from([
            ("user".into(), Value::String("postgres".into())),
            ("password".into(), Value::String("secret".into())),
            ("tls".into(), Value::String("maybe".into())),
        ]);
        let error = connection_config(&options).unwrap_err();
        assert_eq!(error.code, "postgres/config-invalid");
        assert!(!error.detail.contains("secret"));
    }

    #[test]
    fn identifiers_quote_postgres_names_instead_of_restricting_them() {
        assert_eq!(identifier("gw-ledger-test").unwrap(), "\"gw-ledger-test\"");
        assert_eq!(identifier("quoted\"name").unwrap(), "\"quoted\"\"name\"");
        assert!(identifier("").is_err());
        assert!(identifier("bad\0name").is_err());
    }

    #[test]
    fn numeric_binary_decoding_and_simple_conversion_are_exact() {
        let raw = [
            0, 2, // ndigits
            0, 0, // weight
            0, 0, // positive
            0, 4, // scale
            0, 12, 13, 72, // 12, 3400
        ];
        assert_eq!(decode_numeric(&raw).unwrap(), "12.3400");
        assert_eq!(simple_numeric("12.000".into()), Value::Integer(12));
        assert_eq!(
            simple_numeric("12.3400".into()),
            Value::Decimal("12.3400".into())
        );
        assert_eq!(
            simple_numeric("9223372036854775808".into()),
            Value::BigInteger("9223372036854775808".into())
        );
        assert_eq!(simple_numeric("1e10000".into()), numeric_tag("1e10000"));
    }

    #[test]
    fn arbitrary_precision_values_cross_postgres_boundaries_exactly() {
        let big = "92233720368547758081234567890";
        let decimal = "1234567890.12345678901234567890";

        assert_eq!(
            parameter_type(&Value::BigInteger(big.into()), &Type::UNKNOWN).unwrap(),
            Type::NUMERIC
        );
        assert_eq!(
            parameter_type(&Value::Decimal(decimal.into()), &Type::UNKNOWN).unwrap(),
            Type::NUMERIC
        );
        assert_eq!(
            numeric_parameter_text(&Value::BigInteger(big.into())).unwrap(),
            big
        );
        assert!(parameter(&Value::BigInteger(big.into()), &Type::INT8).is_err());
        assert!(parameter(&Value::BigInteger("42".into()), &Type::INT8).is_ok());
        assert_eq!(
            array_parameter_text(
                &Value::Vector(vec![Value::BigInteger(big.into())]),
                &Type::NUMERIC,
                None,
            )
            .unwrap(),
            format!("{{{big}}}")
        );
        assert!(array_parameter_text(
            &Value::Vector(vec![Value::BigInteger("32768".into())]),
            &Type::INT2,
            None,
        )
        .is_err());
        assert_eq!(
            expect_i64(Some(&Value::BigInteger("42".into())), "value").unwrap(),
            42
        );
        assert!(expect_i64(
            Some(&Value::BigInteger("9223372036854775808".into())),
            "value"
        )
        .is_err());

        let encoded_big = abi_json(&Value::BigInteger(big.into())).unwrap();
        assert_eq!(encoded_big.to_string(), big);
        assert_eq!(json_abi(encoded_big), Value::BigInteger(big.into()));

        let encoded_decimal = abi_json(&Value::Decimal(decimal.into())).unwrap();
        assert_eq!(encoded_decimal.to_string(), decimal);
        assert_eq!(json_abi(encoded_decimal), Value::Decimal(decimal.into()));
    }

    #[test]
    fn json_rejects_non_json_numeric_values() {
        assert!(abi_json(&Value::Float(f64::NAN)).is_err());
        assert!(abi_json(&Value::Decimal("NaN".into())).is_err());
        assert!(abi_json(&Value::BigInteger("not-an-integer".into())).is_err());
    }

    #[test]
    fn array_text_preserves_dimensions_and_rejects_ragged_values() {
        let value = Value::Vector(vec![
            Value::Vector(vec![Value::Integer(1), Value::Nil]),
            Value::Vector(vec![Value::Integer(2), Value::Integer(3)]),
        ]);
        assert_eq!(
            array_parameter_text(&value, &Type::INT8, Some(&[(0, 2), (1, 2)])).unwrap(),
            "[0:1][1:2]={{1,NULL},{2,3}}"
        );
        let ragged = Value::Vector(vec![
            Value::Vector(vec![Value::Integer(1)]),
            Value::Vector(vec![Value::Integer(2), Value::Integer(3)]),
        ]);
        assert_eq!(
            array_parameter_text(&ragged, &Type::INT8, None)
                .unwrap_err()
                .code,
            "postgres/config-invalid"
        );
    }
}
''',
    "PostgreSQL provider tests",
)

source_path.write_text(source, encoding="utf-8")
