import hashlib


SECRET_SALT = "context-bunker"


def hash_password(password: str) -> str:
    """Hash a password with the secret salt."""
    return hashlib.sha256((password + SECRET_SALT).encode()).hexdigest()


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    return hash_password(password) == hashed
