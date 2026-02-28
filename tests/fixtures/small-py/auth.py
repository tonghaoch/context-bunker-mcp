from typing import Optional
from .utils.hash import hash_password, verify_password


class User:
    """Represents a user in the system."""

    def __init__(self, id: int, email: str, name: str):
        self.id = id
        self.email = email
        self.name = name


def login(email: str, password: str) -> Optional[User]:
    """Authenticate a user by email and password."""
    hashed = hash_password(password)
    # TODO: implement real DB lookup
    return User(1, email, "Test")


async def register(email: str, password: str) -> User:
    """Register a new user."""
    hashed = hash_password(password)
    return User(2, email, "New User")


def _validate_email(email: str) -> bool:
    return "@" in email
