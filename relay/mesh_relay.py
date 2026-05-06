#!/usr/bin/env python3
"""
mesh_relay.py — Layer 2 Tailscale TCP relay for grip-session-mesh.
Bridges local WebSocket buses across Tailscale-connected machines.
"""
import argparse
import asyncio
import json
import secrets
import struct
import sys
from pathlib import Path

LOCAL_WS_PORT = 9474
RELAY_PORT = 9475
PEERS_FILE = Path.home() / ".grip-session-mesh" / "peers.json"
TOKEN_FILE = Path.home() / ".grip-session-mesh" / "token"
BACKOFF_SEQUENCE = [1, 2, 4, 8, 16, 32, 60]


# ---------------------------------------------------------------------------
# Peer file helpers
# ---------------------------------------------------------------------------

def read_peers() -> list:
    if not PEERS_FILE.exists():
        return []
    try:
        return json.loads(PEERS_FILE.read_text()).get("peers", [])
    except (json.JSONDecodeError, KeyError):
        return []


def write_peers(peers: list) -> None:
    PEERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PEERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"peers": peers}, indent=2))
    tmp.replace(PEERS_FILE)


def read_token() -> str:
    if not TOKEN_FILE.exists():
        raise FileNotFoundError(
            f"Token not found at {TOKEN_FILE}. Run: mesh_relay.py init-token"
        )
    return TOKEN_FILE.read_text().strip()


# ---------------------------------------------------------------------------
# TCP frame helpers
# ---------------------------------------------------------------------------

async def length_prefix_send(writer: asyncio.StreamWriter, data: bytes) -> None:
    writer.write(struct.pack(">I", len(data)) + data)
    await writer.drain()


async def length_prefix_recv(reader: asyncio.StreamReader) -> bytes:
    header = await reader.readexactly(4)
    length = struct.unpack(">I", header)[0]
    return await reader.readexactly(length)


# ---------------------------------------------------------------------------
# Relay core
# ---------------------------------------------------------------------------

async def _ws_to_tcp(ws, writer: asyncio.StreamWriter) -> None:
    """Forward WebSocket messages to a TCP peer."""
    import websockets
    async for message in ws:
        data = message if isinstance(message, bytes) else message.encode()
        await length_prefix_send(writer, data)


async def _tcp_to_ws(reader: asyncio.StreamReader, ws) -> None:
    """Forward TCP frames to the local WebSocket bus."""
    while True:
        data = await length_prefix_recv(reader)
        try:
            await ws.send(data.decode())
        except Exception as exc:
            print(f"[relay] ws send error: {exc}", file=sys.stderr)


async def relay_to_peer(peer_ip: str, token: str) -> None:
    """Maintain a persistent relay connection to one peer with exponential backoff."""
    import websockets

    local_ws_url = f"ws://127.0.0.1:{LOCAL_WS_PORT}"
    tcp_target = (peer_ip, RELAY_PORT)
    backoff_iter = iter(BACKOFF_SEQUENCE)
    delay = next(backoff_iter)

    while True:
        try:
            async with websockets.connect(
                local_ws_url,
                additional_headers={"Authorization": f"Bearer {token}"},
            ) as ws:
                reader, writer = await asyncio.open_connection(*tcp_target)
                print(f"[relay] connected to peer {peer_ip}", file=sys.stderr)
                delay = BACKOFF_SEQUENCE[0]  # reset on success
                backoff_iter = iter(BACKOFF_SEQUENCE)
                try:
                    await asyncio.gather(
                        _ws_to_tcp(ws, writer),
                        _tcp_to_ws(reader, ws),
                    )
                finally:
                    writer.close()
        except ConnectionRefusedError:
            print(f"[relay] peer {peer_ip} refused — retry in {delay}s", file=sys.stderr)
        except Exception as exc:
            print(f"[relay] peer {peer_ip} error: {exc} — retry in {delay}s", file=sys.stderr)

        await asyncio.sleep(delay)
        delay = next(backoff_iter, 60)


async def serve_incoming(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    local_ws_url: str,
    token: str,
) -> None:
    """Handle one incoming peer relay TCP connection."""
    import websockets

    peer = writer.get_extra_info("peername")
    print(f"[relay] incoming from {peer}", file=sys.stderr)
    try:
        async with websockets.connect(
            local_ws_url,
            additional_headers={"Authorization": f"Bearer {token}"},
        ) as ws:
            await asyncio.gather(
                _tcp_to_ws(reader, ws),
                _ws_to_tcp(ws, writer),
            )
    except Exception as exc:
        print(f"[relay] incoming {peer} closed: {exc}", file=sys.stderr)
    finally:
        writer.close()


# ---------------------------------------------------------------------------
# Subcommand handlers
# ---------------------------------------------------------------------------

async def cmd_connect() -> None:
    token = read_token()
    peers = read_peers()
    local_ws_url = f"ws://127.0.0.1:{LOCAL_WS_PORT}"

    server = await asyncio.start_server(
        lambda r, w: serve_incoming(r, w, local_ws_url, token),
        "0.0.0.0",
        RELAY_PORT,
    )
    print(f"[relay] serving on :{RELAY_PORT}", file=sys.stderr)

    tasks = [asyncio.create_task(relay_to_peer(ip, token)) for ip in peers]
    async with server:
        await asyncio.gather(server.serve_forever(), *tasks)


def cmd_remote_add(ip: str) -> None:
    peers = read_peers()
    if ip not in peers:
        peers.append(ip)
        write_peers(peers)
        print(f"Added {ip}. peers: {peers}")
    else:
        print(f"{ip} already present.")


def cmd_remote_remove(ip: str) -> None:
    peers = read_peers()
    if ip in peers:
        peers.remove(ip)
        write_peers(peers)
        print(f"Removed {ip}. peers: {peers}")
    else:
        print(f"{ip} not found.")


def cmd_remote_list() -> None:
    peers = read_peers()
    print("\n".join(peers) if peers else "(no peers configured)")


def cmd_status() -> None:
    peers = read_peers()
    token_ok = TOKEN_FILE.exists()
    print(f"Token file: {'OK' if token_ok else 'MISSING'}")
    print(f"Peers ({len(peers)}): {peers}")


def cmd_init_token() -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    TOKEN_FILE.write_text(token)
    TOKEN_FILE.chmod(0o600)
    print(f"Token written to {TOKEN_FILE}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="mesh_relay — Layer 2 Tailscale TCP relay")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("connect", help="Start relay daemon")
    sub.add_parser("status", help="Show relay status")
    sub.add_parser("init-token", help="Generate bearer token")

    remote = sub.add_parser("remote", help="Manage peer IPs")
    rsub = remote.add_subparsers(dest="remote_cmd", required=True)
    add_p = rsub.add_parser("add")
    add_p.add_argument("ip")
    rem_p = rsub.add_parser("remove")
    rem_p.add_argument("ip")
    rsub.add_parser("list")

    return p


def main() -> None:
    args = build_parser().parse_args()

    if args.cmd == "connect":
        asyncio.run(cmd_connect())
    elif args.cmd == "status":
        cmd_status()
    elif args.cmd == "init-token":
        cmd_init_token()
    elif args.cmd == "remote":
        if args.remote_cmd == "add":
            cmd_remote_add(args.ip)
        elif args.remote_cmd == "remove":
            cmd_remote_remove(args.ip)
        elif args.remote_cmd == "list":
            cmd_remote_list()


if __name__ == "__main__":
    main()
