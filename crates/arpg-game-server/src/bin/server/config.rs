use std::str::FromStr;

pub fn configured_number<T: FromStr>(
    name: &str,
    value: Option<&str>,
    default: T,
) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    match value {
        None => Ok(default),
        Some(value) => value
            .parse()
            .map_err(|error| format!("invalid {name}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::configured_number;

    #[test]
    fn missing_values_use_defaults() {
        assert_eq!(
            configured_number("ARPG_SERVER_PORT", None, 4433_u16),
            Ok(4433)
        );
    }

    #[test]
    fn configured_values_are_not_silently_replaced() {
        assert_eq!(
            configured_number("ARPG_SERVER_PORT", Some("9000"), 4433_u16),
            Ok(9000)
        );
        for value in ["", "not-a-port", "-1", "65536"] {
            let error = configured_number("ARPG_SERVER_PORT", Some(value), 4433_u16).unwrap_err();
            assert!(error.starts_with("invalid ARPG_SERVER_PORT:"));
        }
        assert!(configured_number("ARPG_SERVER_DRAIN_GRACE_MS", Some("-1"), 500_u64).is_err());
    }
}
