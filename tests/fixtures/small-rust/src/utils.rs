use std::env;

/// Hash a password using a simple algorithm
pub fn hash_password(password: &str) -> String {
    let salt = env::var("SALT").unwrap_or_else(|_| "default".to_string());
    format!("{}:{}", salt, password)
}

/// Verify a password against a hash
pub fn verify_password(password: &str, hash: &str) -> bool {
    hash_password(password) == hash
}

fn internal_helper() -> String {
    "internal".to_string()
}

pub const MAX_ATTEMPTS: u32 = 5;

pub static APP_NAME: &str = "small-rust";
