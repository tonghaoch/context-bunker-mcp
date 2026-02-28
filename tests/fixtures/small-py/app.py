import os
from .auth import login, register
from .utils.hash import hash_password

MAX_RETRIES = 3
_internal_cache = {}


class App:
    """Main application class."""

    def __init__(self, name: str):
        self.name = name

    def run(self) -> None:
        api_key = os.getenv("API_KEY")
        user = login("admin@test.com", "secret")
        print(f"Running {self.name}")


def main():
    app = App("my-app")
    app.run()
