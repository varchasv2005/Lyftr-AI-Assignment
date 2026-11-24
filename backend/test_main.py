"""Focused API tests; provider calls are mocked for deterministic execution."""

import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("LLM_API_KEYS", "test-key-one,test-key-two")
os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/sara-tests.db")
os.environ.setdefault("ENABLE_FAILURE_SIMULATION", "true")

from fastapi.testclient import TestClient
import main


class FakeResponse:
    _hidden_params = {}
    usage = {"prompt_tokens": 12, "completion_tokens": 4}

    class Choice:
        class Message:
            content = "SARA test reply"
        message = Message()

    choices = [Choice()]


class ChatAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        main.DB_PATH = os.path.join(self.temp.name, "app.db")
        main.KEYS = ["test-key-one", "test-key-two"]
        main.initialize_db()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    @patch("main.litellm.completion", return_value=FakeResponse())
    def test_chat_and_history(self, completion):
        response = self.client.post("/chat", json={"session_id": "session-a", "message": "hello"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["metadata"]["input_tokens"], 12)
        history = self.client.get("/sessions/session-a/messages")
        self.assertEqual([m["role"] for m in history.json()["messages"]], ["user", "assistant"])

    @patch("main.litellm.completion", return_value=FakeResponse())
    def test_simulated_failover_uses_second_key(self, completion):
        response = self.client.post(
            "/chat", json={"session_id": "session-b", "message": "hello"},
            headers={"X-Simulate-Failure": "key_1=429"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["metadata"]["key_id"], "key_2")
        self.assertEqual(response.json()["metadata"]["fallback_attempts"], 1)

    def test_all_simulated_keys_fail_without_writing_history(self):
        response = self.client.post(
            "/chat", json={"session_id": "session-c", "message": "hello"},
            headers={"X-Simulate-Failure": "*=429"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.client.get("/sessions/session-c/messages").status_code, 404)

    def test_invalid_message_is_rejected(self):
        response = self.client.post("/chat", json={"session_id": "session-d", "message": "   "})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
