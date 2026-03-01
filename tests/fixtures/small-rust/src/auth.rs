use std::collections::HashMap;
use crate::utils::hash_password;

/// A user in the system
pub struct User {
    pub id: u64,
    pub email: String,
    pub password_hash: String,
}

/// User roles
pub enum Role {
    Admin,
    User,
    Guest,
}

/// Session trait for auth providers
pub trait AuthProvider {
    fn authenticate(&self, email: &str, password: &str) -> bool;
}

impl User {
    pub fn new(id: u64, email: String) -> Self {
        User {
            id,
            email,
            password_hash: String::new(),
        }
    }

    pub fn verify(&self, password: &str) -> bool {
        hash_password(password) == self.password_hash
    }
}

/// Login a user with email and password
pub async fn login(email: &str, password: &str) -> Option<User> {
    let hashed = hash_password(password);
    let _cache: HashMap<String, User> = HashMap::new();
    let user = User::new(1, email.to_string());
    if user.password_hash == hashed {
        Some(user)
    } else {
        None
    }
}

/// Register a new user
pub async fn register(email: &str, password: &str) -> User {
    let hashed = hash_password(password);
    let mut user = User::new(2, email.to_string());
    user.password_hash = hashed;
    user
}

/// Fetch user from API
pub async fn fetch_user(id: u64) -> Option<User> {
    let url = format!("https://api.example.com/users/{}", id);
    let _resp = reqwest::get(&url).await.ok()?;
    None
}
