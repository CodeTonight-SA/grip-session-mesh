"""
Tests for mesh_relay.py — Layer 2 Tailscale TCP relay.
"""
import asyncio
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Allow importing relay module from parent directory
sys.path.insert(0, str(Path(__file__).parent.parent))
import mesh_relay


class TestReadPeers(unittest.TestCase):
    def test_read_peers_empty(self):
        """Missing peers.json returns an empty list."""
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "no-such-file.json"
            with patch.object(mesh_relay, "PEERS_FILE", missing):
                result = mesh_relay.read_peers()
        self.assertEqual(result, [])

    def test_read_peers_malformed_json(self):
        """Malformed JSON returns an empty list without raising."""
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "peers.json"
            bad.write_text("{not valid json")
            with patch.object(mesh_relay, "PEERS_FILE", bad):
                result = mesh_relay.read_peers()
        self.assertEqual(result, [])


class TestWriteReadPeers(unittest.TestCase):
    def test_write_read_peers_roundtrip(self):
        """Writing then reading peers produces the same list."""
        ips = ["100.1.2.3", "100.4.5.6"]
        with tempfile.TemporaryDirectory() as tmp:
            pf = Path(tmp) / "peers.json"
            with patch.object(mesh_relay, "PEERS_FILE", pf):
                mesh_relay.write_peers(ips)
                result = mesh_relay.read_peers()
        self.assertEqual(result, ips)


class TestLengthPrefixRoundtrip(unittest.TestCase):
    def test_length_prefix_roundtrip(self):
        """Encoding and decoding a frame produces the original bytes."""
        payload = b'{"type": "hello", "session": "abc123"}'

        # Build a raw byte stream the same way length_prefix_send would
        raw = struct.pack(">I", len(payload)) + payload

        async def _run():
            reader = asyncio.StreamReader()
            reader.feed_data(raw)
            received = await mesh_relay.length_prefix_recv(reader)
            return received

        result = asyncio.run(_run())
        self.assertEqual(result, payload)


class TestBackoffSequence(unittest.TestCase):
    def test_backoff_sequence_values(self):
        """BACKOFF_SEQUENCE has the correct values and ends at 60."""
        expected = [1, 2, 4, 8, 16, 32, 60]
        self.assertEqual(mesh_relay.BACKOFF_SEQUENCE, expected)

    def test_backoff_sequence_max(self):
        """Last element in BACKOFF_SEQUENCE is 60."""
        self.assertEqual(mesh_relay.BACKOFF_SEQUENCE[-1], 60)


class TestInitToken(unittest.TestCase):
    def test_init_token_creates_file_with_correct_permissions(self):
        """init-token writes a token file with 0o600 permissions."""
        with tempfile.TemporaryDirectory() as tmp:
            tf = Path(tmp) / "token"
            with patch.object(mesh_relay, "TOKEN_FILE", tf):
                mesh_relay.cmd_init_token()
            self.assertTrue(tf.exists())
            mode = oct(tf.stat().st_mode & 0o777)
            self.assertEqual(mode, oct(0o600))
            # Token should be a non-empty hex string
            content = tf.read_text().strip()
            self.assertTrue(len(content) == 64)
            self.assertTrue(all(c in "0123456789abcdef" for c in content))


class TestRemoteAddRemove(unittest.TestCase):
    def test_remote_add_then_remove(self):
        """add puts IP in list; remove takes it out."""
        ip = "100.83.206.33"
        with tempfile.TemporaryDirectory() as tmp:
            pf = Path(tmp) / "peers.json"
            with patch.object(mesh_relay, "PEERS_FILE", pf):
                # Add
                mesh_relay.cmd_remote_add(ip)
                peers_after_add = mesh_relay.read_peers()
                self.assertIn(ip, peers_after_add)

                # Remove
                mesh_relay.cmd_remote_remove(ip)
                peers_after_remove = mesh_relay.read_peers()
                self.assertNotIn(ip, peers_after_remove)

    def test_remote_add_idempotent(self):
        """Adding the same IP twice results in only one entry."""
        ip = "100.104.253.41"
        with tempfile.TemporaryDirectory() as tmp:
            pf = Path(tmp) / "peers.json"
            with patch.object(mesh_relay, "PEERS_FILE", pf):
                mesh_relay.cmd_remote_add(ip)
                mesh_relay.cmd_remote_add(ip)
                peers = mesh_relay.read_peers()
        self.assertEqual(peers.count(ip), 1)


if __name__ == "__main__":
    unittest.main()
