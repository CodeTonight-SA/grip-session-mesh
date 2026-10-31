"""
Tests for the relay's incoming-peer allowlist (serve_incoming must refuse strangers).
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Allow importing relay module from parent directory
sys.path.insert(0, str(Path(__file__).parent.parent))
import mesh_relay

PEER = "100.64.0.10"
STRANGER = "192.168.1.50"


class TestIncomingPeerAllowlist(unittest.TestCase):
    PEERS = [PEER, "100.64.0.11"]

    def test_listed_peer_is_allowed(self):
        self.assertTrue(mesh_relay.is_allowed_peer(PEER, self.PEERS))

    def test_loopback_is_allowed(self):
        self.assertTrue(mesh_relay.is_allowed_peer("127.0.0.1", self.PEERS))
        self.assertTrue(mesh_relay.is_allowed_peer("::1", self.PEERS))

    def test_lan_address_is_refused(self):
        self.assertFalse(mesh_relay.is_allowed_peer(STRANGER, self.PEERS))

    def test_unlisted_tailnet_address_is_refused(self):
        self.assertFalse(mesh_relay.is_allowed_peer("100.64.0.99", self.PEERS))

    def test_ipv4_mapped_ipv6_is_unwrapped(self):
        host = mesh_relay.peer_host((f"::ffff:{PEER}", 40000, 0, 0))
        self.assertEqual(host, PEER)
        self.assertTrue(mesh_relay.is_allowed_peer(host, self.PEERS))

    def test_missing_peername_is_refused(self):
        self.assertFalse(mesh_relay.is_allowed_peer(mesh_relay.peer_host(None), self.PEERS))

    def test_other_address_forms_are_canonicalised(self):
        self.assertEqual(mesh_relay.peer_host((f"::FFFF:{PEER}", 1, 0, 0)), PEER)
        self.assertEqual(mesh_relay.peer_host((f"0:0:0:0:0:ffff:{PEER}", 1, 0, 0)), PEER)
        self.assertTrue(mesh_relay.is_allowed_peer(PEER, [f" {PEER} "]))
        self.assertTrue(mesh_relay.is_allowed_peer("fd7a:115c:a1e0::5", ["fd7a:115c:a1e0:0:0:0:0:5"]))

    def test_empty_and_hostname_entries_match_nothing(self):
        self.assertFalse(mesh_relay.is_allowed_peer("", [""]))
        self.assertFalse(mesh_relay.is_allowed_peer(mesh_relay.peer_host(None), ["", "my-laptop.local"]))
        self.assertFalse(mesh_relay.is_allowed_peer("my-laptop.local", ["my-laptop.local"]))


class TestServeIncomingGate(unittest.TestCase):
    """serve_incoming must refuse a stranger BEFORE it logs into the bus."""

    def _run(self, peername, peers):
        writer = MagicMock()
        writer.get_extra_info.return_value = peername
        fake_websockets = MagicMock()
        # A connect that fails ends the session right after the attempt.
        fake_websockets.connect.side_effect = ConnectionRefusedError("bus down")
        with patch.object(mesh_relay, "read_peers", return_value=peers), \
                patch.dict(sys.modules, {"websockets": fake_websockets}):
            asyncio.run(mesh_relay.serve_incoming(
                MagicMock(), writer, "ws://127.0.0.1:9474", "fake-token"))
        return writer, fake_websockets

    def test_stranger_never_reaches_the_bus(self):
        writer, ws = self._run((STRANGER, 52766), [PEER])
        ws.connect.assert_not_called()
        writer.close.assert_called_once()

    def test_listed_peer_is_joined_to_the_bus(self):
        writer, ws = self._run((PEER, 40000), [PEER])
        ws.connect.assert_called_once_with("ws://127.0.0.1:9474")
        writer.close.assert_called_once()

    def test_mapped_listed_peer_is_joined(self):
        _, ws = self._run((f"::ffff:{PEER}", 40000, 0, 0), [PEER])
        ws.connect.assert_called_once_with("ws://127.0.0.1:9474")

    def test_mapped_stranger_is_refused(self):
        _, ws = self._run((f"::ffff:{STRANGER}", 40000, 0, 0), [PEER])
        ws.connect.assert_not_called()

    def test_missing_peername_with_a_blank_entry_is_refused(self):
        writer, ws = self._run(None, ["", PEER])
        ws.connect.assert_not_called()
        writer.close.assert_called_once()

    def test_loopback_is_joined(self):
        _, ws = self._run(("127.0.0.1", 40000), [])
        ws.connect.assert_called_once_with("ws://127.0.0.1:9474")


class TestReadPeersNeverRaises(unittest.TestCase):
    """serve_incoming reads peers.json on every connection, so a bad file must
    give an empty list (which refuses everyone but loopback), never an exception."""

    def _read(self, text=None, error=None):
        fake = MagicMock()
        fake.exists.return_value = True
        fake.read_text.return_value = text
        fake.read_text.side_effect = error
        with patch.object(mesh_relay, "PEERS_FILE", fake):
            return mesh_relay.read_peers()

    def test_json_that_is_not_an_object(self):
        self.assertEqual(self._read(f'["{PEER}"]'), [])

    def test_null_peers(self):
        self.assertEqual(self._read('{"peers": null}'), [])

    def test_string_peers(self):
        self.assertEqual(self._read(f'{{"peers": "{PEER}"}}'), [])

    def test_unreadable_file(self):
        self.assertEqual(self._read(error=PermissionError("denied")), [])

    def test_valid_file(self):
        self.assertEqual(self._read(f'{{"peers": ["{PEER}"]}}'), [PEER])


if __name__ == "__main__":
    unittest.main()
